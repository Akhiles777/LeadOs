"use server";

import { revalidatePath } from "next/cache";
import { isAiConfigured } from "@/ai/client";
import { BRAND_CATEGORIES } from "@/ai/context";
import { enqueue, retryFailedJobs } from "@/ai/jobs";
import { assessLead } from "@/ai/tasks/assess";
import { applyRuleChange, suggestTuning } from "@/ai/tasks/tuning";
import { type DraftChannel, generateDraft, isDraftChannel } from "@/ai/tasks/drafts";
import { findContacts } from "@/ai/tasks/find-contacts";
import { generatePitch } from "@/ai/tasks/pitch";
import { checkLeadWebsite } from "@/lib/site-check-service";
import type { FormState } from "@/lib/actions";
import { changeStatus } from "@/lib/actions";
import { aiErrorMessage } from "@/lib/ai-errors";
import { db } from "@/lib/db";

export type AiActionResult = { ok: true } | { error: string };

function aiError(e: unknown): { error: string } {
  return { error: aiErrorMessage(e) };
}

function revalidateLead(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/prospecting");
  revalidatePath("/");
}

export async function assessLeadNow(leadId: string): Promise<AiActionResult> {
  try {
    await assessLead(leadId);
    revalidateLead(leadId);
    return { ok: true };
  } catch (e) {
    return aiError(e);
  }
}

export async function generateDraftNow(leadId: string, channel: DraftChannel): Promise<AiActionResult> {
  if (!isDraftChannel(channel)) return { error: "Неизвестный тип черновика" };
  try {
    await generateDraft(leadId, channel);
    revalidateLead(leadId);
    return { ok: true };
  } catch (e) {
    return aiError(e);
  }
}

/** Подобрать решение и написать скрипт звонка, WhatsApp и письмо — одним вызовом. */
export async function generatePitchNow(leadId: string): Promise<AiActionResult> {
  try {
    await generatePitch(leadId);
    revalidateLead(leadId);
    return { ok: true };
  } catch (e) {
    return aiError(e);
  }
}

export type ContactsActionResult = { ok: true; added: number; website: string | null } | { error: string };

/** Поиск контактов в интернете по кнопке. Нашёлся сайт — сразу проверяем и его (там часто WhatsApp). */
export async function findContactsNow(leadId: string): Promise<ContactsActionResult> {
  try {
    const found = await findContacts(leadId);
    if (found.website) await checkLeadWebsite(leadId).catch(() => null);
    revalidateLead(leadId);
    return { ok: true, ...found };
  } catch (e) {
    return aiError(e);
  }
}

export async function updateDraftText(draftId: string, text: string) {
  const draft = await db.offerDraft.update({ where: { id: draftId }, data: { text: text.slice(0, 20_000) }, select: { leadId: true } });
  revalidateLead(draft.leadId);
}

export async function deleteDraft(draftId: string) {
  const draft = await db.offerDraft.delete({ where: { id: draftId }, select: { leadId: true } });
  revalidateLead(draft.leadId);
}

/** «Отправлено»: сохраняет финальный текст, пишет в историю, новый лид переходит в «Контакт». */
export async function markDraftSent(draftId: string, finalText: string) {
  const now = new Date();
  const draft = await db.offerDraft.update({
    where: { id: draftId },
    data: { text: finalText.slice(0, 20_000), approved: true, sentAt: now },
    include: { lead: { select: { id: true, status: true } } },
  });
  await db.$transaction([
    db.activity.create({ data: { leadId: draft.leadId, type: "MESSAGE_SENT", note: draft.text.slice(0, 4000) } }),
    db.lead.update({ where: { id: draft.leadId }, data: { lastActivityAt: now } }),
  ]);
  if (draft.lead.status === "NEW" || draft.lead.status === "QUALIFIED") await changeStatus(draft.leadId, "CONTACTED");
  // Отправленная просьба о рекомендации или предложение доработок закрывает напоминание на дашборде.
  if (draft.channel === "referral_request") await db.deal.updateMany({ where: { leadId: draft.leadId, referralAskedAt: null }, data: { referralAskedAt: now } });
  if (draft.channel === "upsell") await db.deal.updateMany({ where: { leadId: draft.leadId, upsellAt: null }, data: { upsellAt: now } });
  revalidateLead(draft.leadId);
}

export async function saveBrandRules(_prev: FormState, formData: FormData): Promise<FormState> {
  const rows = BRAND_CATEGORIES.map(({ key }) => ({ category: key, content: String(formData.get(key) ?? "").trim().slice(0, 10_000) })).filter((r) => r.content);
  await db.$transaction([db.personalBrandRule.deleteMany(), db.personalBrandRule.createMany({ data: rows })]);
  revalidatePath("/ai");
  return { ok: true };
}

export async function savePortfolioCase(_prev: FormState, formData: FormData): Promise<FormState> {
  const get = (k: string) => String(formData.get(k) ?? "").trim();
  const data = {
    title: get("title").slice(0, 200),
    niches: get("niches").slice(0, 500),
    summary: get("summary").slice(0, 5000),
    stack: get("stack").slice(0, 300) || null,
    url: get("url").slice(0, 500) || null,
  };
  if (!data.title || !data.niches || !data.summary) return { error: "Нужны название, ниши и описание" };
  const id = get("id");
  if (id) await db.portfolioCase.update({ where: { id }, data });
  else await db.portfolioCase.create({ data });
  revalidatePath("/ai");
  return { ok: true };
}

export async function setCaseActive(id: string, active: boolean) {
  await db.portfolioCase.update({ where: { id }, data: { active } });
  revalidatePath("/ai");
}

export async function deletePortfolioCase(id: string) {
  await db.portfolioCase.delete({ where: { id } });
  revalidatePath("/ai");
}

export async function retryFailed() {
  await retryFailedJobs();
  revalidatePath("/ai");
}

export async function requestDigest() {
  if (!isAiConfigured()) return;
  await enqueue("DIGEST");
  revalidatePath("/ai");
  revalidatePath("/digest");
}

export async function scoreUnscoredLeads() {
  if (!isAiConfigured()) return 0;
  const leads = await db.lead.findMany({
    where: { scoredAt: null, status: { in: ["NEW", "QUALIFIED"] } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  for (const l of leads) await enqueue("SCORE_LEAD", l.id);
  revalidatePath("/ai");
  return leads.length;
}

export async function submitAssessmentFeedback(leadId: string, correctVerdict: "TAKE" | "CONSIDER" | "SKIP", note: string): Promise<AiActionResult> {
  if (!["TAKE", "CONSIDER", "SKIP"].includes(correctVerdict)) return { error: "Выбери правильный вердикт" };
  if (note.trim().length < 5) return { error: "Коротко напиши, почему — AI учится именно на объяснении" };
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { score: true, aiVerdict: true } });
  await db.assessmentFeedback.create({
    data: { leadId, aiScore: lead.score, aiVerdict: lead.aiVerdict, correctVerdict, note: note.trim().slice(0, 2000) },
  });
  revalidateLead(leadId);
  revalidatePath("/ai");
  return { ok: true };
}

export async function deleteAssessmentFeedback(id: string) {
  const f = await db.assessmentFeedback.delete({ where: { id }, select: { leadId: true } });
  revalidateLead(f.leadId);
  revalidatePath("/ai");
}

export async function runTuning(): Promise<AiActionResult> {
  try {
    await suggestTuning();
    revalidatePath("/ai");
    return { ok: true };
  } catch (e) {
    return aiError(e);
  }
}

export async function applyTuningRule(index: number) {
  await applyRuleChange(index);
  revalidatePath("/ai");
}

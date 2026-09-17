"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { runSiteCheck } from "@/lib/cold-actions";
import { formToObject, normalizePhone, parseLeadInput } from "@/lib/lead-input";
import { type Opportunity, opportunity, type SiteCheck } from "@/lib/site-check";
import { createLeadDeduped, enrichCompany, findCompanyToEnrich, findDuplicate, updateLeadChecked } from "@/lib/lead-service";
import { normalizeSourceRef } from "@/lib/source-ref";
import { FUNNEL_STAGES, isSource, MANUAL_ACTIVITY_TYPES, STATUS_LABEL, STATUS_ORDER } from "@/lib/leads";
import type { LeadStatus } from "@/generated/prisma/enums";

type LeadRef = { id: string; title: string };

export type FormState = { error?: string; ok?: boolean; duplicate?: LeadRef } | undefined;

export type CaptureState =
  | { error?: string; lead?: LeadRef & { status: LeadStatus }; created?: boolean; enriched?: boolean; opportunity?: Opportunity }
  | undefined;

function stageIndex(status: LeadStatus): number {
  return FUNNEL_STAGES.indexOf(status);
}

function revalidateLead(id?: string) {
  for (const path of ["/", "/leads", "/pipeline", "/digest", "/prospecting", "/analytics"]) revalidatePath(path);
  if (id) revalidatePath(`/leads/${id}`);
}

const DUPLICATE_ERROR = "Лид с такой ссылкой из этого источника уже есть";

export async function createLead(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseLeadInput(formToObject(formData));
  if ("error" in parsed) return { error: parsed.error };

  const result = await createLeadDeduped(parsed.data);
  if (!result.created) {
    const dup = await db.lead.findUnique({ where: { id: result.id }, select: { id: true, title: true } });
    return { error: DUPLICATE_ERROR, duplicate: dup ?? undefined };
  }
  revalidateLead();
  redirect(`/leads/${result.id}`);
}

/** Проверка «уже в LeadOS?» для окна захвата: по ссылке в источнике, а для компаний с карт — ещё и по телефону. */
export async function lookupLead(source: string, sourceRef: string, phone?: string | null) {
  if (!isSource(source)) return null;
  const select = { id: true, title: true, status: true } as const;
  const dup = await findDuplicate(source, normalizeSourceRef(source, sourceRef));
  if (dup) return { ...(await db.lead.findUniqueOrThrow({ where: { id: dup.id }, select })), matchedBy: "link" as const };

  const normalized = phone ? normalizePhone(phone) : null;
  if (normalized?.startsWith("+7 ")) {
    const byPhone = await db.lead.findFirst({ where: { contactPhone: normalized }, select });
    if (byPhone) return { ...byPhone, matchedBy: "phone" as const };
  }
  return null;
}

/** Сохранение из окна захвата: без редиректа, окно остаётся открытым и показывает результат. */
export async function captureLead(_prev: CaptureState, formData: FormData): Promise<CaptureState> {
  const parsed = parseLeadInput(formToObject(formData));
  if ("error" in parsed) return { error: parsed.error };

  // Компанию могли найти автоматически без телефона — дополняем её, а не заводим дубль.
  const toEnrich = await findCompanyToEnrich(parsed.data);
  if (toEnrich) {
    await enrichCompany(toEnrich, parsed.data);
    if (parsed.data.website) await runSiteCheck(toEnrich);
    const enriched = await db.lead.findUniqueOrThrow({ where: { id: toEnrich }, select: { id: true, title: true, status: true, category: true, siteCheck: true } });
    revalidateLead(toEnrich);
    const { siteCheck: check, category: cat, ...ref } = enriched;
    return { lead: ref, created: false, enriched: true, opportunity: check ? opportunity(check as unknown as SiteCheck, cat) : undefined };
  }

  const result = await createLeadDeduped(parsed.data);
  if (result.created && (parsed.data.source === "COLD_LOCAL" || parsed.data.website)) {
    // Для компаний с карт и лидов с сайтом сразу проверяем сайт: окно захвата покажет, насколько это наш клиент.
    await runSiteCheck(result.id);
  }
  const lead = await db.lead.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, title: true, status: true, category: true, siteCheck: true } });
  if (result.created) revalidateLead();
  const { siteCheck, category, ...ref } = lead;
  return { lead: ref, created: result.created, opportunity: siteCheck ? opportunity(siteCheck as unknown as SiteCheck, category) : undefined };
}

export async function updateLead(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseLeadInput(formToObject(formData));
  if ("error" in parsed) return { error: parsed.error };

  const result = await updateLeadChecked(id, parsed.data);
  if ("duplicate" in result) return { error: DUPLICATE_ERROR, duplicate: result.duplicate };
  revalidateLead(id);
  return { ok: true };
}

export async function changeStatus(id: string, status: LeadStatus, note?: string) {
  if (!STATUS_ORDER.includes(status)) throw new Error("Неизвестный статус");

  await db.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id }, select: { status: true, furthestStage: true } });
    if (lead.status === status) return;

    const now = new Date();
    await tx.lead.update({
      where: { id },
      data: {
        status,
        furthestStage: Math.max(lead.furthestStage, stageIndex(status)),
        lastActivityAt: now,
      },
    });

    const text = `${STATUS_LABEL[lead.status]} → ${STATUS_LABEL[status]}`;
    await tx.activity.create({
      data: { leadId: id, type: "STATUS_CHANGE", note: note?.trim() ? `${text}. ${note.trim()}` : text },
    });

    if (status === "WON") {
      await tx.deal.upsert({
        where: { leadId: id },
        create: { leadId: id, startedAt: now, closedAt: now },
        update: { closedAt: now },
      });
    } else if (lead.status === "WON") {
      // Сделку «переоткрыли» — дата закрытия больше не актуальна.
      await tx.deal.updateMany({ where: { leadId: id }, data: { closedAt: null } });
    }
  });

  revalidateLead(id);
}

/** Массовая смена статуса (разбор потока лидов). Каждая смена пишется в историю, как одиночная. */
export async function bulkChangeStatus(ids: string[], status: LeadStatus): Promise<number> {
  if (!STATUS_ORDER.includes(status)) throw new Error("Неизвестный статус");
  const unique = [...new Set(ids)].slice(0, 500);
  let changed = 0;
  for (const id of unique) {
    try {
      await changeStatus(id, status);
      changed++;
    } catch {
      // лид могли удалить в соседней вкладке — пропускаем
    }
  }
  return changed;
}

export async function changeStatusForm(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as LeadStatus;
  const note = formData.get("note");
  await changeStatus(id, status, typeof note === "string" ? note : undefined);
}

const activitySchema = z.object({
  type: z.enum(MANUAL_ACTIVITY_TYPES as [string, ...string[]]),
  note: z.string().trim().min(1, "Пустая заметка"),
});

export async function addActivity(leadId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = activitySchema.safeParse(formToObject(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await db.$transaction([
    db.activity.create({
      data: { leadId, type: parsed.data.type as (typeof MANUAL_ACTIVITY_TYPES)[number], note: parsed.data.note },
    }),
    db.lead.update({ where: { id: leadId }, data: { lastActivityAt: new Date() } }),
  ]);
  revalidateLead(leadId);
  return { ok: true };
}

export async function deleteLead(id: string) {
  await db.lead.delete({ where: { id } });
  revalidateLead();
  redirect("/leads");
}

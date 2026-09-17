"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import type { FormState } from "@/lib/actions";
import { db } from "@/lib/db";
import { FUNNEL_STAGES, STATUS_LABEL } from "@/lib/leads";
import { saveProspectingSettings } from "@/lib/settings";
import { checkWebsite } from "@/lib/site-check";
import type { LeadStatus } from "@/generated/prisma/enums";

function revalidateCold(leadId?: string) {
  revalidatePath("/prospecting");
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/");
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

export async function saveProspecting(_prev: FormState, formData: FormData): Promise<FormState> {
  const region = String(formData.get("region") ?? "").trim().slice(0, 100);
  const niches = [
    ...new Set(
      String(formData.get("niches") ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 80),
    ),
  ].slice(0, 100);
  if (!niches.length) return { error: "Добавь хотя бы одну нишу" };
  await saveProspectingSettings({ region, niches });
  revalidatePath("/prospecting");
  return { ok: true };
}

/** Проверяет сайт лида и сохраняет результат. Вызывается кнопкой в карточке и после захвата с карт. */
export async function runSiteCheck(leadId: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { website: true } });
  const result = await checkWebsite(lead.website);
  await db.lead.update({ where: { id: leadId }, data: { siteCheck: result as unknown as Prisma.InputJsonObject } });
  revalidateCold(leadId);
  return result;
}

export type CallOutcome = "no_answer" | "callback" | "interested" | "not_interested";

const OUTCOMES: Record<CallOutcome, { note: string; status?: LeadStatus; followUpDays?: number }> = {
  no_answer: { note: "Не дозвонился", followUpDays: 1 },
  callback: { note: "Попросили перезвонить", status: "CONTACTED", followUpDays: 2 },
  interested: { note: "Интересно — обсуждаем", status: "RESPONDED" },
  not_interested: { note: "Не интересно", status: "LOST" },
};

/** Результат звонка одной кнопкой: запись в историю, статус, дата следующего касания. */
export async function logCall(leadId: string, outcome: CallOutcome, comment?: string) {
  const config = OUTCOMES[outcome];
  if (!config) throw new Error("Неизвестный результат звонка");
  const now = new Date();
  const note = comment?.trim() ? `${config.note}. ${comment.trim().slice(0, 2000)}` : config.note;

  await db.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true, furthestStage: true } });
    const followUpAt = config.followUpDays ? new Date(now.getTime() + config.followUpDays * 86_400_000) : null;
    const statusChanges = config.status && config.status !== lead.status;

    await tx.activity.create({ data: { leadId, type: "CALL", note } });
    if (statusChanges) {
      await tx.activity.create({ data: { leadId, type: "STATUS_CHANGE", note: `${STATUS_LABEL[lead.status]} → ${STATUS_LABEL[config.status!]}` } });
    }
    await tx.lead.update({
      where: { id: leadId },
      data: {
        lastActivityAt: now,
        followUpAt,
        ...(statusChanges && {
          status: config.status,
          furthestStage: Math.max(lead.furthestStage, FUNNEL_STAGES.indexOf(config.status!)),
        }),
      },
    });
  });
  revalidateCold(leadId);
}

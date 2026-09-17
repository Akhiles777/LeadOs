import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { dayKey } from "@/lib/time";
import { formatBudget, SOURCE_LABEL } from "@/lib/leads";
import { generateStructured } from "@/ai/client";
import { loadBrandContext } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";

export const digestSchema = z.object({
  headline: z.string().describe("Одна фраза: что главное за сутки"),
  top: z.array(z.object({ leadId: z.string(), why: z.string().describe("Почему стоит заняться сегодня, одно предложение") })).describe("До 5 лучших лидов"),
  skipNote: z.string().describe("Что можно не читать и почему, одним-двумя предложениями; пусто, если нечего"),
});
export type DigestSummary = z.infer<typeof digestSchema>;

/** Дата YYYY-MM-DD в поясе приложения. */
export const moscowDay = (date = new Date()) => dayKey(date);

const MAX_LEADS_FOR_AI = 40;

/** Сводка новых лидов за 24 часа (все источники, в первую очередь Telegram), отсортированная по оценке. */
export async function buildDigest(now = new Date()) {
  const day = moscowDay(now);
  const periodStart = new Date(now.getTime() - 24 * 3_600_000);

  const leads = await db.lead.findMany({
    where: { createdAt: { gte: periodStart, lte: now }, source: { not: "MANUAL" } },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, title: true, source: true, score: true, aiVerdict: true, scoreReason: true, budgetMin: true, budgetMax: true, redFlags: true },
  });

  let summary: DigestSummary | null = null;
  if (leads.length) {
    const brand = await loadBrandContext();
    const list = leads
      .slice(0, MAX_LEADS_FOR_AI)
      .map(
        (l) =>
          `- id=${l.id} · ${SOURCE_LABEL[l.source]} · оценка ${l.score ?? "нет"}${l.aiVerdict ? ` (${l.aiVerdict})` : ""} · бюджет ${formatBudget(l.budgetMin, l.budgetMax)}\n  ${l.title}${l.scoreReason ? `\n  ${l.scoreReason}` : ""}${l.redFlags.length ? `\n  Флаги: ${l.redFlags.map((f) => f.split(" — ")[0]).join(", ")}` : ""}`,
      )
      .join("\n");
    const result = await generateStructured({
      purpose: "digest",
      system: systemPrompt(brand),
      prompt: `<leads>\n${list}\n</leads>\n\nСделай утренний дайджест новых лидов за сутки. Выбери до 5, которыми стоит заняться сегодня, и объясни выбор. Используй только id из списка.`,
      schema: digestSchema,
      effort: "medium",
    });
    const known = new Set(leads.map((l) => l.id));
    summary = { ...result, top: result.top.filter((t) => known.has(t.leadId)).slice(0, 5) };
  }

  return db.digest.upsert({
    where: { day },
    create: { day, periodStart, periodEnd: now, leadIds: leads.map((l) => l.id), summary: summary as unknown as Prisma.InputJsonObject },
    update: { periodStart, periodEnd: now, leadIds: leads.map((l) => l.id), summary: (summary ?? undefined) as unknown as Prisma.InputJsonObject },
  });
}

import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { draftEdits, editRatio, scoreCalibration, verdictAgreement } from "@/lib/report";
import { loadReportLeads } from "@/lib/report-data";
import { generateStructured } from "@/ai/client";
import { BRAND_CATEGORIES, loadBrandContext } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";

const CATEGORY_KEYS = BRAND_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export const tuningSchema = z.object({
  observations: z.array(z.string()).describe("3–6 наблюдений по данным: где оценка или черновики расходятся с решениями фрилансера"),
  ruleChanges: z
    .array(
      z.object({
        category: z.enum(CATEGORY_KEYS),
        newText: z.string().describe("Полный новый текст правил этой категории — заменит текущий"),
        why: z.string().describe("Какие данные к этому привели"),
      }),
    )
    .describe("Только изменения, подкреплённые данными; пусто, если менять нечего"),
  caseGaps: z.array(z.string()).describe("Каких кейсов не хватает, судя по лидам и правкам; пусто, если всё есть"),
});
export type TuningResult = z.infer<typeof tuningSchema>;
export type StoredTuning = { createdAt: string; result: TuningResult; applied: number[] };

export const TUNING_KEY = "ai_tuning";

/**
 * Предложения по донастройке: смотрит на поправки к оценкам, на то, как ты переписываешь черновики, и на статистику,
 * и предлагает конкретные правки правил. Сам ничего не меняет — применяешь кнопкой на странице AI.
 */
export async function suggestTuning(): Promise<StoredTuning> {
  const [brand, rules, feedback, { leads }] = await Promise.all([
    loadBrandContext(),
    db.personalBrandRule.findMany({ orderBy: [{ category: "asc" }, { id: "asc" }] }),
    db.assessmentFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { lead: { select: { title: true, rawText: true } } } }),
    loadReportLeads("365d"),
  ]);

  const edited = leads
    .flatMap((l) => l.offers.filter((o) => o.sentAt && o.aiText).map((o) => ({ title: l.title, channel: o.channel, aiText: o.aiText!, text: o.text, ratio: editRatio(o.aiText!, o.text) })))
    .filter((e) => e.ratio >= 0.15)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);

  const calibration = scoreCalibration(leads);
  const agreement = verdictAgreement(leads);
  const edits = draftEdits(leads);

  const currentRules = BRAND_CATEGORIES.map(({ key, label }) => {
    const text = rules.filter((r) => r.category === key).map((r) => r.content).join("\n");
    return `[${key}] ${label}:\n${text || "(пусто)"}`;
  }).join("\n\n");

  const prompt = [
    "<current_rules>",
    currentRules,
    "</current_rules>",
    "",
    "<assessment_feedback>",
    feedback.length
      ? feedback.map((f) => `- «${f.lead.title}»: AI ${f.aiScore ?? "?"}/${f.aiVerdict ?? "?"}, правильно ${f.correctVerdict}. ${f.note}`).join("\n")
      : "(поправок нет)",
    "</assessment_feedback>",
    "",
    "<score_calibration>",
    calibration.map((c) => `- балл ${c.bucket}: решённых ${c.leads}, ответили ${c.responded}, пропущено ${c.skipped}, сделок ${c.won}`).join("\n"),
    `Совпадение вердикта с решением: ${agreement.agreement == null ? "нет данных" : `${Math.round(agreement.agreement * 100)}%`}, расхождений ${agreement.disagreements}`,
    "</score_calibration>",
    "",
    "<draft_edits>",
    edits.length ? edits.map((e) => `- ${e.channel}: отправлено ${e.sent}, в среднем изменено ${Math.round((e.avgEdit ?? 0) * 100)}% слов, без правок ${e.unchanged}`).join("\n") : "(нет)",
    ...edited.map((e) => `\n--- ${e.channel} · «${e.title}» · изменено ${Math.round(e.ratio * 100)}%\nЧерновик AI:\n${e.aiText.slice(0, 1500)}\nОтправлено:\n${e.text.slice(0, 1500)}`),
    "</draft_edits>",
    "",
    `Проанализируй, в чём оценки лидов и черновики расходятся с решениями и стилем фрилансера, и предложи правки его правил.
Правки должны объяснять закономерность в данных, а не отдельный случай. Сохраняй всё, что в текущих правилах уже верно, — newText заменяет категорию целиком.
Если данных мало (меньше 5 поправок и 5 отредактированных сообщений), скажи об этом в наблюдениях и предлагай только очевидное.`,
  ].join("\n");

  const result = await generateStructured({ purpose: "tuning", system: systemPrompt(brand), prompt, schema: tuningSchema, effort: "high" });
  const stored: StoredTuning = { createdAt: new Date().toISOString(), result, applied: [] };
  const json = stored as unknown as Prisma.InputJsonObject;
  await db.appSetting.upsert({ where: { key: TUNING_KEY }, create: { key: TUNING_KEY, value: json }, update: { value: json } });
  return stored;
}

/** Применить одно предложение: заменить правила категории предложенным текстом. Повторно не применяется. */
export async function applyRuleChange(index: number): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: TUNING_KEY } });
  const stored = row?.value as unknown as StoredTuning | undefined;
  const change = stored?.result.ruleChanges[index];
  if (!stored || !change || stored.applied.includes(index)) return false;

  await db.$transaction([
    db.personalBrandRule.deleteMany({ where: { category: change.category } }),
    db.personalBrandRule.create({ data: { category: change.category, content: change.newText.trim() } }),
    db.appSetting.update({
      where: { key: TUNING_KEY },
      data: { value: { ...stored, applied: [...stored.applied, index] } as unknown as Prisma.InputJsonObject },
    }),
  ]);
  return true;
}

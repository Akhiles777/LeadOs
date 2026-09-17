import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { generateStructured } from "@/ai/client";
import { leadContext, loadBrandContext } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";

export const RED_FLAG_KINDS = [
  "unrealistic_budget",
  "team_required",
  "outside_specialization",
  "grey_scheme",
  "vague_scope",
  "unrealistic_deadline",
  "free_test_work",
  "not_a_client",
  "other",
] as const;

export const assessmentSchema = z.object({
  score: z.number().int().describe("0–100: насколько стоит браться. 70+ брать, 40–69 подумать, ниже 40 пропустить"),
  verdict: z.enum(["TAKE", "CONSIDER", "SKIP"]),
  summary: z.string().describe("2–3 предложения: что за задача и главный аргумент за или против"),
  fit: z.object({
    specialization: z.string().describe("Попадает ли задача в стек и специализацию"),
    budget: z.string().describe("Реалистичен ли бюджет для такого объёма; если не указан — какой разумный"),
    scope: z.string().describe("Объём работ и справится ли один разработчик"),
  }),
  redFlags: z
    .array(
      z.object({
        kind: z.enum(RED_FLAG_KINDS),
        title: z.string().describe("Короткое название, 2–5 слов"),
        explanation: z.string().describe("Почему это проблема именно в этом лиде, со ссылкой на текст"),
        severity: z.enum(["high", "medium", "low"]),
      }),
    )
    .describe("Только реально найденные признаки; пустой список, если их нет"),
  questions: z.array(z.string()).describe("Что уточнить у заказчика до оценки или отклика; пусто, если всё ясно"),
});

export type Assessment = z.infer<typeof assessmentSchema>;

const TASK = `Оцени этот лид: стоит ли фрилансеру за него браться.

Проверь по очереди:
1. Специализация: задача в его стеке или требует чужой экспертизы (ML, HighLoad, мобильная нативная разработка и т.п. — смотри «Не берусь»).
2. Бюджет относительно объёма: хватит ли его на качественную работу одного разработчика. Для холодных лидов с карт бюджета нет — оцени потенциал по проверке сайта и нише.
3. Команда или соло: не нужна ли команда, штат, поддержка 24/7.
4. Признаки серой схемы: обход правил площадки, накрутки, парсинг персональных данных, «оплата после», бесплатное тестовое на полноценную работу.
5. Размытость: понятно ли, что нужно сделать.

Для каждого найденного тревожного признака дай короткое объяснение со ссылкой на текст лида. Не выдумывай флаги ради количества.`;

const VERDICT_RU = { TAKE: "брать", CONSIDER: "подумать", SKIP: "пропустить" } as const;
const FEEDBACK_LIMIT = 15;

/** Поправки фрилансера к прошлым оценкам — опыт, под который подстраивается оценка. Порядок стабильный для кэша. */
export async function loadFeedbackContext(): Promise<string> {
  const feedback = await db.assessmentFeedback.findMany({
    orderBy: { createdAt: "desc" },
    take: FEEDBACK_LIMIT,
    include: { lead: { select: { title: true, source: true, category: true } } },
  });
  if (!feedback.length) return "";
  return [
    "## Поправки к прошлым оценкам",
    "Фрилансер не согласился с этими оценками. Учитывай его логику для похожих лидов, но не переноси вердикт механически.",
    ...feedback.reverse().map((f) =>
      [
        `### «${f.lead.title}»${f.lead.category ? ` (${f.lead.category})` : ""}`,
        `Ты оценил: ${f.aiScore ?? "?"} — ${f.aiVerdict ? VERDICT_RU[f.aiVerdict] : "?"}. Правильно: ${VERDICT_RU[f.correctVerdict]}.`,
        `Почему: ${f.note}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

export async function assessLead(leadId: string): Promise<Assessment> {
  const [lead, brand, feedback] = await Promise.all([
    db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { activities: true, deal: { include: { addons: true } } } }),
    loadBrandContext(),
    loadFeedbackContext(),
  ]);

  const result = await generateStructured({
    purpose: "assess",
    leadId,
    system: systemPrompt(brand),
    systemExtra: feedback || undefined,
    prompt: `${leadContext(lead)}\n\n${TASK}`,
    schema: assessmentSchema,
    effort: "medium",
  });

  const score = Math.max(0, Math.min(100, Math.round(result.score)));
  const assessment: Assessment = { ...result, score };
  await db.lead.update({
    where: { id: leadId },
    data: {
      score,
      aiVerdict: assessment.verdict,
      scoreReason: assessment.summary,
      redFlags: assessment.redFlags.map((f) => `${f.title} — ${f.explanation}`),
      aiAssessment: assessment as unknown as Prisma.InputJsonObject,
      scoredAt: new Date(),
    },
  });
  return assessment;
}

import { z } from "zod";
import type { Lead } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { AI_MODEL, generateStructured } from "@/ai/client";
import { leadContext, loadBrandContext, loadFewShot } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";

export const DRAFT_CHANNELS = {
  kwork_response: { label: "Отклик на Kwork", purpose: "offer" },
  telegram_reply: { label: "Сообщение автору поста", purpose: "offer" },
  cold_message: { label: "Холодное сообщение", purpose: "offer" },
  cold_call_script: { label: "Скрипт звонка", purpose: "call_script" },
  follow_up: { label: "Follow-up", purpose: "follow_up" },
  referral_request: { label: "Просьба об отзыве и рекомендации", purpose: "follow_up" },
  upsell: { label: "Предложение доработок", purpose: "offer" },
} as const;

export type DraftChannel = keyof typeof DRAFT_CHANNELS;

export function isDraftChannel(v: unknown): v is DraftChannel {
  return typeof v === "string" && v in DRAFT_CHANNELS;
}

/** Какие черновики уместны для лида — кнопки в карточке. */
export function channelsFor(lead: Pick<Lead, "source" | "status">): DraftChannel[] {
  const out: DraftChannel[] = [];
  if (lead.source === "KWORK") out.push("kwork_response");
  else if (lead.source === "TELEGRAM") out.push("telegram_reply");
  else if (lead.source === "COLD_LOCAL") out.push("cold_call_script", "cold_message");
  else out.push("cold_message");
  if (["CONTACTED", "RESPONDED", "NEGOTIATING"].includes(lead.status)) out.push("follow_up");
  if (lead.status === "WON") return ["referral_request", "upsell"];
  return out;
}

const messageSchema = z.object({
  text: z.string().describe("Готовый текст сообщения, который можно отправить после правки"),
  notes: z.string().describe("1–2 предложения для фрилансера: какой угол выбран и какие кейсы упомянуты, что проверить перед отправкой"),
});

const callScriptSchema = z.object({
  opening: z.string().describe("Первые 1–2 фразы: кто звонит и зачем, до 20 секунд речи"),
  hook: z.string().describe("Почему звоню именно вам: конкретное наблюдение про их онлайн (сайт, запись, магазин)"),
  relevantCase: z.string().describe("Похожий реальный проект и что он дал клиенту; пусто, если подходящего нет"),
  questions: z.array(z.string()).describe("3–5 вопросов, чтобы понять боль"),
  objections: z.array(z.object({ objection: z.string(), answer: z.string() })).describe("Частые возражения этой ниши и короткие ответы"),
  nextStep: z.string().describe("Чем закончить разговор: встреча, созвон, отправка примера"),
  followUpMessage: z.string().describe("Короткое сообщение в WhatsApp/Telegram после звонка"),
});

const TASKS: Record<Exclude<DraftChannel, "cold_call_script">, string> = {
  kwork_response: `Напиши отклик на этот заказ Kwork.
Следуй правилам стиля отклика. По умолчанию: обращение к заказчику, одно-два предложения о том, как решишь именно его задачу (без пересказа ТЗ), похожий реальный проект если есть, вопрос или предложение следующего шага. Без списков и без общих фраз о себе.`,
  telegram_reply: `Напиши личное сообщение автору этого поста в Telegram.
Коротко, как человек человеку: зацепись за конкретику из поста, покажи, что понял задачу, упомяни похожий реальный проект если есть, предложи следующий шаг. 3–6 предложений.`,
  cold_message: `Напиши первое холодное сообщение этой компании (для WhatsApp/Telegram/почты).
Компания тебя не знает. Начни с конкретного наблюдения про их бизнес или сайт, покажи, что это даёт им (клиенты, запись, продажи), упомяни похожий реальный проект в их нише если есть, предложи короткий созвон. Без навязчивости, до 600 символов.`,
  follow_up: `Лид завис: после последнего касания нет движения. Напиши follow-up сообщение.
Учти историю касаний и что уже отправлялось. Не дави и не повторяй прошлое сообщение: добавь новую ценность (идея, пример, уточняющий вопрос) или мягко предложи закрыть вопрос. 2–4 предложения.`,
  referral_request: `Проект с этим клиентом завершён. Напиши короткое сообщение: поблагодари за работу, спроси, всё ли работает как нужно,
попроси отзыв (если заказ был на площадке — там, иначе пару слов для портфолио) и мягко спроси, нет ли знакомых, которым пригодится похожее решение.
Без давления и без скидок за рекомендацию, если про это нет в правилах. 3–5 предложений.`,
  upsell: `С этим клиентом уже сделан проект. Напиши сообщение с предложением следующего шага: доработка, интеграция, поддержка или то, что логично вытекает из задачи и ниши.
Опирайся на историю и уже предложенные доп. опции, если они есть. Одна конкретная идея с пользой для бизнеса клиента, а не список услуг. 3–5 предложений.`,
};

export type DraftResult = { draftId: string; channel: DraftChannel };

export async function generateDraft(leadId: string, channel: DraftChannel): Promise<DraftResult> {
  const [lead, brand] = await Promise.all([
    db.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: {
        activities: true,
        offers: { where: { sentAt: { not: null } }, orderBy: { sentAt: "desc" }, take: 3 },
        deal: { include: { addons: true } },
      },
    }),
    loadBrandContext(),
  ]);

  const sentBefore = lead.offers.length
    ? `\n\nУже отправлено этому лиду:\n${lead.offers.map((o) => `--- ${DRAFT_CHANNELS[o.channel as DraftChannel]?.label ?? o.channel}\n${o.text}`).join("\n")}`
    : "";

  if (channel === "cold_call_script") {
    const fewShot = await loadFewShot(["cold_call_script"], leadId, 2);
    const script = await generateStructured({
      purpose: "call_script",
      leadId,
      system: systemPrompt(brand),
      prompt: `${leadContext(lead)}${sentBefore}\n\n${fewShot}\n\nПодготовь скрипт холодного звонка в эту компанию под её нишу.
Не общий питч, а «у меня уже есть похожая система, вот что она даёт» — если в кейсах есть проект для этой или близкой ниши. Опирайся на пробелы из проверки сайта. Речь разговорная, фразы короткие.`,
      schema: callScriptSchema,
      effort: "high",
    });
    const text = renderCallScript(script);
    const draft = await db.offerDraft.create({
      data: { leadId, channel, text, aiText: text, notes: script.relevantCase ? `Кейс: ${script.relevantCase}` : "Подходящего кейса нет", model: AI_MODEL },
    });
    return { draftId: draft.id, channel };
  }

  const fewShot = await loadFewShot([channel], leadId);
  const result = await generateStructured({
    purpose: DRAFT_CHANNELS[channel].purpose,
    leadId,
    system: systemPrompt(brand),
    prompt: `${leadContext(lead)}${sentBefore}\n\n${fewShot}\n\n${TASKS[channel]}`,
    schema: messageSchema,
    effort: "high",
  });
  const draft = await db.offerDraft.create({
    data: { leadId, channel, text: result.text.trim(), aiText: result.text.trim(), notes: result.notes.trim(), model: AI_MODEL },
  });
  return { draftId: draft.id, channel };
}

export function renderCallScript(s: z.infer<typeof callScriptSchema>): string {
  return [
    `Начало:\n${s.opening}`,
    `Зацепка:\n${s.hook}`,
    s.relevantCase ? `Похожий проект:\n${s.relevantCase}` : "",
    s.questions.length ? `Вопросы:\n${s.questions.map((q) => `— ${q}`).join("\n")}` : "",
    s.objections.length ? `Возражения:\n${s.objections.map((o) => `«${o.objection}» → ${o.answer}`).join("\n")}` : "",
    `Следующий шаг:\n${s.nextStep}`,
    `Сообщение после звонка:\n${s.followUpMessage}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

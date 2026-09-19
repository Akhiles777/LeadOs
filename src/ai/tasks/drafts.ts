import { z } from "zod";
import type { Lead } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { AI_WRITER_MODEL, generateStructured } from "@/ai/client";
import { leadContext, loadBrandContext, loadFewShot } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";
import { solutionsBlock, solutionsFor } from "@/ai/solutions";
import { findCliches } from "@/ai/style";
import type { SiteCheck } from "@/lib/site-check";

export const DRAFT_CHANNELS = {
  kwork_response: { label: "Отклик на Kwork", purpose: "offer" },
  telegram_reply: { label: "Сообщение автору поста", purpose: "offer" },
  cold_message: { label: "Сообщение в WhatsApp/Telegram", purpose: "offer" },
  cold_email: { label: "Письмо на почту", purpose: "offer" },
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
  else if (lead.source === "COLD_LOCAL") out.push("cold_call_script", "cold_message", "cold_email");
  else out.push("cold_message");
  if (["CONTACTED", "RESPONDED", "NEGOTIATING"].includes(lead.status)) out.push("follow_up");
  if (lead.status === "WON") return ["referral_request", "upsell"];
  return out;
}

const messageSchema = z.object({
  text: z.string().describe("Готовый текст сообщения, который можно отправить после правки"),
  notes: z.string().describe("1–2 предложения для фрилансера: какой угол выбран и какие кейсы упомянуты, что проверить перед отправкой"),
});

export const callScriptSchema = z.object({
  opening: z.string().describe("Первые 1–2 фразы: имя, откуда и зачем звоню — с конкретикой про них, до 20 секунд речи. Спросить, удобно ли говорить и кто решает такие вопросы"),
  hook: z.string().describe("Почему звоню именно вам: конкретное наблюдение про их бизнес или онлайн и какое решение предлагаю"),
  relevantCase: z.string().describe("Похожий реальный проект и что он дал клиенту; пусто, если подходящего нет"),
  questions: z.array(z.string()).describe("3–5 вопросов, чтобы понять боль"),
  objections: z.array(z.object({ objection: z.string(), answer: z.string() })).describe("Частые возражения этой ниши и короткие ответы"),
  nextStep: z.string().describe("Чем закончить разговор: встреча, созвон, отправка примера"),
  followUpMessage: z.string().describe("Короткое сообщение в WhatsApp/Telegram после звонка"),
});

const TASKS: Record<Exclude<DraftChannel, "cold_call_script">, string> = {
  kwork_response: `Напиши отклик на этот заказ Kwork.
Следуй правилам стиля отклика. Покажи, что понял суть задачи и видишь её подводный камень: одной-двумя фразами — как именно сделаешь
(конкретная техника или подход под их случай, а не пересказ ТЗ). Если есть похожий реальный проект — одна фраза, что он дал.
Если данных хватает — ориентир по сроку. Один точный вопрос, без ответа на который нельзя оценить работу. Без списков и без общих фраз о себе.
Kwork запрещает контакты вне площадки: не пиши телефоны, мессенджеры и ссылки на них.`,
  telegram_reply: `Напиши личное сообщение автору этого поста в Telegram.
Коротко, как человек человеку: зацепись за конкретику из поста, одной фразой — как решишь именно их задачу,
упомяни похожий реальный проект если есть, задай один точный вопрос или предложи следующий шаг. 3–6 предложений.`,
  cold_message: `Напиши первое сообщение этой компании в WhatsApp/Telegram.
Компания тебя не знает. Первая фраза — конкретная деталь про них. Дальше — одно решение из <solutions> под то, чего им не хватает,
и что оно им даст, словами владельца. Похожий реальный проект, если есть. В конце — лёгкий шаг: «могу прислать демо на ваших данных — интересно?».
До 500 символов, без приветственных формальностей на полэкрана.`,
  cold_email: `Напиши письмо этой компании на почту. Первая строка — тема письма в формате «Тема: …» (конкретная, про них, до 60 символов, без кликбейта),
затем пустая строка и текст. Первая фраза — конкретная деталь про них. Одно решение из <solutions>: что входит (2–3 пункта через тире),
что это даст, ориентир по цене и сроку, бесплатный первый шаг. До 900 символов текста.`,
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

  const check = lead.siteCheck as unknown as SiteCheck | null;
  // Каталог решений нужен, когда предлагаем сами (холодные, допродажа). На заказ с Kwork/Telegram отвечаем по их задаче.
  const offerOwn = (lead.source !== "KWORK" && lead.source !== "TELEGRAM") || channel === "upsell";
  const solutions = offerOwn ? solutionsBlock(solutionsFor(`${lead.category ?? ""} ${lead.title} ${lead.rawText.slice(0, 2000)}`, check)) : "";
  const sentBefore = lead.offers.length
    ? `\n\nУже отправлено этому лиду:\n${lead.offers.map((o) => `--- ${DRAFT_CHANNELS[o.channel as DraftChannel]?.label ?? o.channel}\n${o.text}`).join("\n")}`
    : "";

  if (channel === "cold_call_script") {
    const fewShot = await loadFewShot(["cold_call_script"], leadId, 2);
    const script = await withoutCliches(
      (feedback) =>
        generateStructured({
          purpose: "call_script",
          leadId,
          system: systemPrompt(brand),
          prompt: `${leadContext(lead)}${sentBefore}\n\n${solutions}\n\n${fewShot}\n\nПодготовь скрипт холодного звонка в эту компанию.
Выбери одно решение из <solutions> под то, чего им не хватает, и строй разговор вокруг него. Если в кейсах есть проект для этой или близкой ниши —
«у меня уже есть похожая система, вот что она даёт». Опирайся на пробелы из проверки сайта и детали из <site>. Речь разговорная, фразы короткие.${feedback}`,
          schema: callScriptSchema,
          effort: "medium",
        }),
      renderCallScript,
      { allowIntro: true },
    );
    const text = renderCallScript(script);
    const draft = await db.offerDraft.create({
      data: { leadId, channel, text, aiText: text, notes: script.relevantCase ? `Кейс: ${script.relevantCase}` : "Подходящего кейса нет", model: AI_WRITER_MODEL },
    });
    return { draftId: draft.id, channel };
  }

  const fewShot = await loadFewShot([channel], leadId);
  const result = await withoutCliches(
    (feedback) =>
      generateStructured({
        purpose: DRAFT_CHANNELS[channel].purpose,
        leadId,
        system: systemPrompt(brand),
        prompt: `${leadContext(lead)}${sentBefore}\n\n${solutions}\n\n${fewShot}\n\n${TASKS[channel]}${feedback}`,
        schema: messageSchema,
        effort: "medium",
      }),
    (r) => r.text,
  );
  const draft = await db.offerDraft.create({
    data: { leadId, channel, text: result.text.trim(), aiText: result.text.trim(), notes: result.notes.trim(), model: AI_WRITER_MODEL },
  });
  return { draftId: draft.id, channel };
}

/**
 * Генерирует текст и, если в нём нашлись штампы, один раз просит переписать без них.
 * Второй вариант принимается как есть: лучше слегка шаблонный черновик, чем никакого.
 */
export async function withoutCliches<T>(
  generate: (feedback: string) => Promise<T>,
  textOf: (result: T) => string,
  opts: { allowIntro?: boolean } = {},
): Promise<T> {
  const first = await generate("");
  const cliches = findCliches(textOf(first), opts);
  if (!cliches.length) return first;
  return generate(
    `\n\nВ прошлом варианте были штампы, по которым видно рассылку: ${cliches.join(", ")}. Перепиши без них — конкретнее и живее, с деталями про эту компанию.`,
  );
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

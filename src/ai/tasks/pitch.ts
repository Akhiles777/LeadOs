/**
 * Пакет для холодной компании за один вызов: какое решение ей предложить и почему, цена и срок, бесплатный первый шаг,
 * скрипт звонка, сообщение в WhatsApp и письмо. Решение — в Lead.pitch (видно в карточке и в обзвоне),
 * тексты — черновиками, которые фрилансер правит и отправляет сам.
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { AI_MODEL, generateStructured } from "@/ai/client";
import { leadContext, loadBrandContext, loadFewShot } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";
import { findSolution, solutionsBlock, solutionsFor } from "@/ai/solutions";
import { callScriptSchema, renderCallScript, withoutCliches } from "@/ai/tasks/drafts";
import { allContacts, hasReachableContact } from "@/lib/contacts";
import type { SiteCheck } from "@/lib/site-check";

export const pitchSchema = z.object({
  solutionId: z.string().describe("id главного решения из <solutions>"),
  solutionTitle: z.string().describe("Как назвать решение владельцу этой компании, по-человечески: «электронное меню с заказом со стола»"),
  whyThem: z
    .array(z.string())
    .describe("2–4 конкретных факта про ЭТУ компанию из данных лида/сайта/карточки, из-за которых решение им нужно. Только то, что есть в данных"),
  pitch: z.string().describe("Суть предложения одной фразой: что сделаю и что это даст именно им"),
  price: z.string().describe("Ориентир цены для них: из правил фрилансера, иначе из каталога"),
  timeline: z.string().describe("Срок"),
  firstStep: z.string().describe("Бесплатный/дешёвый первый шаг, который снимает риск: демо на их данных, макет, разбор"),
  alternatives: z
    .array(z.object({ solutionId: z.string(), title: z.string(), why: z.string() }))
    .describe("0–2 запасных идеи на случай, если главное не зайдёт"),
  confidence: z.enum(["high", "medium", "low"]).describe("Насколько уверен, что компании это нужно: low — если данных почти нет"),
  callScript: callScriptSchema,
  whatsapp: z.string().describe("Первое сообщение в WhatsApp/Telegram, до 500 символов, начинается с детали про них"),
  email: z.object({
    subject: z.string().describe("Тема письма: конкретная, про них, до 60 символов"),
    body: z.string().describe("Текст письма до 900 символов: деталь про них, решение (2–3 пункта через тире), цена и срок, бесплатный первый шаг"),
  }),
});

export type Pitch = Omit<z.infer<typeof pitchSchema>, "callScript" | "whatsapp" | "email"> & { createdAt: string; model: string };

const TASK = `Подбери, что предложить этой компании, и подготовь всё для первого контакта.

1. Выбери ОДНО главное решение из <solutions>. Приоритет — решения с «ЕСТЬ СИГНАЛ» и то, что видно по данным
   (нет записи — онлайн-запись/WhatsApp; кафе без меню онлайн — электронное меню; большая клиника — CRM). Для крупной компании
   (сеть, много врачей/филиалов) — системное решение (CRM), для маленькой — быстрое и недорогое.
2. В whyThem — только факты из данных. Если данных мало, confidence = low, и тексты строй на вопросе, а не на утверждениях.
3. Скрипт звонка: представиться по имени (оставь «[Имя]»), зачем звоню — с конкретикой про них, вопросы про их боль,
   возражения именно этой ниши («у нас всё по телефону работает», «дорого», «уже есть YCLIENTS»…), следующий шаг — бесплатный первый шаг.
4. WhatsApp и письмо — разные тексты, не копии друг друга. Без ссылок, которых нет в данных.`;

export async function generatePitch(leadId: string): Promise<Pitch> {
  const [lead, brand] = await Promise.all([
    db.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { activities: true, offers: { where: { sentAt: { not: null } }, orderBy: { sentAt: "desc" }, take: 3 }, deal: { include: { addons: true } } },
    }),
    loadBrandContext(),
  ]);
  const check = lead.siteCheck as unknown as SiteCheck | null;
  const candidates = solutionsFor(`${lead.category ?? ""} ${lead.title} ${lead.rawText.slice(0, 2000)}`, check, 6);
  const fewShot = await loadFewShot(["cold_message", "cold_call_script"], leadId, 2);

  const result = await withoutCliches(
    (feedback) =>
      generateStructured({
        purpose: "pitch",
        leadId,
        system: systemPrompt(brand),
        prompt: `${leadContext(lead)}\n\n${solutionsBlock(candidates)}\n\n${fewShot}\n\n${TASK}${feedback}`,
        schema: pitchSchema,
        effort: "high",
        maxTokens: 12_000,
      }),
    (r) => [r.whatsapp, r.email.subject, r.email.body, r.callScript.hook, r.callScript.followUpMessage].join("\n"),
    { allowIntro: true },
  );

  // Модель могла вернуть id не из каталога — тогда берём первый подходящий, чтобы карточка не показывала мусор.
  const solutionId = findSolution(result.solutionId) ? result.solutionId : (candidates[0]?.id ?? result.solutionId);
  const pitch: Pitch = {
    solutionId,
    solutionTitle: result.solutionTitle,
    whyThem: result.whyThem,
    pitch: result.pitch,
    price: result.price,
    timeline: result.timeline,
    firstStep: result.firstStep,
    alternatives: result.alternatives.slice(0, 2),
    confidence: result.confidence,
    createdAt: new Date().toISOString(),
    model: AI_MODEL,
  };

  const note = `Решение: ${pitch.solutionTitle} · ${pitch.price} · ${pitch.timeline}`;
  const script = renderCallScript(result.callScript);
  const email = `Тема: ${result.email.subject.trim()}\n\n${result.email.body.trim()}`;
  const contacts = allContacts(lead);
  const hasEmail = contacts.some((c) => c.kind === "email");

  await db.$transaction([
    db.lead.update({ where: { id: leadId }, data: { pitch: pitch as unknown as Prisma.InputJsonObject } }),
    db.offerDraft.create({ data: { leadId, channel: "cold_call_script", text: script, aiText: script, notes: note, model: AI_MODEL } }),
    db.offerDraft.create({ data: { leadId, channel: "cold_message", text: result.whatsapp.trim(), aiText: result.whatsapp.trim(), notes: note, model: AI_MODEL } }),
    // Письмо сохраняем, только если есть куда его отправить или контактов нет вовсе (вдруг почта найдётся позже).
    ...(hasEmail || !hasReachableContact(contacts)
      ? [db.offerDraft.create({ data: { leadId, channel: "cold_email", text: email, aiText: email, notes: note, model: AI_MODEL } })]
      : []),
  ]);
  return pitch;
}

export function readPitch(value: unknown): Pitch | null {
  const p = value as Pitch | null;
  return p && typeof p.solutionTitle === "string" && Array.isArray(p.whyThem) ? p : null;
}

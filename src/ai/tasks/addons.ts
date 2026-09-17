import { z } from "zod";
import { db } from "@/lib/db";
import { generateStructured } from "@/ai/client";
import { leadContext, loadBrandContext } from "@/ai/context";
import { systemPrompt } from "@/ai/prompts";

const addonsSchema = z.object({
  addons: z
    .array(
      z.object({
        title: z.string().describe("Короткое название опции, как в смете"),
        description: z.string().describe("Что входит и что это даёт клиенту, 1–2 предложения"),
        price: z.number().int().describe("Цена в рублях по ориентирам из правил «Цены и сроки»"),
        why: z.string().describe("Почему именно этому клиенту: ссылка на задачу, нишу или проверку сайта"),
      }),
    )
    .describe("3–5 опций, которые логично продолжают основную работу; не дублируй то, что уже в сделке"),
});

/** Предлагает доп. опции к сделке и сохраняет их как «предложенные» — принимать или нет решаешь ты. */
export async function suggestAddons(leadId: string): Promise<number> {
  const [lead, brand] = await Promise.all([
    db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { activities: true, deal: { include: { addons: true } } } }),
    loadBrandContext(),
  ]);
  if (!lead.deal) throw new Error("Сначала создай сделку");

  const existing = lead.deal.addons.map((a) => `- ${a.title} (${a.price} ₽, ${a.status})`).join("\n");
  const result = await generateStructured({
    purpose: "offer",
    leadId,
    system: systemPrompt(brand),
    prompt: `${leadContext(lead)}

<deal>
Основная работа: ${lead.deal.amount ? `${lead.deal.amount} ₽` : "сумма не указана"}, этап: ${lead.deal.stage}
Уже в сделке:
${existing || "(доп. опций нет)"}
</deal>

Предложи доп. опции, которые этот клиент с высокой вероятностью купит вместе с основной работой или сразу после: то, что усиливает результат (онлайн-запись, интеграции, SEO-основа, аналитика, поддержка, обучение сотрудников, контент и т.п.).
Только то, что фрилансер реально делает по своему стеку. Цены — реалистичные для его рынка.`,
    schema: addonsSchema,
    effort: "medium",
  });

  const known = new Set(lead.deal.addons.map((a) => a.title.toLowerCase()));
  const fresh = result.addons.filter((a) => a.price > 0 && !known.has(a.title.toLowerCase())).slice(0, 5);
  if (fresh.length) {
    await db.dealAddon.createMany({
      data: fresh.map((a) => ({ dealId: lead.deal!.id, title: a.title.slice(0, 200), description: `${a.description}\n${a.why}`.slice(0, 2000), price: Math.round(a.price), source: "ai" })),
    });
  }
  return fresh.length;
}

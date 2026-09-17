import type { Activity, Deal, DealAddon, Lead, OfferDraft, Payment, PortfolioCase } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ACTIVITY_LABEL, formatBudget, formatDate, SOURCE_LABEL, STATUS_LABEL } from "@/lib/leads";
import { opportunity, type SiteCheck } from "@/lib/site-check";

export const BRAND_CATEGORIES = [
  { key: "о_себе", label: "О себе", hint: "Кто ты, чем занимаешься, в каком городе, сколько лет в разработке" },
  { key: "стек", label: "Стек и специализация", hint: "Что делаешь хорошо и берёшь в работу" },
  { key: "запрещённые_проекты", label: "Не берусь", hint: "Какие проекты сразу мимо: ML, HighLoad, работа в штат…" },
  { key: "стиль_отклика", label: "Стиль отклика", hint: "Правила из твоего отклик-гайда: без списков, без пересказа ТЗ…" },
  { key: "тон", label: "Тон и обращение", hint: "На «вы»/«ты», приветствие, длина, подпись" },
  { key: "цены", label: "Цены и сроки", hint: "Ориентиры по бюджетам, минимальный чек, как говоришь о цене" },
] as const;

export type BrandCategory = (typeof BRAND_CATEGORIES)[number]["key"];

/**
 * Постоянная часть системного промпта: правила бренда и кейсы. Порядок детерминированный —
 * одинаковый текст между вызовами даёт попадания в кэш промпта.
 */
export async function loadBrandContext(): Promise<string> {
  const [rules, cases] = await Promise.all([
    db.personalBrandRule.findMany({ orderBy: [{ category: "asc" }, { id: "asc" }] }),
    db.portfolioCase.findMany({ where: { active: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);

  const ruleBlocks = BRAND_CATEGORIES.map(({ key, label }) => {
    const text = rules
      .filter((r) => r.category === key)
      .map((r) => r.content.trim())
      .filter(Boolean)
      .join("\n");
    return text ? `### ${label}\n${text}` : null;
  }).filter(Boolean);

  return [
    "## Правила фрилансера (соблюдай их буквально)",
    ruleBlocks.length ? ruleBlocks.join("\n\n") : "(правила пока не заполнены — пиши сдержанно и по делу)",
    "",
    "## Реальные проекты (ссылаться можно ТОЛЬКО на них, ничего не выдумывать)",
    cases.length ? cases.map(formatCase).join("\n\n") : "(кейсов пока нет — не упоминай опыт конкретными проектами)",
  ].join("\n");
}

function formatCase(c: PortfolioCase): string {
  return [`### ${c.title}`, `Кому подходит: ${c.niches}`, c.summary.trim(), c.stack ? `Стек: ${c.stack}` : "", c.url ? `Ссылка: ${c.url}` : ""]
    .filter(Boolean)
    .join("\n");
}

type LeadWithHistory = Lead & { activities?: Activity[]; deal?: (Deal & { addons?: DealAddon[]; payments?: Payment[] }) | null };

const ADDON_STATUS_RU = { PROPOSED: "предложена", ACCEPTED: "принята", DECLINED: "отказ" } as const;

/** Изменчивая часть промпта: всё, что известно о лиде. */
export function leadContext(lead: LeadWithHistory): string {
  const check = lead.siteCheck as unknown as SiteCheck | null;
  const opp = check ? opportunity(check, lead.category) : null;

  const lines = [
    `Источник: ${SOURCE_LABEL[lead.source]}`,
    `Статус в воронке: ${STATUS_LABEL[lead.status]}`,
    `Заголовок: ${lead.title}`,
    lead.category ? `Категория/ниша: ${lead.category}` : "",
    lead.region ? `Регион: ${lead.region}` : "",
    lead.budgetMin != null || lead.budgetMax != null ? `Бюджет: ${formatBudget(lead.budgetMin, lead.budgetMax)}` : "Бюджет: не указан",
    lead.contactName ? `Контакт: ${lead.contactName}` : "",
    lead.website ? `Сайт: ${lead.website}` : "",
    opp && opp.reasons.length ? `Проверка сайта (${check!.status}): ${opp.reasons.join("; ")}` : "",
    check?.platform ? `Платформа сайта: ${check.platform}` : "",
  ].filter(Boolean);

  const history = (lead.activities ?? [])
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-15)
    .map((a) => `- ${formatDate(a.createdAt, true)} · ${ACTIVITY_LABEL[a.type]}: ${a.note}`);

  const deal = lead.deal;
  const dealLines = deal
    ? [
        "",
        "Сделка:",
        `- сумма за работу: ${deal.amount ? `${deal.amount} ₽` : "не указана"}, этап: ${deal.stage}, оплата: ${deal.paymentPlan === "INSTALLMENTS" ? "частями" : "целиком"}`,
        deal.closedAt ? `- закрыта ${formatDate(deal.closedAt)}` : "",
        ...(deal.addons ?? []).map((a) => `- опция «${a.title}» ${a.price} ₽ — ${ADDON_STATUS_RU[a.status]}`),
      ].filter(Boolean)
    : [];

  return [
    "<lead>",
    ...lines,
    ...dealLines,
    "",
    "Исходный текст:",
    lead.rawText.trim() || "(пусто)",
    history.length ? `\nИстория касаний:\n${history.join("\n")}` : "",
    "</lead>",
  ].join("\n");
}

/** Примеры прошлых отправленных сообщений того же типа: сначала те, что привели к сделке. */
export async function loadFewShot(channels: string[], excludeLeadId: string, limit = 4): Promise<string> {
  const sent = await db.offerDraft.findMany({
    where: { channel: { in: channels }, sentAt: { not: null }, leadId: { not: excludeLeadId } },
    include: { lead: { select: { title: true, status: true } } },
    orderBy: { sentAt: "desc" },
    take: 50,
  });
  const ranked = [...sent.filter((d) => d.lead.status === "WON"), ...sent.filter((d) => d.lead.status !== "WON")].slice(0, limit);
  if (!ranked.length) return "";
  return [
    "<past_messages>",
    "Мои прошлые отправленные сообщения — перенимай стиль и длину, не копируй содержание. Помеченные «сделка» привели к заказу.",
    ...ranked.map((d: OfferDraft & { lead: { title: string; status: string } }) =>
      [`--- ${d.lead.status === "WON" ? "сделка" : "без сделки"} · к заказу «${d.lead.title}»`, d.text.trim()].join("\n"),
    ),
    "</past_messages>",
  ].join("\n");
}

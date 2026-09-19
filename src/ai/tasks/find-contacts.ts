/**
 * Поиск контактов компании в интернете (плагин веб-поиска RouterAI): для компаний, у которых в OpenStreetMap
 * и на сайте нет ни телефона, ни мессенджера.
 *
 * Модели нельзя верить на слово: номер или адрес принимается, только если он действительно есть в тексте найденного
 * источника и рядом упоминается сама компания. Остальное отбрасывается.
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { generateStructuredWithSources, type WebCitation } from "@/ai/client";
import { allContacts, type Contact, contactFromUrl, fieldsFromContacts, mergeContacts, phoneDigits, readContacts, visibleText } from "@/lib/contacts";
import { normalizePhone } from "@/lib/lead-input";
import { safeFetch, toUrl } from "@/lib/site-check";

const foundSchema = z.object({
  found: z.boolean().describe("Нашлась ли именно эта компания (название + город/адрес совпадают)"),
  website: z.string().describe("Официальный сайт компании; пусто, если нет или не уверен. Не агрегаторы и не карты"),
  phones: z.array(z.object({ value: z.string(), sourceUrl: z.string() })).describe("Телефоны компании и страница, где указан каждый"),
  emails: z.array(z.object({ value: z.string(), sourceUrl: z.string() })),
  links: z.array(z.object({ url: z.string(), sourceUrl: z.string() })).describe("WhatsApp (wa.me), Telegram, VK, Instagram, MAX компании"),
  note: z.string().describe("Коротко: по каким признакам понял, что это та самая компания"),
});

const GENERIC = /^(ооо|ип|зао|оао|сеть|компания|клиника|стоматология|стоматологическая|магазин|салон|центр|кафе|ресторан|бар|студия|автосервис|аптека|медицинский|медицинская|красоты|школа|сервис|group|клиник)$/i;

/** Отличительные слова названия: по ним проверяем, что источник про ту же компанию. */
export function nameTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !GENERIC.test(w));
}

function mentionsCompany(text: string, tokens: string[]): boolean {
  if (!tokens.length) return true; // название из одних общих слов — проверить нечем, решает совпадение номера
  const lower = text.toLowerCase().replace(/ё/g, "е");
  return tokens.some((t) => lower.includes(t));
}

type SourceText = { url: string; text: string };

/** Тексты источников: из цитат поиска, а для страниц, которых там нет, — загрузка (не больше трёх). */
async function sourceTexts(citations: WebCitation[], urls: string[]): Promise<SourceText[]> {
  const out: SourceText[] = citations.map((c) => ({ url: c.url, text: `${c.title ?? ""}\n${c.content ?? ""}` }));
  const known = new Set(out.map((s) => s.url));
  const toFetch = [...new Set(urls)].filter((u) => !known.has(u)).slice(0, 3);
  for (const raw of toFetch) {
    const url = toUrl(raw);
    if (!url) continue;
    try {
      const { status, html } = await safeFetch(url);
      if (status < 400 && html) out.push({ url: raw, text: `${html.match(/href\s*=\s*["'][^"']+["']/gi)?.join(" ") ?? ""}\n${visibleText(html)}` });
    } catch {
      // страница не открылась — значит, и подтвердить по ней нечего
    }
  }
  return out;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Подтверждённые контакты: значение есть в тексте источника, где упомянута компания. */
export function verifyContacts(
  result: z.infer<typeof foundSchema>,
  sources: SourceText[],
  title: string,
): { contacts: Contact[]; website: string | null } {
  const tokens = nameTokens(title);
  const relevant = sources.filter((s) => mentionsCompany(s.text, tokens));
  const note = (url: string) => {
    try {
      return `нашёл: ${new URL(url).hostname.replace(/^www\./, "")}`;
    } catch {
      return "веб-поиск";
    }
  };
  const contacts: Contact[] = [];

  for (const p of result.phones) {
    const digits = phoneDigits(p.value);
    if (!digits) continue;
    const national = digits.slice(1);
    const hit = relevant.find((s) => digitsOf(s.text).includes(national));
    if (hit) contacts.push({ kind: "phone", value: normalizePhone(digits), url: `tel:+${digits}`, source: "web", note: note(hit.url) });
  }
  for (const e of result.emails) {
    const email = e.value.trim().toLowerCase();
    const hit = relevant.find((s) => s.text.toLowerCase().includes(email));
    if (hit && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) contacts.push({ kind: "email", value: email, url: `mailto:${email}`, source: "web", note: note(hit.url) });
  }
  for (const l of result.links) {
    const c = contactFromUrl(l.url, "web");
    if (!c) continue;
    const handle = c.value.replace(/^@/, "").replace(/^vk\.com\/|^max\.ru\//, "").toLowerCase();
    const hit = relevant.find((s) => s.text.toLowerCase().includes(handle) || (c.kind === "whatsapp" && digitsOf(s.text).includes(digitsOf(c.value).slice(1))));
    if (hit) contacts.push({ ...c, note: note(hit.url) });
  }

  // Сайт: домен должен встречаться в источниках про компанию (или быть одним из источников).
  let website: string | null = null;
  const site = result.website ? toUrl(result.website) : null;
  if (site && !/(2gis|yandex|google|zoon|yell|flamp|prodoctorov|napopravku|avito|vk\.com|instagram)\./i.test(site.hostname)) {
    const host = site.hostname.replace(/^www\./, "");
    if (relevant.some((s) => s.url.includes(host) || s.text.includes(host))) website = `https://${host}`;
  }
  return { contacts: mergeContacts([], contacts), website };
}

export type FindContactsResult = { added: number; website: string | null };

export async function findContacts(leadId: string): Promise<FindContactsResult> {
  const lead = await db.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { title: true, category: true, region: true, rawText: true, website: true, contacts: true, contactPhone: true, contactTg: true, contactEmail: true },
  });
  const address = /Адрес: (.+)/.exec(lead.rawText)?.[1] ?? "";
  const who = [`«${lead.title}»`, lead.category, address || lead.region].filter(Boolean).join(", ");

  const { data, citations } = await generateStructuredWithSources({
    purpose: "contacts",
    leadId,
    system: `Ты ищешь официальные контакты конкретной компании в интернете: сайт компании, справочники (2ГИС, Яндекс, Zoon, ПроДокторов),
соцсети. Возвращай только то, что прямо написано на найденных страницах, с адресом страницы. Если не уверен, что это та же
компания (другой город, другой адрес, другое название), — не включай. Ничего не придумывай.`,
    prompt: `Найди телефон, WhatsApp, Telegram, почту, VK/Instagram и официальный сайт компании: ${who}.`,
    schema: foundSchema,
    effort: "low",
    maxTokens: 3000,
    webSearch: { maxResults: 6, searchPrompt: `Контакты компании ${who}` },
  });

  const now = new Date();
  if (!data.found) {
    await db.lead.update({ where: { id: leadId }, data: { contactsSearchedAt: now } });
    return { added: 0, website: null };
  }

  const urls = [...data.phones.map((p) => p.sourceUrl), ...data.emails.map((e) => e.sourceUrl), ...data.links.map((l) => l.sourceUrl)].filter(Boolean);
  const verified = verifyContacts(data, await sourceTexts(citations, urls), lead.title);
  const before = readContacts(lead.contacts);
  const contacts = mergeContacts(before, verified.contacts);
  const newWebsite = !lead.website && verified.website ? verified.website : null;

  await db.lead.update({
    where: { id: leadId },
    data: {
      contactsSearchedAt: now,
      contacts: contacts as unknown as Prisma.InputJsonArray,
      ...fieldsFromContacts(lead, allContacts({ ...lead, contacts })),
      ...(newWebsite ? { website: newWebsite } : {}),
    },
  });
  return { added: contacts.length - before.length, website: newWebsite };
}

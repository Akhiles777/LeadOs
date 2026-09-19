/**
 * Каналы связи компании: откуда бы они ни пришли (OSM, сайт, веб-поиск, закладка), хранятся одним списком
 * в Lead.contacts без дублей. Первый телефон/почта/Telegram дублируются в старые поля контактов.
 */
import { normalizePhone } from "@/lib/lead-input";

export type ContactKind = "phone" | "whatsapp" | "telegram" | "email" | "vk" | "instagram" | "max";
export type ContactSource = "osm" | "site" | "web" | "maps" | "manual";

export type Contact = {
  kind: ContactKind;
  value: string; // «+7 900 123-45-67», «@name», «info@site.ru», «vk.com/name»
  url?: string; // куда вести кнопку: tel:, wa.me, t.me, mailto:, https://vk.com/…
  source: ContactSource;
  note?: string; // «со страницы Контакты», «нашёл: 2gis.ru/…»
};

export const CONTACT_LABEL: Record<ContactKind, string> = {
  phone: "Телефон",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  email: "Почта",
  vk: "ВКонтакте",
  instagram: "Instagram",
  max: "MAX",
};

export const SOURCE_NOTE: Record<ContactSource, string> = {
  osm: "OpenStreetMap",
  site: "сайт компании",
  web: "веб-поиск",
  maps: "карточка на картах",
  manual: "вручную",
};

/** «+7XXXXXXXXXX» или null, если это не российский номер из 10 цифр. */
export function phoneDigits(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  const national = d.length === 11 && /^[78]/.test(d) ? d.slice(1) : d.length === 10 ? d : null;
  return national && /^[3489]/.test(national) ? `7${national}` : null;
}

function phoneContact(raw: string, source: ContactSource, kind: "phone" | "whatsapp" = "phone"): Contact | null {
  const digits = phoneDigits(raw);
  if (!digits) return null;
  const value = normalizePhone(digits);
  return { kind, value, url: kind === "whatsapp" ? `https://wa.me/${digits}` : `tel:+${digits}`, source };
}

const RESERVED_TG = new Set(["share", "joinchat", "addstickers", "proxy", "socks", "iv", "s", "c", "login", "setlanguage"]);
const RESERVED_VK = new Set(["share.php", "widget_community.php", "js", "images", "away.php", "wall", "video", "photo", "app", "login", "feed", "im"]);
const RESERVED_IG = new Set(["p", "explore", "reel", "reels", "stories", "accounts", "tv", "about", "developer", "legal"]);

/** Ссылка на мессенджер/соцсеть → контакт. Всё непохожее на профиль отбрасывается. */
export function contactFromUrl(raw: string, source: ContactSource): Contact | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^\/\//, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const first = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");

  if (url.protocol === "tel:") return phoneContact(url.pathname, source);
  if (url.protocol === "mailto:") return emailContact(decodeURIComponent(url.pathname), source);
  if (host === "wa.me" || host === "api.whatsapp.com" || host === "web.whatsapp.com" || url.protocol === "whatsapp:") {
    const phone = url.searchParams.get("phone") ?? first;
    return phone ? phoneContact(phone, source, "whatsapp") : null;
  }
  if (host === "t.me" || host === "telegram.me") {
    if (!/^[a-zA-Z][\w]{3,31}$/.test(first) || RESERVED_TG.has(first.toLowerCase())) return null;
    return { kind: "telegram", value: `@${first}`, url: `https://t.me/${first}`, source };
  }
  if (host === "vk.com" || host === "vk.ru" || host === "m.vk.com") {
    if (!/^[\w.]{2,64}$/.test(first) || RESERVED_VK.has(first.toLowerCase())) return null;
    return { kind: "vk", value: `vk.com/${first}`, url: `https://vk.com/${first}`, source };
  }
  if (host === "instagram.com") {
    if (!/^[\w.]{2,30}$/.test(first) || RESERVED_IG.has(first.toLowerCase())) return null;
    return { kind: "instagram", value: `@${first}`, url: `https://instagram.com/${first}`, source };
  }
  if (host === "max.ru" && first && first !== "join") return { kind: "max", value: `max.ru/${first}`, url: `https://max.ru/${first}`, source };
  return null;
}

const JUNK_EMAIL = /(example\.|sentry|wixpress|domain\.|email\.com$|yoursite|mysite|\.(png|jpe?g|gif|svg|webp)$|^[0-9a-f]{16,}@)/i;

function emailContact(raw: string, source: ContactSource): Contact | null {
  const email = raw.split("?")[0].trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || JUNK_EMAIL.test(email)) return null;
  return { kind: "email", value: email, url: `mailto:${email}`, source };
}

/** Российские номера в тексте: +7 (872) 212-34-56, 8 928 123 45 67, 8-800-… */
const PHONE_IN_TEXT = /(?<![\d/=.-])(?:\+7|8)[\s(-]{0,3}\d{3}[\s)-]{0,3}\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\d])/g;
const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Видимый текст страницы без скриптов и стилей. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Все каналы связи со страницы: ссылки tel:/mailto:/мессенджеры и номера/почты в тексте. */
export function extractContacts(html: string, source: ContactSource = "site"): Contact[] {
  const found: Contact[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    const c = contactFromUrl(href, source);
    if (c) found.push(c);
  }
  const text = visibleText(html);
  for (const m of text.matchAll(PHONE_IN_TEXT)) {
    const c = phoneContact(m[0], source);
    if (c) found.push(c);
  }
  for (const m of text.matchAll(EMAIL_IN_TEXT)) {
    const c = emailContact(m[0], source);
    if (c) found.push(c);
  }
  // На сайтах номер повторяется в шапке, подвале и виджетах — ограничиваем, чтобы не тащить мусор.
  return mergeContacts([], found).slice(0, 12);
}

/** Теги OSM → контакты. */
export function contactsFromOsmTags(tags: Record<string, string>): Contact[] {
  const out: Contact[] = [];
  const split = (v?: string) => (v ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const key of ["phone", "contact:phone", "contact:mobile", "mobile"]) for (const v of split(tags[key])) push(out, phoneContact(v, "osm"));
  for (const v of split(tags["contact:whatsapp"])) push(out, /^https?:/.test(v) ? contactFromUrl(v, "osm") : phoneContact(v, "osm", "whatsapp"));
  for (const v of split(tags["contact:telegram"])) push(out, contactFromUrl(/^https?:/.test(v) ? v : `https://t.me/${v.replace(/^@/, "")}`, "osm"));
  for (const v of split(tags["contact:vk"])) push(out, contactFromUrl(/^https?:/.test(v) ? v : `https://vk.com/${v}`, "osm"));
  for (const v of split(tags["contact:instagram"])) push(out, contactFromUrl(/^https?:/.test(v) ? v : `https://instagram.com/${v.replace(/^@/, "")}`, "osm"));
  for (const key of ["email", "contact:email"]) for (const v of split(tags[key])) push(out, emailContact(v, "osm"));
  return mergeContacts([], out);
}

function push(list: Contact[], c: Contact | null) {
  if (c) list.push(c);
}

function key(c: Contact): string {
  return `${c.kind}|${c.value.toLowerCase()}`;
}

/** Добавляет новые контакты к старым: без дублей, старые (в т.ч. ручные) сохраняют порядок и источник. */
export function mergeContacts(existing: Contact[], incoming: Contact[]): Contact[] {
  const seen = new Set(existing.map(key));
  const out = [...existing];
  for (const c of incoming) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    out.push(c);
  }
  return out;
}

export function readContacts(value: unknown): Contact[] {
  return Array.isArray(value) ? (value as Contact[]).filter((c) => c && typeof c.kind === "string" && typeof c.value === "string") : [];
}

/** Старые поля лида → контакты, чтобы показывать всё одним списком. */
export function contactsFromFields(lead: { contactPhone?: string | null; contactTg?: string | null; contactEmail?: string | null }): Contact[] {
  const out: Contact[] = [];
  if (lead.contactPhone) push(out, phoneContact(lead.contactPhone, "manual") ?? { kind: "phone", value: lead.contactPhone, source: "manual" });
  const tg = lead.contactTg?.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (tg) push(out, contactFromUrl(`https://t.me/${tg}`, "manual"));
  if (lead.contactEmail) push(out, emailContact(lead.contactEmail, "manual"));
  return out;
}

/** Все каналы лида: поля + сохранённый список. */
export function allContacts(lead: { contacts?: unknown; contactPhone?: string | null; contactTg?: string | null; contactEmail?: string | null }): Contact[] {
  return mergeContacts(contactsFromFields(lead), readContacts(lead.contacts));
}

/** Какие старые поля заполнить из найденного, не затирая уже заданное. */
export function fieldsFromContacts(
  lead: { contactPhone?: string | null; contactTg?: string | null; contactEmail?: string | null },
  contacts: Contact[],
): { contactPhone?: string; contactTg?: string; contactEmail?: string } {
  const out: { contactPhone?: string; contactTg?: string; contactEmail?: string } = {};
  const phone = contacts.find((c) => c.kind === "phone") ?? contacts.find((c) => c.kind === "whatsapp");
  if (!lead.contactPhone && phone) out.contactPhone = phone.value;
  const tg = contacts.find((c) => c.kind === "telegram");
  if (!lead.contactTg && tg) out.contactTg = tg.value;
  const email = contacts.find((c) => c.kind === "email");
  if (!lead.contactEmail && email) out.contactEmail = email.value;
  return out;
}

export function hasReachableContact(contacts: Contact[]): boolean {
  return contacts.some((c) => c.kind === "phone" || c.kind === "whatsapp" || c.kind === "telegram" || c.kind === "email" || c.kind === "max");
}

/** Ссылка «написать в WhatsApp с готовым текстом» — отправляешь сам. */
export function whatsappLink(contacts: Contact[], text?: string): string | null {
  const wa = contacts.find((c) => c.kind === "whatsapp") ?? contacts.find((c) => c.kind === "phone");
  const digits = wa ? phoneDigits(wa.value) : null;
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function mailtoLink(contacts: Contact[], subject?: string, body?: string): string | null {
  const email = contacts.find((c) => c.kind === "email");
  if (!email) return null;
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const q = params.toString().replace(/\+/g, "%20");
  return `mailto:${email.value}${q ? `?${q}` : ""}`;
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Проверка сайта компании для холодного поиска: открывается ли, на чём сделан, есть ли запись/магазин/CRM.
 * Один GET главной страницы — как обычный визит браузера. Без обхода страниц и форм.
 */

export type SiteStatus = "no_site" | "social_only" | "ok" | "unreachable" | "blocked";

export type SiteCheck = {
  status: SiteStatus;
  checkedAt: string;
  url?: string;
  finalUrl?: string;
  httpStatus?: number;
  error?: string;
  https?: boolean;
  mobile?: boolean;
  title?: string;
  platform?: string; // Tilda, Wix, 1С-Битрикс, WordPress…
  builder?: boolean; // конструктор сайтов / мини-лендинг
  hasShop?: boolean;
  hasBooking?: boolean;
  hasCrmWidget?: boolean; // онлайн-чат, формы CRM, коллтрекинг
  hasAnalytics?: boolean;
  lastYear?: number; // самый поздний год в копирайте
  sizeKb?: number;
};

const SOCIAL_HOSTS = /(^|\.)(vk\.com|vk\.ru|ok\.ru|instagram\.com|facebook\.com|t\.me|telegram\.me|wa\.me|whatsapp\.com|taplink\.cc|taplink\.ws|linktr\.ee|youtube\.com|dzen\.ru|avito\.ru)$/i;

const PLATFORMS: [name: string, builder: boolean, pattern: RegExp][] = [
  ["Tilda", true, /tildacdn|tilda\.ws|data-tilda-/],
  ["Wix", true, /wixstatic\.com|static\.parastorage\.com|x-wix-/],
  ["Taplink", true, /taplink\.(cc|ws|st)/],
  ["Nethouse", true, /nethouse\.ru/],
  ["Flexbe", true, /flexbe\.(ru|com)/],
  ["uKit", true, /ukit\.(com|me)|ucoz/],
  ["Craftum", true, /craftum/],
  ["LPmotor", true, /lpmotor|platformalp/],
  ["Setup.ru", true, /setup\.ru/],
  ["Jimdo", true, /jimdo/],
  ["Webflow", true, /webflow\.(com|io)/],
  ["Яндекс Бизнес (сайт)", true, /business\.site|yandex\.ru\/sprav/],
  ["InSales", false, /insales|myinsales/],
  ["Shop-Script", false, /shop-script|webasyst/],
  ["1С-Битрикс", false, /\/bitrix\/(js|templates|cache)|bx-core|bitrix24/],
  ["WordPress", false, /wp-content|wp-includes/],
  ["Joomla", false, /\/media\/jui\/|joomla/],
  ["OpenCart", false, /catalog\/view\/theme|route=product/],
  ["Drupal", false, /drupal-settings-json|\/sites\/default\/files/],
  ["MODX", false, /modx|assets\/components/],
  ["Next.js/React", false, /__next_data__|\/_next\/static|data-reactroot/],
];

const SHOP = /add[-_]?to[-_]?cart|в корзину|корзин[аы]|оформить заказ|woocommerce|bx-basket|basket|ecwid|t-store|t706|shopping-cart|insales/;
const BOOKING = /yclients|dikidi|онлайн[- ]?запис|записаться онлайн|medflex|prodoctorov|infoclinica|sonline|arnica|medods|bookform|zapis|widget\.booking|booking-widget|napopravku|docdoc/;
const CRM_WIDGET = /jivosite|jivo\.|code\.jivo|bitrix24\.(ru|by|kz)\/b\d|crm-form|b24-widget|amocrm|envybox|callbackhunter|wazzup|roistat|retailcrm|carrotquest|usedesk|chat2desk|calltouch|comagic|uiscom|mango-office/;
const ANALYTICS = /mc\.yandex\.ru\/metrika|ym\(\d+|googletagmanager|gtag\(/;

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

export class BlockedUrlError extends Error {}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Не даёт проверке сайта обращаться во внутреннюю сеть сервера (localhost, 10.x, метаданные облака и т.п.). */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Только http/https");
  if (url.port && url.port !== "80" && url.port !== "443") throw new BlockedUrlError("Нестандартный порт");
  if (url.username || url.password) throw new BlockedUrlError("Адрес с логином");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new BlockedUrlError("Внутренний адрес");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new BlockedUrlError("Внутренний адрес");
}

export function toUrl(raw: string): URL | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
  let text = decode(bytes, charset);
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(text.slice(0, 3000))?.[1];
  if (metaCharset && metaCharset.toLowerCase() !== charset.toLowerCase()) text = decode(bytes, metaCharset);
  return text;
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase() === "cp1251" ? "windows-1251" : charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

type FetchResult = { finalUrl: URL; status: number; html: string };
export type Fetcher = (url: URL) => Promise<FetchResult>;

/** GET с ручными редиректами: каждый переход снова проверяется на внутренние адреса. */
export const safeFetch: Fetcher = async (start) => {
  let url = start;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: deadline,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 LeadOS-site-check",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
      },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      url = new URL(location, url);
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    const html = /html|xml|text\/plain/i.test(type) || !type ? await readLimited(response) : "";
    if (!html) await response.body?.cancel().catch(() => {});
    return { finalUrl: url, status: response.status, html };
  }
  throw new Error("Слишком много редиректов");
};

/** Разбор HTML главной страницы — отдельно от сети, чтобы тестировать на фикстурах. */
export function analyzeHtml(html: string, finalUrl: URL): Omit<SiteCheck, "status" | "checkedAt" | "url" | "httpStatus"> {
  const lower = html.toLowerCase();
  const platform = PLATFORMS.find(([, , re]) => re.test(lower));
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim().slice(0, 200);

  const nowYear = new Date().getFullYear();
  const years = [...html.matchAll(/(?:©|&copy;|copyright|\(c\))[^<]{0,40}?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi)]
    .flatMap((m) => [m[1], m[2]])
    .filter(Boolean)
    .map(Number)
    .filter((y) => y >= 1995 && y <= nowYear);

  return {
    finalUrl: finalUrl.toString(),
    https: finalUrl.protocol === "https:",
    mobile: /<meta[^>]+name=["']?viewport/i.test(html),
    title: title || undefined,
    platform: platform?.[0],
    builder: platform?.[1] ?? false,
    hasShop: SHOP.test(lower),
    hasBooking: BOOKING.test(lower),
    hasCrmWidget: CRM_WIDGET.test(lower),
    hasAnalytics: ANALYTICS.test(lower),
    lastYear: years.length ? Math.max(...years) : undefined,
    sizeKb: Math.round(html.length / 1024),
  };
}

export async function checkWebsite(website: string | null | undefined, fetcher: Fetcher = safeFetch): Promise<SiteCheck> {
  const checkedAt = new Date().toISOString();
  if (!website?.trim()) return { status: "no_site", checkedAt };

  const url = toUrl(website);
  if (!url) return { status: "unreachable", checkedAt, url: website, error: "Некорректный адрес" };
  if (SOCIAL_HOSTS.test(url.hostname)) return { status: "social_only", checkedAt, url: url.toString() };

  try {
    const { finalUrl, status, html } = await fetcher(url);
    if (SOCIAL_HOSTS.test(finalUrl.hostname)) return { status: "social_only", checkedAt, url: url.toString(), finalUrl: finalUrl.toString() };
    if (status >= 400 || !html) {
      return { status: "unreachable", checkedAt, url: url.toString(), finalUrl: finalUrl.toString(), httpStatus: status, error: status >= 400 ? `HTTP ${status}` : "Пустой ответ" };
    }
    return { status: "ok", checkedAt, url: url.toString(), httpStatus: status, ...analyzeHtml(html, finalUrl) };
  } catch (e) {
    if (e instanceof BlockedUrlError) return { status: "blocked", checkedAt, url: url.toString(), error: e.message };
    return { status: "unreachable", checkedAt, url: url.toString(), error: humanError(e) };
  }
}

function humanError(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 200);
  if (e.name === "TimeoutError" || e.name === "AbortError") return "не ответил за 8 секунд";
  const cause = (e.cause ?? {}) as { code?: string; message?: string };
  const code = cause.code ?? (e as Error & { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "домен не найден";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") return "сервер не отвечает";
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + (cause.message ?? ""))) return "ошибка SSL-сертификата";
  return (cause.message ?? e.message).slice(0, 200);
}

export type Opportunity = { level: "high" | "medium" | "low" | "unknown"; points: number; reasons: string[] };

const BOOKING_NICHES = /стомат|клиник|медицин|салон|барбер|парикмах|космет|массаж|автосервис|шиномонтаж|ветеринар|ветклиник|фитнес|спорт|йога|танц|школ|курс|репетит|психолог|юрид|нотари|фото|тату|ногт|маникюр|spa|спа/i;
const SHOP_NICHES = /магазин|гастроном|продукт|супермаркет|пекарн|кондитер|цвет|одежд|обув|мебел|строймат|автозапчаст|зоомагазин|аптек|опт|рознич|торгов/i;

/**
 * Насколько компания похожа на клиента: чем больше пробелов в онлайне, тем выше.
 * Причины сформулированы так, чтобы их можно было сказать в звонке.
 */
export function opportunity(check: SiteCheck | null | undefined, category?: string | null): Opportunity {
  if (!check) return { level: "unknown", points: 0, reasons: [] };
  const reasons: string[] = [];
  let points = 0;
  const add = (p: number, reason: string) => {
    points += p;
    reasons.push(reason);
  };
  const niche = category ?? "";

  switch (check.status) {
    case "no_site":
      add(60, "Нет сайта");
      break;
    case "social_only":
      add(50, "Вместо сайта — только соцсети/мессенджер");
      break;
    case "unreachable":
      add(45, `Сайт не открывается${check.error ? ` (${check.error})` : ""}`);
      break;
    case "blocked":
      return { level: "unknown", points: 0, reasons: ["Адрес сайта не удалось проверить"] };
    case "ok":
      if (check.builder) add(20, `Сайт на конструкторе${check.platform ? ` (${check.platform})` : ""}`);
      if (BOOKING_NICHES.test(niche) && !check.hasBooking) add(25, "На сайте не видно онлайн-записи");
      if (SHOP_NICHES.test(niche) && !check.hasShop) add(25, "На сайте не видно интернет-магазина");
      if (!check.mobile) add(15, "Сайт не адаптирован под телефоны");
      if (!check.https) add(10, "Нет HTTPS — браузер пишет «Не защищено»");
      if (check.lastYear && check.lastYear <= new Date().getFullYear() - 3) add(10, `Сайт не обновлялся с ${check.lastYear} года`);
      if (!check.hasCrmWidget) add(5, "Не видно онлайн-чата или CRM-форм");
      if (!check.hasAnalytics) add(5, "Не видно Яндекс Метрики");
      break;
  }

  const level = points >= 45 ? "high" : points >= 20 ? "medium" : "low";
  return { level, points, reasons };
}


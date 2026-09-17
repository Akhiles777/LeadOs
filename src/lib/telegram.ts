import { createHash } from "node:crypto";

/** Приводит текст к виду для сравнения: нижний регистр, ё→е, без лишних пробелов. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export type KeywordRules = { include: string[]; exclude: string[] };

export type FilterDecision =
  | { pass: true; matched: string[] }
  | { pass: false; reason: "too_short" | "excluded" | "no_keywords"; matched: string[] };

export const MIN_POST_LENGTH = 40;

/**
 * Решает, становится ли пост лидом.
 * Ключевые слова ищутся как подстроки: «разработ» поймает «разработка/разработчик», «next.js» — «Next.js».
 * Стоп-слова работают в обоих режимах; включающие — только в KEYWORDS (пустой список = пропускать всё).
 */
export function decide(text: string, rules: KeywordRules, mode: "KEYWORDS" | "ALL"): FilterDecision {
  const norm = normalizeText(text);
  if (norm.length < MIN_POST_LENGTH) return { pass: false, reason: "too_short", matched: [] };

  const excluded = rules.exclude.filter((w) => norm.includes(normalizeText(w)));
  if (excluded.length) return { pass: false, reason: "excluded", matched: excluded };

  if (mode === "ALL" || rules.include.length === 0) return { pass: true, matched: [] };
  const matched = rules.include.filter((w) => norm.includes(normalizeText(w)));
  return matched.length ? { pass: true, matched } : { pass: false, reason: "no_keywords", matched: [] };
}

/** Хэш «смысла» поста: без ссылок, упоминаний, эмодзи и пунктуации — чтобы репост в другом канале совпал. */
export function contentHash(text: string): string {
  const core = normalizeText(text)
    .replace(/https?:\/\/\S+|t\.me\/\S+/g, "")
    .replace(/@[\w\d_]+/g, "")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha256").update(core).digest("hex").slice(0, 32);
}

const NUM = String.raw`(\d{1,3}(?:[  .]\d{3})+|\d+(?:[.,]\d+)?)`;
const MULT = String.raw`(к|k|тыс\.?|тысяч[иа]?|т\.р\.?|млн)?`;
const CURRENCY = String.raw`(₽|руб(?:лей|\.)?|р\.|rub|rur)`;

function toRubles(num: string, mult: string | undefined): number | null {
  const n = Number(num.replace(/[  ]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const m = (mult ?? "").toLowerCase();
  const factor = m.startsWith("млн") ? 1_000_000 : m ? 1_000 : 1;
  return Math.round(n * factor);
}

/**
 * Достаёт бюджет из текста поста. Понимает «Бюджет: 50 000 ₽», «до 30к», «20-40 тыс руб», «оплата 15000р.».
 * Число без валюты берём только рядом со словом «бюджет/оплата/цена/стоимость/до».
 */
export function extractBudget(text: string): { min: number | null; max: number | null } {
  const found: number[] = [];
  const range = new RegExp(String.raw`${NUM}\s*${MULT}\s*[-–—]\s*${NUM}\s*${MULT}\s*${CURRENCY}?`, "giu");
  const withCurrency = new RegExp(String.raw`${NUM}\s*${MULT}\s*${CURRENCY}`, "giu");
  const afterWord = new RegExp(String.raw`(?:бюджет|оплата|цена|стоимость|вознаграждение|ставка)\s*[:\-–—]?\s*(?:до|от|около|~)?\s*${NUM}\s*${MULT}`, "giu");

  let min: number | null = null;
  let max: number | null = null;

  for (const m of text.matchAll(range)) {
    // «20-40к руб»: множитель второго числа относится и к первому.
    const hasContext = m[5] || m[4] || /бюджет|оплата|цена|стоимость/i.test(text.slice(Math.max(0, m.index - 30), m.index));
    if (!hasContext) continue;
    const a = toRubles(m[1], m[2] ?? m[4]);
    const b = toRubles(m[3], m[4]);
    if (a != null && b != null && a >= 500 && b >= a) {
      min = a;
      max = b;
      break;
    }
  }
  if (max == null) {
    for (const m of text.matchAll(withCurrency)) {
      const v = toRubles(m[1], m[2]);
      if (v != null) found.push(v);
    }
    for (const m of text.matchAll(afterWord)) {
      const v = toRubles(m[1], m[2]);
      if (v != null) found.push(v);
    }
    const plausible = found.filter((v) => v >= 500 && v <= 50_000_000);
    if (plausible.length) max = Math.max(...plausible);
  }
  return { min, max };
}

/** Контакт автора: первое @упоминание или t.me-ссылка на человека, но не на сам канал и не на пост. */
export function extractContact(text: string, channelUsername?: string | null): string | null {
  const own = channelUsername?.toLowerCase();
  const candidates = [
    ...[...text.matchAll(/(?:^|[^\w@/.])@([a-z][\w\d_]{3,31})\b/gi)].map((m) => m[1]),
    ...[...text.matchAll(/t\.me\/([a-z][\w\d_]{3,31})(?![\w/])/gi)].map((m) => m[1]),
  ];
  const hit = candidates.find((u) => u.toLowerCase() !== own && !/bot$/i.test(u));
  return hit ? `@${hit}` : null;
}

export function postTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/#[\p{L}\p{N}_]+/gu, " ") // хэштеги
          .replace(/\*\*|__|~~|`+|^\s*>\s*/g, " ") // разметка, но не _ внутри @логинов
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((l) => /[\p{L}\p{N}]{3}/u.test(l)) ?? "Пост из Telegram";
  // Длинная строка — берём первое предложение, если оно не слишком короткое.
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0];
  const title = firstLine.length > 80 && sentence.length >= 15 ? sentence : firstLine;
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}…` : title;
}

export function postLink(post: { id: number }, channel: { username?: string | null; peerId?: string | null }): string | null {
  if (channel.username) return `https://t.me/${channel.username}/${post.id}`;
  const internal = channel.peerId?.replace(/^-100/, "").replace(/^0+(?=\d)/, "");
  return internal ? `https://t.me/c/${internal}/${post.id}` : null;
}

/** Разбор ссылки/имени канала из формы: @name, name, t.me/name, t.me/s/name, t.me/name/123. */
export function parseChannelRef(input: string): { username: string } | { peerId: string } | { error: string } {
  const v = input.trim();
  if (/^-100\d{5,}$/.test(v)) return { peerId: v };
  if (/t\.me\/(\+|joinchat\/)/i.test(v)) {
    return { error: "Это инвайт-ссылка. Вступи в канал в Telegram и выбери его из списка «Мои каналы»." };
  }
  if (/t\.me\/c\//i.test(v)) return { error: "Ссылка на приватный канал — выбери его из списка «Мои каналы»." };
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([a-z][\w\d_]{3,31})(?:\/\d+)?\/?$/i) ?? v.match(/^@?([a-z][\w\d_]{3,31})$/i);
  return m ? { username: m[1].toLowerCase() } : { error: "Не понял канал. Формат: @username или https://t.me/username" };
}

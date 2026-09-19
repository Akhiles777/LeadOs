/**
 * Сопоставление колонок таблицы с полями LeadOS и нормализация значений. Чистые функции — scripts/import-check.ts.
 */
import type { LeadStatus, Source } from "@/generated/prisma/enums";
import { normalizePhone } from "@/lib/lead-input";
import { FUNNEL_STAGES } from "@/lib/leads";
import { dayKey, zonedTime } from "@/lib/time";

export const IMPORT_FIELDS = {
  title: { label: "Клиент / название *", aliases: ["клиент", "название", "заказчик", "компания", "проект", "заказ", "лид", "client", "name", "company", "title", "project"] },
  contactName: { label: "Контактное лицо", aliases: ["контакт", "контактное лицо", "имя", "фио", "contact", "person"] },
  contactPhone: { label: "Телефон", aliases: ["телефон", "тел", "phone", "мобильный"] },
  contactEmail: { label: "Email", aliases: ["email", "e-mail", "почта", "mail"] },
  contactTg: { label: "Telegram", aliases: ["telegram", "телеграм", "тг", "tg"] },
  website: { label: "Сайт", aliases: ["сайт", "website", "url", "site"] },
  category: { label: "Ниша / категория", aliases: ["ниша", "категория", "сфера", "отрасль", "category", "niche", "тип"] },
  region: { label: "Город / регион", aliases: ["город", "регион", "city", "region"] },
  source: { label: "Источник", aliases: ["источник", "откуда", "канал", "source", "площадка"] },
  status: { label: "Статус", aliases: ["статус", "этап", "status", "stage", "результат"] },
  amount: { label: "Сумма сделки", aliases: ["сумма", "стоимость", "цена", "бюджет", "чек", "amount", "price", "total", "договор"] },
  paid: { label: "Оплачено (сумма или да/нет)", aliases: ["оплачено", "оплата", "получено", "paid"] },
  tips: { label: "Чаевые", aliases: ["чаевые", "tips", "tip", "бонус"] },
  date: { label: "Дата (обращения или сделки)", aliases: ["дата", "date", "создан", "дата обращения", "created"] },
  closedAt: { label: "Дата закрытия / сдачи", aliases: ["дата закрытия", "закрыт", "сдан", "дата сдачи", "closed", "дата оплаты"] },
  referredBy: { label: "Кто порекомендовал (клиент из базы)", aliases: ["кто порекомендовал", "рекомендатель", "referred"] },
  notes: { label: "Описание / комментарий", aliases: ["описание", "комментарий", "заметки", "что делали", "задача", "notes", "comment", "description"] },
} as const;

export type ImportField = keyof typeof IMPORT_FIELDS;
export type ColumnMapping = Partial<Record<ImportField, number>>;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Угадывает колонки по заголовкам: точное совпадение важнее вхождения, одна колонка — одно поле. */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const normalized = headers.map(norm);
  for (const pass of ["exact", "contains"] as const) {
    for (const field of Object.keys(IMPORT_FIELDS) as ImportField[]) {
      if (mapping[field] != null) continue;
      const aliases = IMPORT_FIELDS[field].aliases.map(norm);
      const index = normalized.findIndex((h, i) => !used.has(i) && h && aliases.some((a) => (pass === "exact" ? h === a : h.includes(a))));
      if (index >= 0) {
        mapping[field] = index;
        used.add(index);
      }
    }
  }
  return mapping;
}

export function parseAmount(raw: string): number | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const k = /\d\s*(к|k|тыс)/.test(v);
  const cleaned = v.replace(/(руб(лей|\.)?|р\.|₽|rub|к|k|тыс\.?)/g, "").replace(/[\s ]/g, "");
  // «1.234.567», «1 234,50», «1234.5»
  const num = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned) ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(",", ".");
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(k ? n * 1000 : n);
}

/** Даты из таблиц: 17.09.2026, 17.09.26, 2026-09-17, 17/09/2026, серийный номер Excel. Время дня — полдень в поясе приложения. */
export function parseTableDate(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;
  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(v);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(year, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    // Excel: дни с 30.12.1899
    const days = Math.floor(Number(v));
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
    return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

function valid(year: number, month: number, day: number): Date | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = zonedTime(year, month, day, 12);
  return dayKey(d) === `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` ? d : null;
}

const STATUS_WORDS: [LeadStatus, RegExp][] = [
  ["LOST", /отказ|проигр|отмен|не интерес|слил|lost|cancel|declin/],
  ["SKIPPED", /пропущ|skip/],
  ["WON", /выигр|оплач|сдан|заверш|готов|закрыт|в работе|выполн|won|done|paid|complete|успе/],
  ["NEGOTIATING", /переговор|обсужд|согласов|negotiat/],
  ["RESPONDED", /ответил|ответ|respond|replied/],
  ["CONTACTED", /контакт|написал|звонил|отправил|contact/],
  ["QUALIFIED", /квалиф|интерес|qualif/],
  ["NEW", /нов|new/],
];

export function parseStatus(raw: string): LeadStatus | null {
  const v = norm(raw);
  if (!v) return null;
  return STATUS_WORDS.find(([, re]) => re.test(v))?.[0] ?? null;
}

export function parseSource(raw: string): Source | null {
  const v = norm(raw);
  if (!v) return null;
  if (/kwork|кворк/.test(v)) return "KWORK";
  if (/telegram|телеграм|(?<!\p{L})тг(?!\p{L})|tg/u.test(v)) return "TELEGRAM";
  if (/рекоменд|знаком|сарафан|referr|друг/.test(v)) return "REFERRAL";
  if (/холод|звон|карт|2гис|2gis|яндекс|cold/.test(v)) return "COLD_LOCAL";
  return "MANUAL";
}

/** «да», «+», «оплачено» → весь договор; число → сумма; «нет» и пусто → ничего. */
export function parsePaid(raw: string, amount: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === "+" || trimmed === "✓" || trimmed === "✔") return amount;
  const v = norm(raw);
  if (!v || /^(нет|no|0)$/.test(v) || /не оплач/.test(v)) return null;
  if (/^(да|yes|1|true|оплачено|оплачен|полностью|paid)$/.test(v)) return amount;
  if (/частич/.test(v)) return null;
  return parseAmount(raw);
}

/** Для импортированного лида: «дошёл до этапа» по статусу. Отказ считаем после контакта. */
export function stageForStatus(status: LeadStatus): number {
  if (status === "LOST") return FUNNEL_STAGES.indexOf("CONTACTED");
  if (status === "SKIPPED") return 0;
  return Math.max(0, FUNNEL_STAGES.indexOf(status));
}

export type ImportOptions = { defaultSource: Source; defaultStatus: LeadStatus; wonArePaid: boolean };

export type ImportRecord = {
  row: number; // номер строки в файле (с 2 — после заголовка)
  title: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactTg: string | null;
  website: string | null;
  category: string | null;
  region: string | null;
  source: Source;
  status: LeadStatus;
  amount: number | null;
  paid: number | null;
  tips: number | null;
  createdAt: Date | null;
  closedAt: Date | null;
  notes: string;
  referredByTitle: string | null;
  warnings: string[];
  error: string | null;
};

const cut = (s: string | undefined, max: number) => (s ?? "").trim().slice(0, max) || null;

export function buildRecords(rows: string[][], mapping: ColumnMapping, options: ImportOptions, firstRowNumber = 2): ImportRecord[] {
  return rows.map((cells, i) => {
    const get = (f: ImportField) => (mapping[f] != null ? (cells[mapping[f]!] ?? "") : "");
    const warnings: string[] = [];

    const rawStatus = get("status");
    const status = parseStatus(rawStatus) ?? options.defaultStatus;
    if (rawStatus && !parseStatus(rawStatus)) warnings.push(`статус «${rawStatus}» не распознан — ${status}`);

    const amount = parseAmount(get("amount"));
    if (get("amount") && amount == null) warnings.push(`сумма «${get("amount")}» не распознана`);

    const rawDate = get("date");
    const date = parseTableDate(rawDate);
    if (rawDate && !date) warnings.push(`дата «${rawDate}» не распознана`);
    const rawClosed = get("closedAt");
    const closed = parseTableDate(rawClosed);
    if (rawClosed && !closed) warnings.push(`дата закрытия «${rawClosed}» не распознана`);

    let paid = mapping.paid != null ? parsePaid(get("paid"), amount) : null;
    if (paid == null && mapping.paid == null && status === "WON" && options.wonArePaid) paid = amount;
    if (paid != null && amount != null && paid > amount) warnings.push("оплачено больше суммы сделки");

    const phoneRaw = cut(get("contactPhone"), 100);
    const title = cut(get("title"), 300) ?? cut(get("contactName"), 300) ?? phoneRaw;

    return {
      row: firstRowNumber + i,
      title: title ?? "",
      contactName: cut(get("contactName"), 200),
      contactPhone: phoneRaw ? normalizePhone(phoneRaw) : null,
      contactEmail: cut(get("contactEmail"), 200)?.toLowerCase() ?? null,
      contactTg: cut(get("contactTg"), 100),
      website: cut(get("website"), 500),
      category: cut(get("category"), 200),
      region: cut(get("region"), 200),
      source: mapping.source != null ? (parseSource(get("source")) ?? options.defaultSource) : options.defaultSource,
      status,
      amount,
      paid,
      tips: parseAmount(get("tips")),
      createdAt: date ?? closed,
      closedAt: status === "WON" ? (closed ?? date) : null,
      notes: (get("notes") ?? "").slice(0, 5000),
      referredByTitle: cut(get("referredBy"), 300),
      warnings,
      error: title ? null : "нет названия клиента",
    };
  });
}

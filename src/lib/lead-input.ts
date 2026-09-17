import { z } from "zod";
import { MAX_RAW_TEXT, SOURCE_ORDER } from "@/lib/leads";
import { parseDateInput } from "@/lib/time";
import type { Source } from "@/generated/prisma/enums";

const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max, `Слишком длинное значение (макс. ${max})`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

/** Сумма: «50 000», «до 50000 ₽», «50к» → 50000. */
export const optInt = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const compact = v.replace(/^(от|до)\s*/i, "").replace(/[\s\u00a0₽]|руб\.?/gi, "").replace(",", ".");
    const k = /[кk]$/i.test(compact);
    const n = Number(k ? compact.slice(0, -1) : compact) * (k ? 1000 : 1);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: "custom", message: "Сумма должна быть неотрицательным числом" });
      return z.NEVER;
    }
    return Math.round(n);
  })
  .nullable()
  .default(null);

/** Российский номер → «+7 XXX XXX-XX-XX», чтобы одна компания с Яндекс Карт и 2GIS совпала по телефону. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!national || !/^[3489]/.test(national)) return raw.trim();
  return `+7 ${national.slice(0, 3)} ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`;
}

const optPhone = optText(100).transform((v) => (v ? normalizePhone(v) : v));

const optWebsite = optText(1000).transform((v, ctx) => {
  if (!v) return v;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) throw new Error();
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|yclid$|gclid$|fbclid$|_openstat$|from$)/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch {
    ctx.addIssue({ code: "custom", message: "Некорректный адрес сайта" });
    return z.NEVER;
  }
});

export const optDate = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const d = parseDateInput(v) ?? new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Некорректная дата" });
      return z.NEVER;
    }
    return d;
  })
  .nullable()
  .default(null);

const leadSchema = z
  .object({
    source: z.enum(SOURCE_ORDER as [Source, ...Source[]], { message: "Неизвестный источник" }),
    title: z.string().trim().min(1, "Нужен заголовок").max(300, "Заголовок длиннее 300 символов"),
    rawText: z.string().trim().max(MAX_RAW_TEXT, `Текст длиннее ${MAX_RAW_TEXT} символов`).default(""),
    sourceRef: optText(1000),
    category: optText(),
    budgetMin: optInt,
    budgetMax: optInt,
    contactName: optText(),
    contactPhone: optPhone,
    contactTg: optText(),
    contactEmail: optText(),
    website: optWebsite,
    referredById: optText(40),
    region: optText(),
    followUpAt: optDate,
  })
  .refine((v) => v.budgetMin == null || v.budgetMax == null || v.budgetMin <= v.budgetMax, {
    message: "Минимальный бюджет больше максимального",
  });

export type LeadInput = z.output<typeof leadSchema>;

/**
 * Разбирает поля лида из формы или JSON. Всё приводится к строкам, чтобы форма и API
 * проходили через одни и те же правила (включая разбор сумм вида «50 000 ₽»).
 */
export function parseLeadInput(
  input: Record<string, unknown>,
): { data: LeadInput } | { error: string; field?: string } {
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") strings[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) strings[k] = String(v);
  }
  const parsed = leadSchema.safeParse(strings);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Некорректные данные", field: issue?.path.join(".") || undefined };
  }
  return { data: parsed.data };
}

export function formToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !k.startsWith("$")) out[k] = v;
  return out;
}

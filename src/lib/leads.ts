import type { ActivityType, LeadStatus, Source } from "@/generated/prisma/enums";
import { APP_TIMEZONE } from "@/lib/time";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "Новый",
  QUALIFIED: "Квалифицирован",
  CONTACTED: "Контакт",
  RESPONDED: "Ответил",
  NEGOTIATING: "Переговоры",
  WON: "Выигран",
  LOST: "Проигран",
  SKIPPED: "Пропущен",
};

export const STATUS_ORDER: LeadStatus[] = [
  "NEW",
  "QUALIFIED",
  "CONTACTED",
  "RESPONDED",
  "NEGOTIATING",
  "WON",
  "LOST",
  "SKIPPED",
];

/** Этапы воронки по порядку; индекс хранится в Lead.furthestStage. */
export const FUNNEL_STAGES: LeadStatus[] = ["NEW", "QUALIFIED", "CONTACTED", "RESPONDED", "NEGOTIATING", "WON"];

export const CLOSED_STATUSES: LeadStatus[] = ["WON", "LOST", "SKIPPED"];

/** Статусы, в которых лид «ждёт движения» и может зависнуть. */
export const STALE_STATUSES: LeadStatus[] = ["CONTACTED", "NEGOTIATING"];

export const STATUS_TONE: Record<LeadStatus, string> = {
  NEW: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  QUALIFIED: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  CONTACTED: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  RESPONDED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  NEGOTIATING: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  WON: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  LOST: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  SKIPPED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

export const SOURCE_LABEL: Record<Source, string> = {
  KWORK: "Kwork",
  TELEGRAM: "Telegram",
  COLD_LOCAL: "Холодный (локальный)",
  MANUAL: "Ручной ввод",
  REFERRAL: "Рекомендация",
};

export const MAX_RAW_TEXT = 20_000;

export const SOURCE_ORDER: Source[] = ["KWORK", "TELEGRAM", "COLD_LOCAL", "MANUAL", "REFERRAL"];

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  NOTE: "Заметка",
  CALL: "Звонок",
  MESSAGE_SENT: "Отправлено сообщение",
  MESSAGE_RECEIVED: "Получен ответ",
  STATUS_CHANGE: "Смена статуса",
  FOLLOW_UP_DUE: "Follow-up",
};

/** Типы активностей, которые можно добавить вручную. */
export const MANUAL_ACTIVITY_TYPES: ActivityType[] = ["NOTE", "CALL", "MESSAGE_SENT", "MESSAGE_RECEIVED"];

export function staleDays(): number {
  const n = Number(process.env.STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export function isStatus(v: unknown): v is LeadStatus {
  return typeof v === "string" && (STATUS_ORDER as string[]).includes(v);
}

export function isSource(v: unknown): v is Source {
  return typeof v === "string" && (SOURCE_ORDER as string[]).includes(v);
}

export function formatBudget(min: number | null, max: number | null): string {
  const fmt = (n: number) => n.toLocaleString("ru-RU");
  if (min != null && max != null) return min === max ? `${fmt(min)} ₽` : `${fmt(min)}–${fmt(max)} ₽`;
  if (min != null) return `от ${fmt(min)} ₽`;
  if (max != null) return `до ${fmt(max)} ₽`;
  return "—";
}

export function formatDate(d: Date, withTime = false): string {
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: APP_TIMEZONE,
  });
}

export function daysSince(d: Date, now = new Date()): number {
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

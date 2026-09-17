/**
 * Время приложения. Сервер может жить в UTC (Vercel) или в другом поясе (VPS) — все «календарные» вещи
 * (сегодня, месяц, дата в форме) считаем в APP_TIMEZONE, по умолчанию Москва.
 */

function resolveZone(): string {
  const zone = process.env.APP_TIMEZONE?.trim() || "Europe/Moscow";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "Europe/Moscow";
  }
}

export const APP_TIMEZONE = resolveZone();

function parts(date: Date): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const out = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return out as ReturnType<typeof parts>;
}

/** Смещение пояса относительно UTC в миллисекундах в момент date. */
function offsetMs(date: Date): number {
  const p = parts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Момент, когда в поясе приложения наступает указанная дата и время. */
export function zonedTime(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const first = new Date(guess.getTime() - offsetMs(guess));
  // второй проход — на случай перехода смещения между guess и результатом
  return new Date(guess.getTime() - offsetMs(first));
}

/** YYYY-MM-DD в поясе приложения — для <input type="date"> и ключей дней. */
export function dayKey(date: Date): string {
  const p = parts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dateInputValue(date: Date | null | undefined): string {
  return date ? dayKey(date) : "";
}

/** Дата из <input type="date"> — полдень этого дня в поясе приложения, чтобы никакой пояс не сдвинул день. */
export function parseDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), 12);
}

export function monthStart(date = new Date()): Date {
  const p = parts(date);
  return zonedTime(p.year, p.month, 1);
}

export function hourInZone(date = new Date()): number {
  return parts(date).hour;
}

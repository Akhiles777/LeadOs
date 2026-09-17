import { after } from "next/server";

/**
 * Где нет постоянного воркера (Vercel), задачи из очереди выполняются сразу после ответа на запрос,
 * в пределах лимита времени функции. На VPS с pnpm worker:ai это выключено — задачи берёт воркер.
 */
export function inlineJobsEnabled(): boolean {
  if (process.env.AI_INLINE_JOBS === "false") return false;
  return process.env.AI_INLINE_JOBS === "true" || Boolean(process.env.VERCEL);
}

const INLINE_BUDGET_MS = 240_000;

/**
 * Для Vercel: если в очереди что-то ждёт (например, cron не успел или запрос оборвался), досчитать после показа страницы.
 * Так очередь движется при каждом заходе на дашборд, а не раз в сутки.
 */
export async function drainIfPending() {
  if (!inlineJobsEnabled()) return;
  const { db } = await import("@/lib/db");
  const waiting = await db.aiJob.count({ where: { status: "PENDING", runAfter: { lte: new Date() } } });
  if (waiting > 0) drainQueueAfterResponse();
}

export function drainQueueAfterResponse() {
  // Без ключа Claude очередь всё равно нужна: проверка сайтов найденных компаний идёт через неё.
  if (!inlineJobsEnabled()) return;
  try {
    after(async () => {
      const { drainQueue } = await import("@/ai/runner");
      await drainQueue(INLINE_BUDGET_MS);
    });
  } catch {
    // Вне запроса (скрипты, воркер) after недоступен — задачу заберёт воркер или ежедневный cron.
  }
}

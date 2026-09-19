import { isAiConfigured } from "@/ai/client";
import { DIGEST_HOUR_MSK, drainQueue, scheduleDueJobs } from "@/ai/runner";
import { db } from "@/lib/db";
import { sendDailyNotification } from "@/lib/notify";
import { hourInZone } from "@/lib/time";

export type DailyReport = { jobs: number; notification: string; aiConfigured: boolean };

/**
 * Ежедневные дела: поставить дайджест и follow-up, выполнить очередь в пределах бюджета, отправить утреннюю сводку.
 * Вызывается cron-ом Vercel (/api/cron/daily) и воркером на VPS. Повторный вызов в тот же день безопасен.
 */
export async function runDailyTasks(budgetMs: number, now = new Date()): Promise<DailyReport> {
  const aiConfigured = isAiConfigured();
  let jobs = 0;
  if (aiConfigured) {
    await scheduleDueJobs(now, { forceDigest: true });
  }
  jobs = await drainQueue(budgetMs);
  const notification = await sendDailyNotification(now).catch((e) => `error: ${e instanceof Error ? e.message : e}`);
  return { jobs, notification, aiConfigured };
}

/** Для воркера: сводку отправляем после часа дайджеста, когда дайджест готов или его задача завершилась. */
export async function maybeSendDailyFromWorker(now = new Date()) {
  if (hourInZone(now) < DIGEST_HOUR_MSK) return;
  if (isAiConfigured()) {
    const pendingDigest = await db.aiJob.findFirst({ where: { type: "DIGEST", status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
    if (pendingDigest) return;
  }
  await sendDailyNotification(now);
}

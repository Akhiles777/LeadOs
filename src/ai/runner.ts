import type { AiJob } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { staleDays } from "@/lib/leads";
import { hourInZone } from "@/lib/time";
import { AiApiError, AiNotConfiguredError, AiResponseError } from "@/ai/client";
import { claimJob, completeJob, enqueue, failJob } from "@/ai/jobs";
import { assessLead } from "@/ai/tasks/assess";
import { buildDigest, moscowDay } from "@/ai/tasks/digest";
import { generateDraft } from "@/ai/tasks/drafts";
import { notifyHotLead } from "@/lib/notify";
import { checkLeadWebsite } from "@/lib/site-check-service";

export async function runJob(job: AiJob): Promise<void> {
  switch (job.type) {
    case "SCORE_LEAD":
      if (!job.leadId) throw new AiResponseError("Нет leadId");
      await assessLead(job.leadId);
      // Уведомление не должно проваливать оценку: ошибка Telegram только логируется.
      await notifyHotLead(job.leadId).catch((e) => console.error("Уведомление о горячем лиде не ушло", e));
      return;
    case "FOLLOW_UP":
      if (!job.leadId) throw new AiResponseError("Нет leadId");
      await generateDraft(job.leadId, "follow_up");
      return;
    case "SITE_CHECK":
      if (!job.leadId) throw new AiResponseError("Нет leadId");
      await checkLeadWebsite(job.leadId);
      return;
    case "COLD_OFFER":
      if (!job.leadId) throw new AiResponseError("Нет leadId");
      // Скрипт звонка опирается на проверку сайта, поэтому задача ставится после неё.
      await generateDraft(job.leadId, "cold_call_script");
      return;
    case "DIGEST":
      await buildDigest();
      return;
  }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof AiNotConfiguredError) return false;
  if (e instanceof AiApiError) return e.status === undefined || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  if (e instanceof AiResponseError) return true; // обрезанный или кривой ответ — попробуем ещё раз
  if (e instanceof Error && /No record was found|Record to update not found/i.test(e.message)) return false; // лид удалили
  return true;
}

/** Выполняет задачи, пока есть время: для cron и выполнения после ответа на Vercel. Возвращает число задач. */
export async function drainQueue(budgetMs: number, concurrency = 2): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let done = 0;
  const lane = async () => {
    // Одна AI-задача может идти около минуты — новую не берём, если до конца бюджета меньше 70 секунд.
    while (Date.now() < deadline - 70_000) {
      if (!(await processNextJob())) return;
      done++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return done;
}

/** Выполняет одну задачу из очереди. Возвращает false, если очередь пуста. */
export async function processNextJob(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    await runJob(job);
    await completeJob(job.id);
  } catch (e) {
    await failJob(job, e, isRetryable(e));
  }
  return true;
}

export const DIGEST_HOUR_MSK = Number(process.env.DIGEST_HOUR ?? 8);

const moscowHour = (date: Date) => hourInZone(date);

/** Плановые задачи: утренний дайджест и черновики follow-up для зависших лидов. Идемпотентно — можно звать каждую минуту. */
export async function scheduleDueJobs(now = new Date(), opts: { forceDigest?: boolean } = {}) {
  if (opts.forceDigest || moscowHour(now) >= DIGEST_HOUR_MSK) {
    const today = moscowDay(now);
    const [digest, pending] = await Promise.all([
      db.digest.findUnique({ where: { day: today }, select: { id: true } }),
      db.aiJob.findFirst({ where: { type: "DIGEST", createdAt: { gte: new Date(now.getTime() - 20 * 3_600_000) } }, select: { id: true } }),
    ]);
    if (!digest && !pending) await enqueue("DIGEST");
  }

  // Зависшие: в ожидании ответа дольше STALE_DAYS и без свежего черновика follow-up.
  const threshold = new Date(now.getTime() - staleDays() * 86_400_000);
  const stale = await db.lead.findMany({
    where: { status: { in: ["CONTACTED", "NEGOTIATING"] }, lastActivityAt: { lt: threshold } },
    select: { id: true, lastActivityAt: true, offers: { where: { channel: "follow_up" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
    take: 50,
  });
  for (const lead of stale) {
    const lastDraft = lead.offers[0]?.createdAt;
    if (!lastDraft || lastDraft < lead.lastActivityAt) await enqueue("FOLLOW_UP", lead.id);
  }
}

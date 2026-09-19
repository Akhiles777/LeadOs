import type { AiJob, AiJobType } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isAiConfigured } from "@/ai/client";

const MAX_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 10 * 60_000;

export function autoScoreEnabled(): boolean {
  return isAiConfigured() && process.env.AI_AUTO_SCORE !== "false";
}

/** Ставит задачу, если такой же ещё не ждёт выполнения. */
export async function enqueue(type: AiJobType, leadId: string | null = null, runAfter = new Date()) {
  const existing = await db.aiJob.findFirst({ where: { type, leadId, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
  if (existing) return existing;
  return db.aiJob.create({ data: { type, leadId, runAfter }, select: { id: true } });
}

/** Задачи, которым не нужна модель: их выполняем даже без ключа RouterAI. */
const NON_AI_TYPES: AiJobType[] = ["SITE_CHECK"];

/** Забирает одну задачу. SKIP LOCKED — несколько воркеров не возьмут одну и ту же. Зависшие RUNNING возвращаются в работу. */
export async function claimJob(): Promise<AiJob | null> {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
  // Без ключа RouterAI берём только задачи, которым модель не нужна, — иначе они бы падали по кругу.
  const types: AiJobType[] = isAiConfigured() ? ["SCORE_LEAD", "FOLLOW_UP", "DIGEST", "SITE_CHECK", "COLD_OFFER"] : NON_AI_TYPES;
  const rows = await db.$queryRaw<AiJob[]>`
    UPDATE "AiJob" SET status = 'RUNNING', "lockedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "AiJob"
      WHERE type::text = ANY(${types.map(String)}::text[])
        AND ((status = 'PENDING' AND "runAfter" <= now())
          OR (status = 'RUNNING' AND "lockedAt" < ${staleBefore}))
      ORDER BY "runAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

export async function completeJob(id: string) {
  await db.aiJob.update({ where: { id }, data: { status: "DONE", finishedAt: new Date(), error: null, lockedAt: null } });
}

/** Ошибка: повтор с нарастающей паузой (1, 5 мин), после трёх попыток — FAILED. Невосстановимые ошибки сразу FAILED. */
export async function failJob(job: AiJob, error: unknown, retryable = true) {
  const message = error instanceof Error ? error.message : String(error);
  const final = !retryable || job.attempts >= MAX_ATTEMPTS;
  const delayMin = job.attempts <= 1 ? 1 : 5;
  await db.aiJob.update({
    where: { id: job.id },
    data: {
      status: final ? "FAILED" : "PENDING",
      error: message.slice(0, 2000),
      lockedAt: null,
      runAfter: final ? undefined : new Date(Date.now() + delayMin * 60_000),
      finishedAt: final ? new Date() : null,
    },
  });
}

export async function retryFailedJobs() {
  return db.aiJob.updateMany({ where: { status: "FAILED" }, data: { status: "PENDING", attempts: 0, runAfter: new Date(), error: null, finishedAt: null } });
}

import type { AiJob, AiJobType } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { aiBlockedReason, isAiConfigured } from "@/ai/client";

const MAX_ATTEMPTS = 3;

/** Задача пока не может выполняться (ждёт другую) — вернуть в очередь без траты попытки. */
export class DeferJobError extends Error {
  constructor(public delayMs: number) {
    super("Отложено: ждёт другие задачи по этому лиду");
  }
}

export async function deferJob(job: AiJob, delayMs: number) {
  await db.aiJob.update({
    where: { id: job.id },
    data: { status: "PENDING", lockedAt: null, attempts: { decrement: 1 }, runAfter: new Date(Date.now() + delayMs) },
  });
}

/** Автоматический поиск контактов через веб-поиск платный (≈1–2 ₽ за компанию) — включается только явно. */
export function contactSearchEnabled(): boolean {
  return isAiConfigured() && process.env.AI_FIND_CONTACTS === "true";
}
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
const ALL_TYPES: AiJobType[] = ["SCORE_LEAD", "FOLLOW_UP", "DIGEST", "SITE_CHECK", "COLD_OFFER", "FIND_CONTACTS"];

/** Забирает одну задачу. SKIP LOCKED — несколько воркеров не возьмут одну и ту же. Зависшие RUNNING возвращаются в работу. */
export async function claimJob(): Promise<AiJob | null> {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
  // Без ключа RouterAI берём только задачи, которым модель не нужна, — иначе они бы падали по кругу.
  // Бюджет исчерпан или RouterAI поставил на паузу — бесплатные задачи (проверка сайта) продолжают работать.
  const types: AiJobType[] = isAiConfigured() && !(await aiBlockedReason()) ? ALL_TYPES : NON_AI_TYPES;
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

/**
 * Повтор упавших задач. Платные массовые задачи (оффер, поиск контактов) не повторяются скопом —
 * иначе одна кнопка может потратить недельный бюджет. Их запускают из карточки компании.
 */
export async function retryFailedJobs() {
  return db.aiJob.updateMany({
    where: { status: "FAILED", type: { notIn: ["COLD_OFFER", "FIND_CONTACTS"] } },
    data: { status: "PENDING", attempts: 0, runAfter: new Date(), error: null, finishedAt: null },
  });
}

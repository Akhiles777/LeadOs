/**
 * AI-воркер: pnpm worker:ai
 * Берёт задачи из таблицы AiJob (оценка новых лидов, follow-up, дайджест) и раз в минуту ставит плановые.
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { AI_MODEL, isAiConfigured } from "@/ai/client";
import { processNextJob, scheduleDueJobs } from "@/ai/runner";
import { maybeSendDailyFromWorker } from "@/lib/daily";

const CONCURRENCY = Math.max(1, Number(process.env.AI_WORKER_CONCURRENCY ?? 2));
const IDLE_MS = 5_000;
const SCHEDULE_EVERY_MS = 60_000;

let stopping = false;
const wakeups = new Set<() => void>();
/** Пауза, которая прерывается сигналом остановки. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeups.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeups.add(done);
  });

async function heartbeat() {
  const info = { model: AI_MODEL, concurrency: CONCURRENCY, configured: isAiConfigured() };
  await db.workerHeartbeat.upsert({ where: { name: "ai" }, create: { name: "ai", info }, update: { seenAt: new Date(), info } });
}

async function lane(n: number) {
  while (!stopping) {
    if (!isAiConfigured()) {
      await sleep(SCHEDULE_EVERY_MS);
      continue;
    }
    try {
      const worked = await processNextJob();
      if (!worked) await sleep(IDLE_MS);
    } catch (e) {
      console.error(`[lane ${n}] ошибка очереди`, e);
      await sleep(IDLE_MS);
    }
  }
}

async function scheduler() {
  while (!stopping) {
    try {
      await heartbeat();
      if (isAiConfigured()) await scheduleDueJobs();
      await maybeSendDailyFromWorker().catch((e) => console.error("[daily] сводка не ушла", e));
    } catch (e) {
      console.error("[scheduler]", e);
    }
    await sleep(SCHEDULE_EVERY_MS);
  }
}

async function main() {
  if (!isAiConfigured()) {
    console.error("ANTHROPIC_API_KEY не задан — воркер ждёт и ничего не выполняет. См. docs/INSTRUCTIONS.md");
  }
  console.log(`AI-воркер запущен: модель ${AI_MODEL}, параллельно ${CONCURRENCY}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      console.log("Останавливаюсь после текущих задач…");
      for (const wake of [...wakeups]) wake();
    });
  }
  await Promise.all([scheduler(), ...Array.from({ length: CONCURRENCY }, (_, i) => lane(i + 1))]);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

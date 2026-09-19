import { isAiConfigured } from "@/ai/client";
import { drainQueue, scheduleDueJobs } from "@/ai/runner";
import { checkCron } from "@/lib/cron-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Досчитать очередь AI. На Vercel Hobby cron можно вызывать только раз в день — там задачи выполняются сразу после запроса,
 * а этот маршрут — для Pro (например, каждые 15 минут) или для внешнего планировщика.
 */
export async function GET(request: Request) {
  if (!checkCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const aiConfigured = isAiConfigured();
  if (aiConfigured) await scheduleDueJobs();
  const jobs = await drainQueue(240_000);
  return Response.json({ jobs, aiConfigured });
}

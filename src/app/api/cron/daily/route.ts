import { checkCron } from "@/lib/cron-auth";
import { runDailyTasks } from "@/lib/daily";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Раз в день (vercel.json): дайджест, follow-up, очередь AI, утренняя сводка в Telegram. */
export async function GET(request: Request) {
  if (!checkCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const report = await runDailyTasks(240_000);
  return Response.json(report);
}

import { resolveDatabaseUrl } from "@/lib/database-url";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Проверка для мониторинга и диагностики. Наружу — только короткая причина без адресов и паролей,
 * подробности пишутся в логи сервера (на Vercel — вкладка Logs).
 */
const REASONS: [RegExp, string][] = [
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "host_not_found"],
  [/28P01|password authentication failed/i, "bad_credentials"],
  [/3D000|database .* does not exist/i, "database_not_found"],
  [/SSL|certificate/i, "ssl_error"],
  [/too many connections|53300/i, "too_many_connections"],
  [/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|connect/i, "connection_failed"],
];

export async function GET() {
  if (!resolveDatabaseUrl()) {
    console.error("[health] Не найден адрес базы: задай DATABASE_URL");
    return Response.json({ ok: false, reason: "no_database_url" }, { status: 503 });
  }

  try {
    // Подключение может быть живым, а таблиц ещё нет — это разные проблемы с разными решениями.
    const [row] = await db.$queryRaw<{ leads: string | null }[]>`SELECT to_regclass('public."Lead"')::text AS leads`;
    if (!row?.leads) {
      console.error("[health] База отвечает, но таблиц нет — не применены миграции (pnpm build:vercel / db:deploy)");
      return Response.json({ ok: false, reason: "no_tables" }, { status: 503 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? `${e.message} ${JSON.stringify((e as { cause?: unknown }).cause ?? "")}` : String(e);
    const reason = REASONS.find(([re]) => re.test(message))?.[1] ?? "query_failed";
    console.error(`[health] База недоступна (${reason}):`, message.slice(0, 500));
    return Response.json({ ok: false, reason }, { status: 503 });
  }
}

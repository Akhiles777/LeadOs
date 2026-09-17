import { connection } from "next/server";
import { isAiConfigured } from "@/ai/client";
import { inlineJobsEnabled } from "@/ai/inline";
import { resolveDatabaseUrl } from "@/lib/database-url";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/leads";
import { getNotificationSettings } from "@/lib/notify/settings";
import { botConfigured } from "@/lib/notify/telegram-bot";
import { APP_TIMEZONE } from "@/lib/time";
import { ConnectChat, NotificationToggles, PreviewDaily } from "@/components/settings-controls";
import { Card, PageHeader } from "@/components/ui";

type Check = { label: string; ok: boolean; hint: string; required: boolean };

function environmentChecks(): Check[] {
  const vercel = Boolean(process.env.VERCEL);
  const prod = process.env.NODE_ENV === "production";
  const has = (k: string, min = 1) => (process.env[k]?.trim().length ?? 0) >= min;
  return [
    { label: "База данных", ok: Boolean(resolveDatabaseUrl()), hint: "DATABASE_URL (подходят и переменные интеграции: POSTGRES_URL, PRISMA_DATABASE_URL)", required: true },
    { label: "Пароль на вход", ok: has("BASIC_AUTH_USER") && has("BASIC_AUTH_PASSWORD", 12), hint: "BASIC_AUTH_USER и BASIC_AUTH_PASSWORD (не короче 12 символов)", required: prod },
    { label: "Публичный адрес", ok: has("APP_URL"), hint: "APP_URL — ссылки в уведомлениях, API и закладках", required: prod },
    { label: "Токен API", ok: has("API_TOKEN", 16), hint: "API_TOKEN — для Telegram-воркера", required: false },
    { label: "Секрет cron", ok: has("CRON_SECRET", 16), hint: "CRON_SECRET — без него Vercel Cron не сможет запускать ежедневные дела", required: vercel },
    { label: "Claude API", ok: isAiConfigured(), hint: "ANTHROPIC_API_KEY", required: false },
    { label: "Telegram-бот", ok: botConfigured(), hint: "TELEGRAM_BOT_TOKEN", required: false },
    {
      label: "Пулинг подключений к базе",
      ok: !vercel || /pooler|pgbouncer|-pooler\.|pooling|prisma\.io/i.test(resolveDatabaseUrl() ?? ""),
      hint: "На Vercel используй пулинговый адрес базы (у Neon — хост с -pooler)",
      required: false,
    },
  ];
}

export default async function SettingsPage() {
  await connection();
  const [notifications, lastLogs] = await Promise.all([
    getNotificationSettings(),
    db.notificationLog.findMany({ orderBy: { sentAt: "desc" }, take: 5 }),
  ]);
  const checks = environmentChecks();
  const bot = botConfigured();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="Настройки" subtitle="Уведомления в Telegram и готовность окружения. Пошагово — docs/INSTRUCTIONS.md." />

      <Card title="Уведомления в Telegram">
        {!bot ? (
          <p className="text-sm">
            Бот не настроен. Создай бота у <b>@BotFather</b>, положи токен в <code>TELEGRAM_BOT_TOKEN</code> и перезапусти приложение.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {notifications.chatId ? (
                <>
                  Чат подключён: <b>{notifications.chatName ?? notifications.chatId}</b>
                </>
              ) : (
                <>Открой своего бота в Telegram, нажми «Старт», затем «Найти мой чат».</>
              )}
            </p>
            <ConnectChat connected={Boolean(notifications.chatId)} />
            {notifications.chatId && (
              <>
                <NotificationToggles daily={notifications.daily} hotLeads={notifications.hotLeads} hotThreshold={notifications.hotThreshold} />
                <PreviewDaily />
              </>
            )}
            {lastLogs.length > 0 && (
              <ul className="text-xs text-zinc-500">
                {lastLogs.map((l) => (
                  <li key={l.key}>
                    {formatDate(l.sentAt, true)} · {l.key} · {l.ok ? "отправлено" : <span className="text-rose-600">{l.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Данные">
        <p className="mb-3 text-sm text-zinc-500">Выгрузка в CSV для Excel: резервная копия, учёт доходов, перенос. Файл лидов можно загрузить обратно через «Импорт».</p>
        <div className="flex flex-wrap gap-3 text-sm">
          <a href="/export/leads" className="underline">
            Скачать лиды и сделки (CSV)
          </a>
          <a href="/export/payments" className="underline">
            Скачать платежи (CSV)
          </a>
        </div>
      </Card>

      <Card title="Готовность окружения">
        <p className="mb-3 text-sm text-zinc-500">
          Режим: {process.env.VERCEL ? "Vercel" : "сервер/локально"} · AI-задачи выполняются {inlineJobsEnabled() ? "сразу после запросов и ежедневным cron" : "фоновым воркером (pnpm worker:ai)"} · часовой пояс {APP_TIMEZONE}
        </p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2">
              <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : c.required ? "bg-rose-500" : "bg-zinc-400"}`} />
              <span>
                {c.label}
                {!c.ok && <span className={`block text-xs ${c.required ? "text-rose-600" : "text-zinc-500"}`}>{c.required ? "Нужно: " : "Можно: "}{c.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

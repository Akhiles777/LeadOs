import { connection } from "next/server";
import { addChannel, saveKeywords } from "@/lib/telegram-actions";
import { db } from "@/lib/db";
import { daysSince, formatDate } from "@/lib/leads";
import { getKeywordRules, type TelegramDialog, TELEGRAM_WORKER } from "@/lib/telegram-ingest";
import { ActionForm } from "@/components/action-form";
import { ChannelControls, DialogPicker } from "@/components/telegram-controls";
import { Card, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";

const ONLINE_MINUTES = 15;

export default async function TelegramPage() {
  await connection();
  const [channels, rules, heartbeat] = await Promise.all([
    db.telegramChannel.findMany({ orderBy: [{ enabled: "desc" }, { createdAt: "asc" }] }),
    getKeywordRules(),
    db.workerHeartbeat.findUnique({ where: { name: TELEGRAM_WORKER } }),
  ]);

  const info = (heartbeat?.info ?? {}) as { version?: string; dialogs?: TelegramDialog[]; dialogsAt?: string };
  const tracked = new Set(channels.flatMap((c) => [c.peerId, c.username && `@${c.username}`]).filter(Boolean));
  const dialogs = (info.dialogs ?? []).filter((d) => !tracked.has(d.peerId) && !(d.username && tracked.has(`@${d.username.toLowerCase()}`)));
  const now = new Date();
  const minutesAgo = heartbeat ? Math.floor((now.getTime() - heartbeat.seenAt.getTime()) / 60_000) : null;
  const online = minutesAgo != null && minutesAgo <= ONLINE_MINUTES;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Telegram-каналы"
        subtitle={
          <span className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400"}`} />
            {heartbeat
              ? `Воркер ${online ? "на связи" : "молчит"}: последний раз ${minutesAgo === 0 ? "только что" : `${minutesAgo} мин. назад`}${info.version ? ` · v${info.version}` : ""}`
              : "Воркер ещё ни разу не выходил на связь — см. worker/telegram/README.md"}
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title={`Каналы (${channels.length})`} className="lg:col-span-3">
          {channels.length === 0 ? (
            <EmptyState>Пока нет каналов — добавь справа</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {channels.map((c) => (
                <li key={c.id} className={`flex flex-col gap-1 py-3 ${c.enabled ? "" : "opacity-60"}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {c.title ?? (c.username ? `@${c.username}` : c.peerId)}
                      {c.username && c.title && <span className="ml-2 text-xs font-normal text-zinc-500">@{c.username}</span>}
                      {!c.enabled && <span className="ml-2 text-xs font-normal text-zinc-500">выключен</span>}
                    </span>
                    <ChannelControls id={c.id} enabled={c.enabled} filterMode={c.filterMode} />
                  </div>
                  <p className="text-xs text-zinc-500">
                    {c.lastCheckedAt
                      ? `Проверен ${daysSince(c.lastCheckedAt, now) === 0 ? formatDate(c.lastCheckedAt, true) : formatDate(c.lastCheckedAt)} · `
                      : "Ещё не проверялся · "}
                    постов прочитано: {c.postsSeen} · лидов: {c.leadsCreated}
                  </p>
                  {c.lastError && <p className="text-xs text-rose-600">{c.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Мои каналы">
            {info.dialogs ? (
              dialogs.length ? (
                <>
                  <DialogPicker dialogs={dialogs} />
                  {info.dialogsAt && <p className="mt-2 text-xs text-zinc-500">Список обновлён {formatDate(new Date(info.dialogsAt), true)}</p>}
                </>
              ) : (
                <EmptyState>Все каналы аккаунта уже в списке</EmptyState>
              )
            ) : (
              <EmptyState>Появятся, когда воркер впервые выйдет на связь</EmptyState>
            )}
          </Card>

          <Card title="Добавить публичный канал">
            <ActionForm action={addChannel} submitLabel="Добавить" resetOnSuccess>
              <Field label="@username или ссылка t.me">
                <input name="ref" required placeholder="@devjobs" className={inputClass} />
              </Field>
              <Field label="Что брать">
                <select name="filterMode" defaultValue="KEYWORDS" className={inputClass}>
                  <option value="KEYWORDS">Посты с ключевыми словами</option>
                  <option value="ALL">Все посты (канал — лента заказов)</option>
                </select>
              </Field>
            </ActionForm>
          </Card>
        </div>

        <Card title="Ключевые слова" className="lg:col-span-5">
          <ActionForm action={saveKeywords} submitLabel="Сохранить слова" successText="Сохранено — применяется к новым постам">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Брать пост, если есть хоть одно (по строке или через запятую)">
                <textarea
                  name="include"
                  rows={8}
                  defaultValue={rules.include.join("\n")}
                  placeholder={"сайт\nлендинг\nинтернет-магазин\ncrm\ntelegram-бот\nnext.js\nавтоматизац\nинтеграц\nпарсер"}
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field label="Пропускать пост, если есть хоть одно">
                <textarea
                  name="exclude"
                  rows={8}
                  defaultValue={rules.exclude.join("\n")}
                  placeholder={"ищу работу\nрезюме\nв штат\nстажер\nвакансия в офис"}
                  className={`${inputClass} font-mono`}
                />
              </Field>
            </div>
            <p className="text-xs text-zinc-500">
              Ищется как часть слова без учёта регистра: «разработ» найдёт «разработка» и «разработчик». Пустой список «брать» = брать всё, кроме стоп-слов.
              Короткие посты (меньше 40 символов) пропускаются всегда.
            </p>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}

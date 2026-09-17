"use client";

import { useState, useTransition } from "react";
import { connectTelegramChat, disconnectTelegramChat, sendDailyPreview, type SettingsResult, updateNotificationToggles } from "@/lib/settings-actions";
import { ghostButtonClass } from "@/components/ui";

function useResult() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SettingsResult | null>(null);
  const run = (fn: () => Promise<SettingsResult>) =>
    start(async () => {
      setResult(null);
      setResult(await fn());
    });
  const view = result && <span className={`text-xs ${"error" in result ? "text-rose-600" : "text-emerald-700 dark:text-emerald-400"}`}>{"error" in result ? result.error : result.ok}</span>;
  return { pending, run, view };
}

export function ConnectChat({ connected }: { connected: boolean }) {
  const { pending, run, view } = useResult();
  const [, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} className={ghostButtonClass} onClick={() => run(connectTelegramChat)}>
        {pending ? "Ищу…" : connected ? "Переподключить чат" : "Найти мой чат"}
      </button>
      {connected && (
        <button type="button" className="text-xs underline" onClick={() => start(() => disconnectTelegramChat())}>
          отключить
        </button>
      )}
      {view}
    </div>
  );
}

export function PreviewDaily() {
  const { pending, run, view } = useResult();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} className={ghostButtonClass} onClick={() => run(sendDailyPreview)}>
        {pending ? "Отправляю…" : "Прислать сводку сейчас"}
      </button>
      {view}
    </div>
  );
}

export function NotificationToggles({ daily, hotLeads, hotThreshold }: { daily: boolean; hotLeads: boolean; hotThreshold: number }) {
  const [pending, start] = useTransition();
  const [threshold, setThreshold] = useState(hotThreshold);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={pending} defaultChecked={daily} onChange={(e) => start(() => updateNotificationToggles({ daily: e.target.checked }))} />
        Утренняя сводка: дайджест, оплаты, follow-up, звонки, повторные продажи
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <input type="checkbox" disabled={pending} defaultChecked={hotLeads} onChange={(e) => start(() => updateNotificationToggles({ hotLeads: e.target.checked }))} />
        Сразу сообщать о новом лиде с оценкой от
        <input
          type="number"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          onBlur={() => threshold !== hotThreshold && start(() => updateNotificationToggles({ hotThreshold: threshold }))}
          className="w-16 rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
        />
      </label>
    </div>
  );
}

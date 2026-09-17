"use client";

import { useState, useTransition } from "react";
import type { ChannelFilterMode } from "@/generated/prisma/enums";
import { addDialogChannel, deleteChannel, setChannelEnabled, setChannelMode } from "@/lib/telegram-actions";
import { ghostButtonClass, inputClass } from "@/components/ui";

export function ChannelControls({ id, enabled, filterMode }: { id: string; enabled: boolean; filterMode: ChannelFilterMode }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Режим фильтра"
        defaultValue={filterMode}
        disabled={pending}
        onChange={(e) => start(() => setChannelMode(id, e.target.value as ChannelFilterMode))}
        className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700"
      >
        <option value="KEYWORDS">по ключевым словам</option>
        <option value="ALL">все посты</option>
      </select>
      <button type="button" disabled={pending} onClick={() => start(() => setChannelEnabled(id, !enabled))} className="text-xs underline">
        {enabled ? "выключить" : "включить"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => confirm("Убрать канал из списка? Созданные лиды останутся.") && start(() => deleteChannel(id))}
        className="text-xs text-rose-600 underline"
      >
        убрать
      </button>
    </div>
  );
}

type Dialog = { peerId: string; title: string; username?: string | null };

export function DialogPicker({ dialogs }: { dialogs: Dialog[] }) {
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const q = query.trim().toLowerCase();
  const shown = (q ? dialogs.filter((d) => `${d.title} ${d.username ?? ""}`.toLowerCase().includes(q)) : dialogs).slice(0, 50);

  return (
    <div className="flex flex-col gap-2">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по моим каналам…" className={inputClass} />
      <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-900">
        {shown.map((d) => (
          <li key={d.peerId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate">
              {d.title}
              {d.username && <span className="ml-2 text-xs text-zinc-500">@{d.username}</span>}
            </span>
            <button type="button" disabled={pending} onClick={() => start(() => addDialogChannel(d))} className={ghostButtonClass}>
              Следить
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="py-2 text-sm text-zinc-500">Ничего не найдено</li>}
      </ul>
    </div>
  );
}

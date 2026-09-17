"use client";

import { useState, useTransition } from "react";
import { runNicheSearch } from "@/lib/cold-search-actions";
import { ghostButtonClass, inputClass } from "@/components/ui";

/** Кнопка автоматического поиска компаний ниши: OpenStreetMap → лиды → проверка сайта → скрипт звонка. */
export function SearchNicheButton({ niche, defaultRadius = 10, defaultLimit = 20 }: { niche: string; defaultRadius?: number; defaultLimit?: number }) {
  const [open, setOpen] = useState(false);
  const [radius, setRadius] = useState(defaultRadius);
  const [limit, setLimit] = useState(defaultLimit);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setMessage(null);
      setError(null);
      const res = await runNicheSearch(niche, radius, limit);
      if (res.error) setError(res.error);
      else if (res.result) {
        const r = res.result;
        setMessage(
          r.created === 0
            ? `Новых компаний не нашлось: всё уже в базе (${r.duplicates} совпадений)`
            : `Добавлено ${r.created}: с телефоном ${r.withPhone}, с сайтом ${r.withSite}. Пропущено дублей: ${r.duplicates}.` +
                (r.offersQueued ? ` Готовлю скрипты звонка для ${r.offersQueued}.` : ""),
        );
        setOpen(false);
      }
    });

  return (
    <span className="flex flex-col items-end gap-1">
      {open ? (
        <span className="flex flex-wrap items-center justify-end gap-1">
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            радиус
            <input type="number" min={1} max={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className={`${inputClass} w-16 px-1! py-0.5! text-xs!`} />
            км
          </label>
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            до
            <input type="number" min={1} max={60} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={`${inputClass} w-16 px-1! py-0.5! text-xs!`} />
            шт.
          </label>
          <button type="button" disabled={pending} className={`${ghostButtonClass} px-2! py-1! text-xs!`} onClick={run}>
            {pending ? "Ищу…" : "Искать"}
          </button>
          <button type="button" className="text-xs underline" onClick={() => setOpen(false)}>
            отмена
          </button>
        </span>
      ) : (
        <button type="button" disabled={pending} className={`${ghostButtonClass} px-2! py-1! text-xs!`} onClick={() => setOpen(true)}>
          {pending ? "Ищу…" : "Найти автоматически"}
        </button>
      )}
      {message && <span className="text-xs text-emerald-700 dark:text-emerald-400">{message}</span>}
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}

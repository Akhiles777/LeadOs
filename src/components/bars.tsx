/**
 * Горизонтальная полоса-показатель внутри таблицы: одна серия, один тон, значение всегда подписано текстом рядом,
 * подсказка при наведении. Цвет не несёт смысла сам по себе — только длину.
 */
export function InlineBar({ value, max, label, title }: { value: number; max: number; label: string; title?: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="group flex items-center gap-2" title={title ?? label}>
      <div className="h-2 min-w-16 flex-1 rounded-sm bg-zinc-100 dark:bg-zinc-900">
        <div className="h-2 rounded-r-[4px] bg-sky-700 group-hover:bg-sky-600 dark:bg-sky-600 dark:group-hover:bg-sky-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">{label}</span>
    </div>
  );
}

/** Вертикальные столбцы по месяцам: одна ось, общий ноль, зазор 2px, подпись значения при наведении. */
export function MonthBars({ rows }: { rows: { key: string; label: string; value: number; tooltip: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <div>
      <div className="flex h-40 items-end gap-[2px] border-b border-zinc-300 dark:border-zinc-700" role="img" aria-label="Выручка по месяцам">
        {rows.map((r) => (
          <div key={r.key} className="group relative flex h-full flex-1 items-end" title={r.tooltip}>
            <div
              className="w-full rounded-t-[4px] bg-sky-700 group-hover:bg-sky-600 dark:bg-sky-600 dark:group-hover:bg-sky-500"
              style={{ height: max ? `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%` : 0 }}
            />
            <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-white group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
              {r.tooltip}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {rows.map((r) => (
          <span key={r.key} className="flex-1 text-center text-[10px] text-zinc-500">
            {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}

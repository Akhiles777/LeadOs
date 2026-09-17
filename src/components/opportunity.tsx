import type { Opportunity } from "@/lib/site-check";

const TONE: Record<Opportunity["level"], string> = {
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  unknown: "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
};

const LABEL: Record<Opportunity["level"], string> = {
  high: "Горячий",
  medium: "Тёплый",
  low: "Холодный",
  unknown: "Сайт не проверен",
};

export function OpportunityBadge({ level }: { level: Opportunity["level"] }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[level]}`}>{LABEL[level]}</span>;
}

/** Оценка «насколько это наш клиент» + аргументы для звонка. */
export function OpportunityView({ opportunity, compact = false }: { opportunity: Opportunity; compact?: boolean }) {
  return (
    <div className={compact ? "flex flex-wrap items-center gap-1.5" : "flex flex-col gap-2"}>
      <div className="flex items-center gap-2">
        <OpportunityBadge level={opportunity.level} />
        {!compact && opportunity.reasons.length > 0 && <span className="text-xs text-zinc-500">аргументы для звонка:</span>}
      </div>
      {opportunity.reasons.length > 0 &&
        (compact ? (
          <span className="text-xs text-zinc-600 dark:text-zinc-400">{opportunity.reasons.join(" · ")}</span>
        ) : (
          <ul className="list-inside list-disc text-sm">
            {opportunity.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ))}
    </div>
  );
}

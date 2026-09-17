import type { Lead } from "@/generated/prisma/client";
import type { Assessment } from "@/ai/tasks/assess";
import { formatDate } from "@/lib/leads";
import { AssessButton, FeedbackForm, VerdictActions } from "@/components/ai-panels";

const VERDICT: Record<string, { label: string; tone: string }> = {
  TAKE: { label: "Брать", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  CONSIDER: { label: "Подумать", tone: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  SKIP: { label: "Пропустить", tone: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" },
};

const SEVERITY: Record<string, string> = { high: "text-rose-600", medium: "text-amber-600", low: "text-zinc-500" };

export function ScoreBadge({ score, verdict }: { score: number | null; verdict: string | null }) {
  if (score == null) return null;
  const v = verdict ? VERDICT[verdict] : null;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${v?.tone ?? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
      {score}
      {v ? ` · ${v.label}` : ""}
    </span>
  );
}

type FeedbackItem = { id: string; correctVerdict: string; note: string; createdAt: Date };

export function AiAssessment({
  lead,
  feedback = [],
}: {
  lead: Pick<Lead, "id" | "status" | "score" | "aiVerdict" | "scoredAt" | "scoreReason" | "redFlags" | "aiAssessment">;
  feedback?: FeedbackItem[];
}) {
  const a = lead.aiAssessment as unknown as Assessment | null;

  if (lead.score == null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-500">Лид ещё не оценён.</p>
        <AssessButton leadId={lead.id} label="Оценить" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-3xl font-semibold tabular-nums">{lead.score}</span>
        {lead.aiVerdict && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT[lead.aiVerdict].tone}`}>{VERDICT[lead.aiVerdict].label}</span>}
        <VerdictActions leadId={lead.id} status={lead.status} />
      </div>
      {lead.scoreReason && <p className="text-sm">{lead.scoreReason}</p>}

      {a?.fit && (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          {(
            [
              ["Специализация", a.fit.specialization],
              ["Бюджет", a.fit.budget],
              ["Объём", a.fit.scope],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-zinc-500">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {a?.redFlags?.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Тревожные признаки</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {a.redFlags.map((f, i) => (
              <li key={i}>
                <span className={`font-medium ${SEVERITY[f.severity]}`}>{f.title}</span> — {f.explanation}
              </li>
            ))}
          </ul>
        </div>
      ) : lead.redFlags.length ? (
        <ul className="list-inside list-disc text-sm text-rose-600">
          {lead.redFlags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">Тревожных признаков не найдено.</p>
      )}

      {a?.questions?.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Уточнить у заказчика</p>
          <ul className="list-inside list-disc text-sm">
            {a.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {lead.scoredAt && <span>Оценено {formatDate(lead.scoredAt, true)}</span>}
        <AssessButton leadId={lead.id} label="Переоценить" />
      </div>
      <FeedbackForm leadId={lead.id} feedback={feedback.map((f) => ({ ...f, createdAt: formatDate(f.createdAt) }))} />
    </div>
  );
}

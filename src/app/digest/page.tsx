import Link from "next/link";
import { connection } from "next/server";
import type { DigestSummary } from "@/ai/tasks/digest";
import { db } from "@/lib/db";
import { formatBudget, formatDate, SOURCE_LABEL } from "@/lib/leads";
import { ScoreBadge } from "@/components/ai-assessment";
import { VerdictActions } from "@/components/ai-panels";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";

export default async function DigestPage() {
  await connection();
  const digests = await db.digest.findMany({ orderBy: { day: "desc" }, take: 7 });
  const leadIds = [...new Set(digests.flatMap((d) => d.leadIds))];
  const leads = await db.lead.findMany({
    where: { id: { in: leadIds } },
    select: { id: true, title: true, source: true, status: true, score: true, aiVerdict: true, budgetMin: true, budgetMax: true, scoreReason: true },
  });
  const byId = new Map(leads.map((l) => [l.id, l]));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="Дайджест" subtitle="Новые лиды за сутки, по убыванию оценки. Собирается каждое утро фоновым AI-воркером." />
      {digests.length === 0 && <EmptyState>Дайджестов пока нет. Запусти воркер или нажми «Собрать дайджест сейчас» на странице AI.</EmptyState>}
      {digests.map((d) => {
        const summary = d.summary as unknown as DigestSummary | null;
        const top = new Map((summary?.top ?? []).map((t) => [t.leadId, t.why]));
        const rows = d.leadIds.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l));
        return (
          <Card key={d.id} title={`${formatDate(d.periodEnd)} · новых лидов: ${d.leadIds.length}`}>
            {summary?.headline && <p className="mb-3 font-medium">{summary.headline}</p>}
            {rows.length === 0 ? (
              <EmptyState>За сутки новых лидов не было</EmptyState>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {rows.map((l) => (
                  <li key={l.id} className={`flex flex-col gap-1 py-2 ${top.has(l.id) ? "" : "opacity-70"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                        {top.has(l.id) && "★ "}
                        {l.title}
                      </Link>
                      <span className="flex flex-wrap items-center gap-2">
                        <ScoreBadge score={l.score} verdict={l.aiVerdict} />
                        <StatusBadge status={l.status} />
                        <VerdictActions leadId={l.id} status={l.status} />
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {SOURCE_LABEL[l.source]} · {formatBudget(l.budgetMin, l.budgetMax)}
                    </p>
                    {top.get(l.id) ? <p className="text-sm">{top.get(l.id)}</p> : l.scoreReason && <p className="text-xs text-zinc-500">{l.scoreReason}</p>}
                  </li>
                ))}
              </ul>
            )}
            {summary?.skipNote && <p className="mt-3 text-xs text-zinc-500">{summary.skipNote}</p>}
          </Card>
        );
      })}
    </div>
  );
}

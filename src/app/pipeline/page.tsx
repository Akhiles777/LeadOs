import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { daysSince, formatBudget, FUNNEL_STAGES, STALE_STATUSES, STATUS_LABEL, staleDays } from "@/lib/leads";
import { ScoreBadge } from "@/components/ai-assessment";
import { DragCard, DropColumn, PipelineBoard } from "@/components/pipeline-dnd";
import { StatusSelect } from "@/components/status-select";
import { AddLeadLink, PageHeader, SourceTag, StatusBadge } from "@/components/ui";

const WON_WINDOW_DAYS = 30;

export default async function PipelinePage() {
  await connection();
  const now = new Date();
  const wonSince = new Date(now.getTime() - WON_WINDOW_DAYS * 86_400_000);

  const [leads, closedCounts] = await Promise.all([
    db.lead.findMany({
      where: {
        OR: [{ status: { in: FUNNEL_STAGES.filter((s) => s !== "WON") } }, { status: "WON", lastActivityAt: { gte: wonSince } }],
      },
      orderBy: { lastActivityAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        budgetMin: true,
        budgetMax: true,
        lastActivityAt: true,
        followUpAt: true,
        score: true,
        aiVerdict: true,
      },
    }),
    db.lead.groupBy({ by: ["status"], where: { status: { in: ["LOST", "SKIPPED"] } }, _count: { _all: true } }),
  ]);

  const limit = staleDays();

  return (
    <>
      <PageHeader
        title="Воронка"
        subtitle={
          <>
            Перетаскивай карточки между этапами. Выигранные — за последние {WON_WINDOW_DAYS} дн.{" "}
            {closedCounts.map((c) => (
              <Link key={c.status} href={`/leads?status=${c.status}`} className="ml-2 hover:underline">
                {STATUS_LABEL[c.status]}: {c._count._all}
              </Link>
            ))}
          </>
        }
        action={<AddLeadLink />}
      />

      <PipelineBoard>
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-4">
        {FUNNEL_STAGES.map((stage) => {
          const column = leads.filter((l) => l.status === stage);
          return (
            <DropColumn key={stage} status={stage} className="flex min-h-40 w-72 shrink-0 flex-col gap-2 rounded-xl bg-zinc-100 p-3 dark:bg-zinc-900">
              <header className="flex items-center justify-between px-1">
                <StatusBadge status={stage} />
                <span className="text-xs tabular-nums text-zinc-500">{column.length}</span>
              </header>
              {column.map((l) => {
                const silent = daysSince(l.lastActivityAt, now);
                const needsAttention =
                  (STALE_STATUSES.includes(l.status) && silent > limit) || (l.followUpAt != null && l.followUpAt <= now);
                return (
                  <DragCard
                    key={l.id}
                    id={l.id}
                    status={l.status}
                    className={`rounded-lg border bg-white p-3 shadow-sm dark:bg-zinc-950 ${
                      needsAttention ? "border-amber-400 dark:border-amber-600" : "border-zinc-200 dark:border-zinc-800"
                    }`}
                  >
                    <Link href={`/leads/${l.id}`} className="line-clamp-2 text-sm font-medium hover:underline">
                      {l.title}
                    </Link>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        <SourceTag source={l.source} />
                        <ScoreBadge score={l.score} verdict={l.aiVerdict} />
                      </span>
                      <span className="text-xs tabular-nums text-zinc-500">{formatBudget(l.budgetMin, l.budgetMax)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className={`text-xs ${needsAttention ? "font-medium text-amber-700 dark:text-amber-400" : "text-zinc-400"}`}>
                        {silent === 0 ? "сегодня" : `${silent} дн. назад`}
                      </span>
                      <StatusSelect id={l.id} status={l.status} compact />
                    </div>
                  </DragCard>
                );
              })}
            </DropColumn>
          );
        })}
      </div>
      </PipelineBoard>
    </>
  );
}

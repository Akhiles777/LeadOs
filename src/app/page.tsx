import Link from "next/link";
import { connection } from "next/server";
import { drainIfPending } from "@/ai/inline";
import { getFunnel, getKpis, getMoneyReminders, getSourceStats, getStaleLeads, getStatusCounts } from "@/lib/analytics";
import { daysSince, formatDate, SOURCE_LABEL, STATUS_LABEL, STATUS_ORDER, staleDays } from "@/lib/leads";
import type { DigestSummary } from "@/ai/tasks/digest";
import { db } from "@/lib/db";
import { ScoreBadge } from "@/components/ai-assessment";
import { MarkPaidButton } from "@/components/deal-controls";
import { AddLeadLink, Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const rub = (v: number | null) => (v == null ? "—" : `${Math.round(v).toLocaleString("ru-RU")} ₽`);

// Досчёт очереди AI после показа страницы (Vercel) может идти несколько минут.
export const maxDuration = 300;

export default async function DashboardPage() {
  await connection();
  await drainIfPending();
  const [kpis, funnel, statusCounts, sources, stale, digest, money] = await Promise.all([
    getKpis(),
    getFunnel(),
    getStatusCounts(),
    getSourceStats(),
    getStaleLeads(),
    db.digest.findFirst({ orderBy: { day: "desc" } }),
    getMoneyReminders(),
  ]);
  const moneyItems = money.duePayments.length + money.referral.length + money.upsell.length + money.unpaidWon.length;
  const digestSummary = digest?.summary as unknown as DigestSummary | null;
  const digestTop = digestSummary?.top?.length
    ? await db.lead.findMany({ where: { id: { in: digestSummary.top.map((t) => t.leadId) } }, select: { id: true, title: true, score: true, aiVerdict: true } })
    : [];
  const top = funnel[0]?.reached || 1;

  return (
    <>
      <PageHeader title="Дашборд" action={<AddLeadLink />} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Активных лидов" value={kpis.active} />
        <Kpi label="Новых за 7 дней" value={kpis.newThisWeek} />
        <Kpi label="Сделок в этом месяце" value={kpis.wonThisMonth} />
        <Kpi label="Получено за месяц" value={rub(kpis.receivedThisMonth)} hint={kpis.expectedIn30Days ? `ждём ${rub(kpis.expectedIn30Days)} в течение 30 дней` : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Воронка (дошли до этапа)" className="lg:col-span-3">
          <ol className="flex flex-col gap-3">
            {funnel.map((row) => (
              <li key={row.status} className="grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-3 text-sm">
                <span className="text-zinc-600 dark:text-zinc-300">{STATUS_LABEL[row.status]}</span>
                <div className="h-6 rounded bg-zinc-100 dark:bg-zinc-900">
                  <div
                    className="flex h-6 items-center rounded bg-zinc-800 px-2 text-xs font-medium text-white dark:bg-zinc-300 dark:text-zinc-900"
                    style={{ width: `${Math.max((row.reached / top) * 100, row.reached ? 6 : 0)}%` }}
                  >
                    {row.reached || ""}
                  </div>
                </div>
                <span className="text-right text-xs text-zinc-500 tabular-nums">
                  {row.conversion == null ? "" : `→ ${pct(row.conversion)}`}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-5 flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-900">
            {STATUS_ORDER.map((s) => (
              <Link key={s} href={`/leads?status=${s}`} className="flex items-center gap-1.5 text-xs">
                <StatusBadge status={s} />
                <span className="tabular-nums text-zinc-500">{statusCounts[s] ?? 0}</span>
              </Link>
            ))}
          </div>
        </Card>

        <Card title={`Требуют follow-up (> ${staleDays()} дн. без движения или назначено касание)`} className="lg:col-span-2">
          {stale.length === 0 ? (
            <EmptyState>Зависших лидов нет 👌</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {stale.map((l) => (
                <li key={l.id} className="py-2">
                  <Link href={`/leads/${l.id}`} className="flex items-start justify-between gap-3 hover:opacity-80">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{l.title}</p>
                      <p className="text-xs text-zinc-500">
                        {l.contactName ? `${l.contactName} · ` : ""}
                        {l.offers.length > 0 && <span className="text-emerald-700 dark:text-emerald-400">follow-up готов · </span>}
                        {l.followUpAt && l.followUpAt <= new Date()
                          ? `касание назначено на ${formatDate(l.followUpAt)}`
                          : `тишина ${daysSince(l.lastActivityAt)} дн.`}
                      </p>
                    </div>
                    <StatusBadge status={l.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {moneyItems > 0 && (
          <Card title="Деньги и повторные продажи" className="lg:col-span-5">
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
              <ReminderList
                title="Оплаты: просрочено и на неделе"
                items={money.duePayments.map((p) => ({
                  key: p.id,
                  href: `/leads/${p.deal.lead.id}`,
                  title: p.deal.lead.title,
                  meta: `${rub(p.amount)} · ${p.title ?? "платёж"} · ${p.dueDate! < new Date() ? "просрочено с" : "до"} ${formatDate(p.dueDate!)}`,
                  alert: p.dueDate! < new Date(),
                  action: <MarkPaidButton id={p.id} />,
                }))}
              />
              <ReminderList
                title="Сделки без отмеченной оплаты"
                items={money.unpaidWon.map((d) => ({ key: d.id, href: `/leads/${d.lead.id}`, title: d.lead.title, meta: `${rub(d.amount)} — отметь оплату или составь график` }))}
              />
              <ReminderList
                title="Попросить отзыв и рекомендацию"
                items={money.referral.map((d) => ({ key: d.id, href: `/leads/${d.lead.id}`, title: d.lead.title, meta: `сделка закрыта ${formatDate(d.closedAt!)}` }))}
              />
              <ReminderList
                title="Предложить доработки"
                items={money.upsell.map((d) => ({ key: d.id, href: `/leads/${d.lead.id}`, title: d.lead.title, meta: `сделка закрыта ${formatDate(d.closedAt!)}` }))}
              />
            </div>
          </Card>
        )}

        {digest && (
          <Card
            title={`Дайджест · новых лидов за сутки: ${digest.leadIds.length}`}
            action={
              <Link href="/digest" className="text-xs underline">
                весь дайджест
              </Link>
            }
            className="lg:col-span-5"
          >
            {digestSummary?.headline && <p className="mb-2 text-sm font-medium">{digestSummary.headline}</p>}
            {digestSummary?.top?.length ? (
              <ul className="flex flex-col gap-2">
                {digestSummary.top.slice(0, 3).map((t) => {
                  const l = digestTop.find((x) => x.id === t.leadId);
                  return l ? (
                    <li key={t.leadId} className="text-sm">
                      <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                        {l.title}
                      </Link>{" "}
                      <ScoreBadge score={l.score} verdict={l.aiVerdict} />
                      <p className="text-xs text-zinc-500">{t.why}</p>
                    </li>
                  ) : null;
                })}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Интересного за сутки не нашлось.</p>
            )}
          </Card>
        )}

        <Card title="Источники" className="lg:col-span-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Источник</th>
                  <th className="py-2 pr-4 text-right font-medium">Лидов</th>
                  <th className="py-2 pr-4 text-right font-medium">Выиграно</th>
                  <th className="py-2 pr-4 text-right font-medium">Доля в WON</th>
                  <th className="py-2 pr-4 text-right font-medium">Средний чек</th>
                  <th className="py-2 text-right font-medium">Срок закрытия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-900">
                {sources.map((s) => (
                  <tr key={s.source}>
                    <td className="py-2 pr-4">
                      <Link href={`/leads?source=${s.source}`} className="hover:underline">
                        {SOURCE_LABEL[s.source]}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right">{s.total}</td>
                    <td className="py-2 pr-4 text-right">{s.won}</td>
                    <td className="py-2 pr-4 text-right">{pct(s.winRate)}</td>
                    <td className="py-2 pr-4 text-right">{rub(s.avgCheck)}</td>
                    <td className="py-2 text-right">{s.avgDaysToClose == null ? "—" : `${Math.round(s.avgDaysToClose)} дн.`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

function ReminderList({
  title,
  items,
}: {
  title: string;
  items: { key: string; href: string; title: string; meta: string; alert?: boolean; action?: React.ReactNode }[];
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-500">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-400">—</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((i) => (
            <li key={i.key} className="text-sm">
              <Link href={i.href} className="hover:underline">
                {i.title}
              </Link>
              <p className={`text-xs ${i.alert ? "text-rose-600" : "text-zinc-500"}`}>
                {i.meta}
                {i.action && <span className="ml-2">{i.action}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}


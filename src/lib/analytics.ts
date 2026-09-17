import { db } from "@/lib/db";
import { monthStart } from "@/lib/time";
import { CLOSED_STATUSES, FUNNEL_STAGES, SOURCE_ORDER, STALE_STATUSES, staleDays } from "@/lib/leads";
import type { LeadStatus, Source } from "@/generated/prisma/enums";

export type FunnelRow = { status: LeadStatus; reached: number; conversion: number | null };

export async function getFunnel(): Promise<FunnelRow[]> {
  const grouped = await db.lead.groupBy({ by: ["furthestStage"], _count: { _all: true } });
  const byStage = new Map(grouped.map((g) => [g.furthestStage, g._count._all]));

  return FUNNEL_STAGES.map((status, i) => {
    let reached = 0;
    for (const [stage, count] of byStage) if (stage >= i) reached += count;
    return { status, reached, conversion: null as number | null };
  }).map((row, i, rows) => ({
    ...row,
    conversion: i === 0 || rows[i - 1].reached === 0 ? null : row.reached / rows[i - 1].reached,
  }));
}

export async function getStatusCounts(): Promise<Record<LeadStatus, number>> {
  const grouped = await db.lead.groupBy({ by: ["status"], _count: { _all: true } });
  const out = {} as Record<LeadStatus, number>;
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

export type SourceRow = {
  source: Source;
  total: number;
  won: number;
  winRate: number | null;
  avgCheck: number | null;
  avgDaysToClose: number | null;
};

export async function getSourceStats(): Promise<SourceRow[]> {
  const [totals, wonLeads] = await Promise.all([
    db.lead.groupBy({ by: ["source"], _count: { _all: true } }),
    db.lead.findMany({
      where: { status: "WON" },
      select: {
        source: true,
        createdAt: true,
        deal: { select: { amount: true, closedAt: true, addons: { where: { status: "ACCEPTED" }, select: { price: true } } } },
      },
    }),
  ]);
  const totalBySource = new Map(totals.map((t) => [t.source, t._count._all]));

  return SOURCE_ORDER.map((source) => {
    const total = totalBySource.get(source) ?? 0;
    const won = wonLeads.filter((l) => l.source === source);
    // Средний чек — по договору: сумма за работу + принятые доп. опции.
    const amounts = won
      .filter((l) => l.deal?.amount != null)
      .map((l) => l.deal!.amount! + l.deal!.addons.reduce((s, a) => s + a.price, 0));
    const durations = won
      .filter((l) => l.deal?.closedAt)
      .map((l) => (l.deal!.closedAt!.getTime() - l.createdAt.getTime()) / 86_400_000);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    return {
      source,
      total,
      won: won.length,
      winRate: total ? won.length / total : null,
      avgCheck: avg(amounts),
      avgDaysToClose: avg(durations),
    };
  });
}

/** Лиды, требующие follow-up: зависли в ожидании или наступила назначенная дата касания. */
export async function getStaleLeads(limit = 20) {
  const now = new Date();
  const threshold = new Date(now.getTime() - staleDays() * 86_400_000);

  return db.lead.findMany({
    where: {
      OR: [
        { status: { in: STALE_STATUSES }, lastActivityAt: { lt: threshold } },
        { status: { notIn: CLOSED_STATUSES }, followUpAt: { lte: now } },
      ],
    },
    orderBy: { lastActivityAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      status: true,
      source: true,
      lastActivityAt: true,
      followUpAt: true,
      contactName: true,
      offers: { where: { channel: "follow_up", sentAt: null }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
}

export async function getKpis() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const startOfMonth = monthStart(now);
  const in30days = new Date(now.getTime() + 30 * 86_400_000);

  const [active, newThisWeek, wonThisMonth, received, expected] = await Promise.all([
    db.lead.count({ where: { status: { notIn: CLOSED_STATUSES } } }),
    db.lead.count({ where: { createdAt: { gte: weekAgo } } }),
    db.deal.count({ where: { closedAt: { gte: startOfMonth }, lead: { status: "WON" } } }),
    db.payment.aggregate({ where: { paidAt: { gte: startOfMonth } }, _sum: { amount: true } }),
    db.payment.aggregate({ where: { paidAt: null, kind: { not: "TIP" }, dueDate: { lte: in30days } }, _sum: { amount: true } }),
  ]);

  return {
    active,
    newThisWeek,
    wonThisMonth,
    receivedThisMonth: received._sum.amount ?? 0,
    expectedIn30Days: expected._sum.amount ?? 0,
  };
}

const REFERRAL_AFTER_DAYS = 14;
const UPSELL_AFTER_DAYS = 90;

/** Деньги и повторные продажи для дашборда: просроченные и ближайшие оплаты, кого попросить о рекомендации, кому предложить доработки. */
export async function getMoneyReminders() {
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86_400_000);
  const [duePayments, referral, upsell, unpaidWon] = await Promise.all([
    db.payment.findMany({
      where: { paidAt: null, kind: { not: "TIP" }, dueDate: { lte: week } },
      orderBy: { dueDate: "asc" },
      take: 20,
      select: { id: true, title: true, amount: true, dueDate: true, deal: { select: { lead: { select: { id: true, title: true } } } } },
    }),
    db.deal.findMany({
      where: { lead: { status: "WON" }, referralAskedAt: null, closedAt: { lte: new Date(now.getTime() - REFERRAL_AFTER_DAYS * 86_400_000) } },
      orderBy: { closedAt: "desc" },
      take: 10,
      select: { id: true, closedAt: true, lead: { select: { id: true, title: true } } },
    }),
    db.deal.findMany({
      where: { lead: { status: "WON" }, upsellAt: null, closedAt: { lte: new Date(now.getTime() - UPSELL_AFTER_DAYS * 86_400_000) } },
      orderBy: { closedAt: "desc" },
      take: 10,
      select: { id: true, closedAt: true, lead: { select: { id: true, title: true } } },
    }),
    // Выигранные сделки с суммой, по которым не отмечено ни одной оплаты и нет графика.
    db.deal.findMany({
      where: { lead: { status: "WON" }, amount: { gt: 0 }, payments: { none: {} } },
      take: 10,
      select: { id: true, amount: true, lead: { select: { id: true, title: true } } },
    }),
  ]);
  return { duePayments, referral, upsell, unpaidWon };
}

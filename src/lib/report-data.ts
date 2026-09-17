import { db } from "@/lib/db";
import { type Period, periodStart, type ReportLead } from "@/lib/report";

const MAX_LEADS = 10_000;

/** Лиды, созданные за период, со всем, что нужно отчётам. Для личной CRM объёмы небольшие — считаем в памяти. */
export async function loadReportLeads(period: Period, now = new Date()): Promise<{ leads: ReportLead[]; truncated: boolean }> {
  const start = periodStart(period, now);
  const rows = await db.lead.findMany({
    where: start ? { createdAt: { gte: start } } : {},
    orderBy: { createdAt: "desc" },
    take: MAX_LEADS + 1,
    select: {
      id: true,
      title: true,
      source: true,
      status: true,
      furthestStage: true,
      category: true,
      sourceRef: true,
      createdAt: true,
      score: true,
      aiVerdict: true,
      siteCheck: true,
      referredById: true,
      deal: {
        select: {
          amount: true,
          closedAt: true,
          paymentPlan: true,
          payments: { select: { kind: true, amount: true, dueDate: true, paidAt: true, title: true } },
          addons: { select: { price: true, status: true, source: true } },
        },
      },
      activities: { where: { type: "CALL" }, select: { note: true, createdAt: true } },
      offers: { select: { channel: true, sentAt: true, aiText: true, text: true } },
    },
  });
  const leads = rows.slice(0, MAX_LEADS).map(({ activities, ...l }) => ({ ...l, calls: activities }));
  return { leads, truncated: rows.length > MAX_LEADS };
}

/** Оплаты за последние 13 месяцев — выручка считается по дате оплаты. */
export async function loadReceivedPayments(now = new Date()) {
  const since = new Date(now.getTime() - 400 * 86_400_000);
  const payments = await db.payment.findMany({ where: { paidAt: { gte: since } }, select: { amount: true, paidAt: true, kind: true } });
  return payments.filter((p): p is { amount: number; paidAt: Date; kind: "PART" | "TIP" | "ADDON" } => p.paidAt != null);
}

export async function loadLeadTitles(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
  return new Map(rows.map((r) => [r.id, r.title]));
}

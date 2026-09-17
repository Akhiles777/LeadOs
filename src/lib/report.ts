/**
 * Расчёты для /analytics. Чистые функции над выгрузкой лидов — без БД, проверяются scripts/analytics-check.ts.
 * «Дошёл до этапа» считается по furthestStage (0 NEW … 5 WON), поэтому проигранный на переговорах лид учитывается
 * во всех этапах до переговоров.
 */
import type { AiVerdict, LeadStatus, Source } from "@/generated/prisma/enums";
import { FUNNEL_STAGES, SOURCE_ORDER } from "@/lib/leads";
import { opportunity, type Opportunity, type SiteCheck } from "@/lib/site-check";
import { dealTotals, type MoneyAddon, type MoneyPayment } from "@/lib/money";
import { dayKey } from "@/lib/time";

export const RESPONDED_STAGE = FUNNEL_STAGES.indexOf("RESPONDED");
export const WON_STAGE = FUNNEL_STAGES.indexOf("WON");

export type ReportLead = {
  id: string;
  title: string;
  source: Source;
  status: LeadStatus;
  furthestStage: number;
  category: string | null;
  sourceRef: string | null;
  createdAt: Date;
  score: number | null;
  aiVerdict: AiVerdict | null;
  siteCheck: unknown;
  referredById: string | null;
  deal: {
    amount: number | null;
    closedAt: Date | null;
    paymentPlan: "FULL" | "INSTALLMENTS";
    payments: MoneyPayment[];
    addons: (MoneyAddon & { source: string | null })[];
  } | null;
  calls: { note: string; createdAt: Date }[];
  offers: { channel: string; sentAt: Date | null; aiText: string | null; text: string }[];
};

export const PERIODS = { "30d": 30, "90d": 90, "365d": 365, all: null } as const;
export type Period = keyof typeof PERIODS;

export function isPeriod(v: unknown): v is Period {
  return typeof v === "string" && v in PERIODS;
}

export function periodStart(period: Period, now = new Date()): Date | null {
  const days = PERIODS[period];
  return days == null ? null : new Date(now.getTime() - days * 86_400_000);
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isWon = (l: ReportLead) => l.status === "WON";
const responded = (l: ReportLead) => l.furthestStage >= RESPONDED_STAGE;

// ─── Источники ───────────────────────────────────────────────────────────────

export type SourceFunnelRow = {
  source: Source;
  total: number;
  reached: number[]; // по этапам FUNNEL_STAGES
  lost: number;
  skipped: number;
  won: number;
  winRate: number | null;
  revenue: number; // получено по выигранным сделкам (без чаевых)
  contract: number; // сумма договоров выигранных сделок
  avgCheck: number | null; // средний договор
  avgDaysToClose: number | null;
};

export function sourceFunnel(leads: ReportLead[]): SourceFunnelRow[] {
  return SOURCE_ORDER.map((source) => {
    const rows = leads.filter((l) => l.source === source);
    const wonRows = rows.filter(isWon);
    const totals = wonRows.filter((l) => l.deal).map((l) => dealTotals(l.deal!));
    const amounts = totals.map((t) => t.contract).filter((c) => c > 0);
    const durations = wonRows
      .filter((l) => l.deal?.closedAt)
      .map((l) => (l.deal!.closedAt!.getTime() - l.createdAt.getTime()) / 86_400_000);
    return {
      source,
      total: rows.length,
      reached: FUNNEL_STAGES.map((_, i) => rows.filter((l) => l.furthestStage >= i).length),
      lost: rows.filter((l) => l.status === "LOST").length,
      skipped: rows.filter((l) => l.status === "SKIPPED").length,
      won: wonRows.length,
      winRate: ratio(wonRows.length, rows.length),
      revenue: totals.reduce((a, t) => a + t.paid, 0),
      contract: amounts.reduce((a, b) => a + b, 0),
      avgCheck: avg(amounts),
      avgDaysToClose: avg(durations),
    };
  }).filter((r) => r.total > 0);
}

// ─── Выручка по месяцам ─────────────────────────────────────────────────────

export function monthKey(date: Date): string {
  return dayKey(date).slice(0, 7);
}

/** Полученные деньги по месяцам оплаты: работа и опции отдельно от чаевых. */
export function monthlyRevenue(payments: { amount: number; paidAt: Date; kind: "PART" | "TIP" | "ADDON" }[], months = 12, now = new Date()) {
  const keys: string[] = [];
  const cursor = new Date(now);
  for (let i = 0; i < months; i++) {
    keys.unshift(monthKey(cursor));
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  const map = new Map(keys.map((k) => [k, { month: k, revenue: 0, tips: 0, payments: 0 }]));
  for (const p of payments) {
    const row = map.get(monthKey(p.paidAt));
    if (!row) continue;
    row.payments += 1;
    if (p.kind === "TIP") row.tips += p.amount;
    else row.revenue += p.amount;
  }
  return keys.map((k) => map.get(k)!);
}

/** Деньги по выигранным сделкам периода: договоры, получено, чаевые, частями, опции. */
export function moneyStats(leads: ReportLead[], now = new Date()) {
  const deals = leads.filter((l) => isWon(l) && l.deal).map((l) => ({ lead: l, deal: l.deal!, t: dealTotals(l.deal!, now) }));
  const addons = deals.flatMap((d) => d.deal.addons);
  const decided = addons.filter((a) => a.status !== "PROPOSED");
  const accepted = addons.filter((a) => a.status === "ACCEPTED");
  return {
    deals: deals.length,
    contract: deals.reduce((s, d) => s + d.t.contract, 0),
    received: deals.reduce((s, d) => s + d.t.paid, 0),
    outstanding: deals.reduce((s, d) => s + d.t.outstanding, 0),
    overdue: deals.reduce((s, d) => s + d.t.overdue.reduce((x, p) => x + p.amount, 0), 0),
    tips: deals.reduce((s, d) => s + d.t.tips, 0),
    dealsWithTips: deals.filter((d) => d.t.tips > 0).length,
    installments: deals.filter((d) => d.deal.paymentPlan === "INSTALLMENTS").length,
    withoutPayments: deals.filter((d) => d.t.contract > 0 && d.deal.payments.length === 0).length,
    addonsProposed: addons.length,
    addonsAccepted: accepted.length,
    addonsAcceptRate: ratio(accepted.length, decided.length),
    addonsRevenue: accepted.reduce((s, a) => s + a.price, 0),
    aiAddonsAccepted: accepted.filter((a) => a.source === "ai").length,
    avgAddonsShare: avg(deals.filter((d) => d.t.contract > 0).map((d) => d.t.addonsAccepted / d.t.contract)),
  };
}

/** Кто из клиентов приводит новых: рекомендации и сколько они принесли. */
export function referralStats(leads: ReportLead[], allLeadTitles: Map<string, string>) {
  const byReferrer = new Map<string, ReportLead[]>();
  for (const l of leads) if (l.referredById) byReferrer.set(l.referredById, [...(byReferrer.get(l.referredById) ?? []), l]);
  return [...byReferrer.entries()]
    .map(([id, rows]) => ({
      referrerId: id,
      referrer: allLeadTitles.get(id) ?? "удалённый лид",
      leads: rows.length,
      won: rows.filter(isWon).length,
      received: rows.filter((l) => l.deal).reduce((s, l) => s + dealTotals(l.deal!).paid, 0),
    }))
    .sort((a, b) => b.received - a.received || b.leads - a.leads);
}

// ─── Холодный поиск ─────────────────────────────────────────────────────────

/** Основы слов ниши: «продуктовый магазин» → [«продук», «магази»] — чтобы совпали «Продуктовые магазины». */
function stems(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .map((w) => w.slice(0, Math.min(w.length, 6)));
}

export function matchNiche(category: string | null, niches: string[]): string | null {
  if (!category) return null;
  const hay = category.toLowerCase().replace(/ё/g, "е");
  let best: { niche: string; words: number } | null = null;
  for (const niche of niches) {
    const s = stems(niche);
    if (s.length && s.every((st) => hay.includes(st)) && (!best || s.length > best.words)) best = { niche, words: s.length };
  }
  return best?.niche ?? null;
}

export type CallOutcome = "no_answer" | "callback" | "interested" | "not_interested" | "other";
const CALL_PREFIX: [CallOutcome, RegExp][] = [
  ["no_answer", /^Не дозвонился/],
  ["callback", /^Попросили перезвонить/],
  ["interested", /^Интересно/],
  ["not_interested", /^Не интересно/],
];

export function callOutcome(note: string): CallOutcome {
  return CALL_PREFIX.find(([, re]) => re.test(note))?.[0] ?? "other";
}

export type NicheRow = {
  niche: string;
  companies: number;
  called: number;
  calls: number;
  interestedCalls: number;
  responded: number;
  won: number;
  revenue: number;
  respondRate: number | null; // ответили / те, кому звонили
};

export function nicheStats(leads: ReportLead[], niches: string[]): NicheRow[] {
  const cold = leads.filter((l) => l.source === "COLD_LOCAL");
  const groups = new Map<string, ReportLead[]>();
  for (const l of cold) {
    const key = matchNiche(l.category, niches) ?? "Другое";
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.entries()]
    .map(([niche, rows]) => {
      const called = rows.filter((l) => l.calls.length > 0);
      return {
        niche,
        companies: rows.length,
        called: called.length,
        calls: rows.reduce((s, l) => s + l.calls.length, 0),
        interestedCalls: rows.reduce((s, l) => s + l.calls.filter((c) => callOutcome(c.note) === "interested").length, 0),
        responded: rows.filter(responded).length,
        won: rows.filter(isWon).length,
        revenue: rows.filter((l) => isWon(l) && l.deal).reduce((s, l) => s + dealTotals(l.deal!).paid, 0),
        respondRate: ratio(called.filter(responded).length, called.length),
      };
    })
    .sort((a, b) => (a.niche === "Другое" ? 1 : b.niche === "Другое" ? -1 : b.companies - a.companies));
}

export function callOutcomes(leads: ReportLead[]): Record<CallOutcome, number> {
  const out: Record<CallOutcome, number> = { no_answer: 0, callback: 0, interested: 0, not_interested: 0, other: 0 };
  for (const l of leads) for (const c of l.calls) out[callOutcome(c.note)]++;
  return out;
}

/** Сходится ли оценка сайта «Горячий/Тёплый/Холодный» с тем, кто в итоге ответил. */
export function opportunityOutcome(leads: ReportLead[]) {
  const levels: Opportunity["level"][] = ["high", "medium", "low", "unknown"];
  const cold = leads.filter((l) => l.source === "COLD_LOCAL");
  return levels.map((level) => {
    const rows = cold.filter((l) => opportunity(l.siteCheck as SiteCheck | null, l.category).level === level);
    const called = rows.filter((l) => l.calls.length > 0);
    return {
      level,
      companies: rows.length,
      called: called.length,
      responded: called.filter(responded).length,
      won: rows.filter(isWon).length,
      respondRate: ratio(called.filter(responded).length, called.length),
    };
  });
}

// ─── Telegram и Kwork ────────────────────────────────────────────────────────

export function telegramChannelOf(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  const m = sourceRef.match(/^https:\/\/t\.me\/(?:c\/(\d+)|([\w\d_]+))\/\d+/);
  return m ? (m[2] ? `@${m[2]}` : `приватный ${m[1]}`) : null;
}

export function telegramChannels(leads: ReportLead[]) {
  const groups = new Map<string, ReportLead[]>();
  for (const l of leads.filter((x) => x.source === "TELEGRAM")) {
    const key = telegramChannelOf(l.sourceRef) ?? "без ссылки";
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.entries()]
    .map(([channel, rows]) => ({
      channel,
      leads: rows.length,
      qualified: rows.filter((l) => l.furthestStage >= 1).length,
      skipped: rows.filter((l) => l.status === "SKIPPED").length,
      responded: rows.filter(responded).length,
      won: rows.filter(isWon).length,
      avgScore: avg(rows.map((l) => l.score).filter((s): s is number => s != null)),
    }))
    .sort((a, b) => b.won - a.won || b.responded - a.responded || b.leads - a.leads);
}

/** Отклики: сколько отправлено и сколько заказчиков ответило — по типу сообщения. */
export function outreachStats(leads: ReportLead[]) {
  const channels = new Map<string, { sent: number; leads: Set<string>; responded: Set<string>; won: Set<string> }>();
  for (const l of leads) {
    for (const o of l.offers) {
      if (!o.sentAt) continue;
      const row = channels.get(o.channel) ?? { sent: 0, leads: new Set(), responded: new Set(), won: new Set() };
      row.sent++;
      row.leads.add(l.id);
      if (responded(l)) row.responded.add(l.id);
      if (isWon(l)) row.won.add(l.id);
      channels.set(o.channel, row);
    }
  }
  return [...channels.entries()].map(([channel, r]) => ({
    channel,
    sent: r.sent,
    leads: r.leads.size,
    responded: r.responded.size,
    won: r.won.size,
    respondRate: ratio(r.responded.size, r.leads.size),
  }));
}

// ─── Качество AI ─────────────────────────────────────────────────────────────

export const SCORE_BUCKETS = [
  { key: "0–39", min: 0, max: 39 },
  { key: "40–69", min: 40, max: 69 },
  { key: "70–100", min: 70, max: 100 },
] as const;

/** Калибровка: выше оценка — чаще доходят до ответа и сделки? Считаются только лиды, по которым ты уже решил. */
export function scoreCalibration(leads: ReportLead[]) {
  const decided = leads.filter((l) => l.score != null && l.status !== "NEW");
  return SCORE_BUCKETS.map((b) => {
    const rows = decided.filter((l) => l.score! >= b.min && l.score! <= b.max);
    return {
      bucket: b.key,
      leads: rows.length,
      skipped: rows.filter((l) => l.status === "SKIPPED").length,
      responded: rows.filter(responded).length,
      won: rows.filter(isWon).length,
      skipRate: ratio(rows.filter((l) => l.status === "SKIPPED").length, rows.length),
      respondRate: ratio(rows.filter(responded).length, rows.length),
    };
  });
}

/** Совпадение вердикта AI с твоим решением: взял в работу или пропустил. */
export function verdictAgreement(leads: ReportLead[]) {
  const decided = leads.filter((l) => l.aiVerdict && l.status !== "NEW");
  const tookIt = (l: ReportLead) => l.status !== "SKIPPED" && l.furthestStage >= 1;
  const rows = (["TAKE", "CONSIDER", "SKIP"] as const).map((verdict) => {
    const r = decided.filter((l) => l.aiVerdict === verdict);
    return { verdict, leads: r.length, taken: r.filter(tookIt).length, skipped: r.filter((l) => l.status === "SKIPPED").length };
  });
  const take = rows[0];
  const skip = rows[2];
  const clear = take.leads + skip.leads;
  return { rows, agreement: ratio(take.taken + skip.skipped, clear), disagreements: take.skipped + (skip.leads - skip.skipped) };
}

/** Доля изменённых слов между черновиком AI и отправленным текстом (0 — без правок, 1 — переписано). */
export function editRatio(aiText: string, finalText: string): number {
  const a = aiText.split(/\s+/).filter(Boolean).slice(0, 400);
  const b = finalText.split(/\s+/).filter(Boolean).slice(0, 400);
  if (!a.length && !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

export function draftEdits(leads: ReportLead[]) {
  const byChannel = new Map<string, number[]>();
  for (const l of leads) {
    for (const o of l.offers) {
      if (!o.sentAt || o.aiText == null) continue;
      byChannel.set(o.channel, [...(byChannel.get(o.channel) ?? []), editRatio(o.aiText, o.text)]);
    }
  }
  return [...byChannel.entries()].map(([channel, ratios]) => ({
    channel,
    sent: ratios.length,
    avgEdit: avg(ratios),
    unchanged: ratios.filter((r) => r < 0.05).length,
    rewritten: ratios.filter((r) => r > 0.5).length,
  }));
}

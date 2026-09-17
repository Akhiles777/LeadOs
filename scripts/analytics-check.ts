/**
 * Проверка расчётов аналитики на синтетических данных: pnpm test:analytics (БД не нужна).
 */
import assert from "node:assert/strict";
import {
  callOutcomes,
  draftEdits,
  editRatio,
  matchNiche,
  moneyStats,
  monthlyRevenue,
  nicheStats,
  opportunityOutcome,
  outreachStats,
  referralStats,
  type ReportLead,
  scoreCalibration,
  sourceFunnel,
  telegramChannelOf,
  telegramChannels,
  verdictAgreement,
} from "@/lib/report";

const D = (s: string) => new Date(s);
/** Выигранная сделка на сумму, оплаченная целиком в дату closedAt. */
const paidDeal = (amount: number, closedAt: string) => ({
  amount,
  closedAt: D(closedAt),
  paymentPlan: "FULL" as const,
  payments: [{ kind: "PART" as const, amount, dueDate: null, paidAt: D(closedAt) }],
  addons: [],
});
let n = 0;
function lead(p: Partial<ReportLead>): ReportLead {
  return {
    id: `l${++n}`,
    title: "t",
    source: "KWORK",
    status: "NEW",
    furthestStage: 0,
    category: null,
    sourceRef: null,
    createdAt: D("2026-09-01T10:00:00Z"),
    score: null,
    aiVerdict: null,
    referredById: null,
    siteCheck: null,
    deal: null,
    calls: [],
    offers: [],
    ...p,
  };
}

// Источники: воронка «дошли до этапа», выручка, срок закрытия
const kwork = [
  lead({ status: "WON", furthestStage: 5, deal: paidDeal(30000, "2026-09-11T10:00:00Z") }),
  lead({ status: "LOST", furthestStage: 4 }),
  lead({ status: "SKIPPED", furthestStage: 1 }),
  lead({ status: "NEW" }),
];
const [kw] = sourceFunnel(kwork);
assert.deepEqual(kw.reached, [4, 3, 2, 2, 2, 1]);
assert.equal(kw.won, 1);
assert.equal(kw.winRate, 0.25);
assert.equal(kw.revenue, 30000);
assert.equal(kw.contract, 30000);
assert.equal(kw.avgDaysToClose, 10);
assert.equal(sourceFunnel([]).length, 0, "пустые источники не показываются");

// Выручка по месяцам оплаты: 12 месяцев подряд, границы месяца по Москве, чаевые отдельно
const months = monthlyRevenue(
  [
    { amount: 10000, paidAt: D("2026-09-30T22:30:00Z"), kind: "PART" }, // 1 октября по Москве
    { amount: 5000, paidAt: D("2026-09-15T10:00:00Z"), kind: "PART" },
    { amount: 700, paidAt: D("2026-09-16T10:00:00Z"), kind: "TIP" },
    { amount: 3000, paidAt: D("2026-08-01T10:00:00Z"), kind: "ADDON" },
    { amount: 999, paidAt: D("2024-01-01T10:00:00Z"), kind: "PART" }, // за пределами окна
  ],
  12,
  D("2026-10-05T10:00:00Z"),
);
assert.equal(months.length, 12);
assert.equal(months.at(-1)!.month, "2026-10");
assert.equal(months.at(-1)!.revenue, 10000);
assert.deepEqual(months.at(-2), { month: "2026-09", revenue: 5000, tips: 700, payments: 2 });
assert.equal(months.at(-3)!.revenue, 3000);
assert.equal(months[0].month, "2025-11");
assert.equal(new Set(months.map((m) => m.month)).size, 12, "месяцы не повторяются (конец месяца)");
assert.equal(monthlyRevenue([], 12, D("2026-03-31T10:00:00Z")).map((m) => m.month).join(), monthlyRevenue([], 12, D("2026-03-15T10:00:00Z")).map((m) => m.month).join(), "31-е число не ломает шаг по месяцам");

// Деньги: договор с принятой опцией, частично оплачен, чаевые, просрочка
const moneyNow = D("2026-09-17T09:00:00Z");
const money = moneyStats(
  [
    lead({ status: "WON", furthestStage: 5, deal: paidDeal(40000, "2026-09-01T10:00:00Z") }),
    lead({
      status: "WON",
      furthestStage: 5,
      deal: {
        amount: 100000,
        closedAt: D("2026-09-10T10:00:00Z"),
        paymentPlan: "INSTALLMENTS",
        payments: [
          { kind: "PART", amount: 50000, dueDate: D("2026-09-01T10:00:00Z"), paidAt: D("2026-09-01T10:00:00Z") },
          { kind: "PART", amount: 70000, dueDate: D("2026-09-12T10:00:00Z"), paidAt: null },
          { kind: "TIP", amount: 2000, dueDate: null, paidAt: D("2026-09-12T10:00:00Z") },
        ],
        addons: [
          { price: 20000, status: "ACCEPTED", source: "ai" },
          { price: 10000, status: "DECLINED", source: null },
          { price: 5000, status: "PROPOSED", source: "ai" },
        ],
      },
    }),
    lead({ status: "WON", furthestStage: 5, deal: { amount: 15000, closedAt: null, paymentPlan: "FULL", payments: [], addons: [] } }),
    lead({ status: "LOST", deal: paidDeal(99999, "2026-09-01T10:00:00Z") }), // не выигран — не учитывается
  ],
  moneyNow,
);
assert.deepEqual(
  { ...money, avgAddonsShare: Math.round((money.avgAddonsShare ?? 0) * 1000) / 1000 },
  {
    deals: 3,
    contract: 175000,
    received: 90000,
    outstanding: 85000,
    overdue: 70000,
    tips: 2000,
    dealsWithTips: 1,
    installments: 1,
    withoutPayments: 1,
    addonsProposed: 3,
    addonsAccepted: 1,
    addonsAcceptRate: 0.5,
    addonsRevenue: 20000,
    aiAddonsAccepted: 1,
    avgAddonsShare: Math.round(((0 + 20000 / 120000 + 0) / 3) * 1000) / 1000,
  },
);

// Рекомендации: кто привёл клиентов и сколько они заплатили
const refs = referralStats(
  [
    lead({ referredById: "client-a", status: "WON", deal: paidDeal(50000, "2026-09-05T10:00:00Z") }),
    lead({ referredById: "client-a", status: "LOST" }),
    lead({ referredById: "client-b" }),
  ],
  new Map([["client-a", "Клиника «Улыбка»"]]),
);
assert.deepEqual(refs[0], { referrerId: "client-a", referrer: "Клиника «Улыбка»", leads: 2, won: 1, received: 50000 });
assert.equal(refs[1].referrer, "удалённый лид");

// Ниши: основы слов, самое точное совпадение, «Другое»
const niches = ["стоматология", "продуктовый магазин", "магазин строительных материалов", "ветеринарная клиника"];
assert.equal(matchNiche("Детская стоматология, стоматологическая клиника", niches), "стоматология");
assert.equal(matchNiche("Продуктовые магазины", niches), "продуктовый магазин");
assert.equal(matchNiche("Магазин строительных материалов, сантехника", niches), "магазин строительных материалов");
assert.equal(matchNiche("Ветеринарные клиники", niches), "ветеринарная клиника");
assert.equal(matchNiche("Автосервис", niches), null);

const call = (note: string) => ({ note, createdAt: D("2026-09-02T10:00:00Z") });
const cold = [
  lead({ source: "COLD_LOCAL", category: "Стоматология", calls: [call("Не дозвонился"), call("Интересно — обсуждаем")], status: "RESPONDED", furthestStage: 3, siteCheck: { status: "no_site", checkedAt: "" } }),
  lead({ source: "COLD_LOCAL", category: "Детская стоматология", calls: [call("Не интересно")], status: "LOST", furthestStage: 0, siteCheck: { status: "no_site", checkedAt: "" } }),
  lead({ source: "COLD_LOCAL", category: "Стоматология", status: "WON", furthestStage: 5, deal: paidDeal(120000, "2026-09-20T10:00:00Z"), calls: [call("Интересно — обсуждаем")], siteCheck: { status: "ok", checkedAt: "", https: true, mobile: true, hasBooking: true, hasAnalytics: true, hasCrmWidget: true } }),
  lead({ source: "COLD_LOCAL", category: "Автосервис" }),
];
const ns = nicheStats(cold, niches);
assert.equal(ns[0].niche, "стоматология");
assert.deepEqual(
  { companies: ns[0].companies, called: ns[0].called, calls: ns[0].calls, interested: ns[0].interestedCalls, responded: ns[0].responded, won: ns[0].won, revenue: ns[0].revenue },
  { companies: 3, called: 3, calls: 4, interested: 2, responded: 2, won: 1, revenue: 120000 },
);
assert.equal(ns[0].respondRate, 2 / 3);
assert.equal(ns.at(-1)!.niche, "Другое");
assert.deepEqual(callOutcomes(cold), { no_answer: 1, callback: 0, interested: 2, not_interested: 1, other: 0 });

const opp = opportunityOutcome(cold);
assert.deepEqual(opp.find((o) => o.level === "high"), { level: "high", companies: 2, called: 2, responded: 1, won: 0, respondRate: 0.5 });
assert.equal(opp.find((o) => o.level === "low")!.won, 1);
assert.equal(opp.find((o) => o.level === "unknown")!.companies, 1);

// Telegram-каналы
assert.equal(telegramChannelOf("https://t.me/devjobs/15"), "@devjobs");
assert.equal(telegramChannelOf("https://t.me/c/1234567890/5"), "приватный 1234567890");
assert.equal(telegramChannelOf("https://kwork.ru/projects/1"), null);
const tg = telegramChannels([
  lead({ source: "TELEGRAM", sourceRef: "https://t.me/devjobs/1", score: 80, status: "WON", furthestStage: 5 }),
  lead({ source: "TELEGRAM", sourceRef: "https://t.me/devjobs/2", score: 40, status: "SKIPPED", furthestStage: 0 }),
  lead({ source: "TELEGRAM", sourceRef: "https://t.me/noise/3", score: 10, status: "SKIPPED" }),
]);
assert.deepEqual(tg[0], { channel: "@devjobs", leads: 2, qualified: 1, skipped: 1, responded: 1, won: 1, avgScore: 60 });

// Отклики
const sent = (channel: string, aiText: string | null, text: string) => ({ channel, sentAt: D("2026-09-03T10:00:00Z"), aiText, text });
const out = outreachStats([
  lead({ offers: [sent("kwork_response", null, "a"), sent("follow_up", null, "b")], status: "RESPONDED", furthestStage: 3 }),
  lead({ offers: [sent("kwork_response", null, "c"), { channel: "kwork_response", sentAt: null, aiText: null, text: "d" }] }),
]);
assert.deepEqual(out.find((o) => o.channel === "kwork_response"), { channel: "kwork_response", sent: 2, leads: 2, responded: 1, won: 0, respondRate: 0.5 });

// Калибровка оценок и совпадение вердиктов
const scored = [
  lead({ score: 85, aiVerdict: "TAKE", status: "WON", furthestStage: 5 }),
  lead({ score: 75, aiVerdict: "TAKE", status: "SKIPPED", furthestStage: 0 }),
  lead({ score: 20, aiVerdict: "SKIP", status: "SKIPPED" }),
  lead({ score: 30, aiVerdict: "SKIP", status: "CONTACTED", furthestStage: 2 }),
  lead({ score: 50, aiVerdict: "CONSIDER", status: "NEW" }), // ещё не решено — не учитывается
];
const cal = scoreCalibration(scored);
assert.deepEqual(cal.map((c) => c.leads), [2, 0, 2]);
assert.equal(cal[2].respondRate, 0.5);
assert.equal(cal[0].skipRate, 0.5);
assert.equal(cal[1].respondRate, null);
const agr = verdictAgreement(scored);
assert.equal(agr.agreement, 0.5);
assert.equal(agr.disagreements, 2);
assert.equal(agr.rows[1].leads, 0);

// Правки черновиков
assert.equal(editRatio("один два три четыре", "один два три четыре"), 0);
assert.equal(editRatio("один два три четыре", "один два пять четыре"), 0.25);
assert.equal(editRatio("", ""), 0);
assert.equal(editRatio("а б", ""), 1);
const edits = draftEdits([
  lead({ offers: [sent("kwork_response", "Здравствуйте! Сделаю сайт быстро", "Здравствуйте! Сделаю сайт быстро"), sent("kwork_response", "a b c d", "x y z w"), sent("kwork_response", null, "руками")] }),
]);
assert.deepEqual(edits, [{ channel: "kwork_response", sent: 2, avgEdit: 0.5, unchanged: 1, rewritten: 1 }]);

console.log("analytics: все проверки пройдены");

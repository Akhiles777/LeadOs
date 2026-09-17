/** Проверка расчётов по деньгам: pnpm test:money (без БД). */
import assert from "node:assert/strict";
import { dealTotals, isOverdue, type MoneyDeal, partTitles, scheduleDates, splitAmount } from "@/lib/money";

const now = new Date("2026-09-17T09:00:00Z"); // 12:00 по Москве
const D = (s: string) => new Date(s);

// Делёж: сумма частей всегда равна исходной
assert.deepEqual(splitAmount(100000, [50, 50]), [50000, 50000]);
assert.deepEqual(splitAmount(100000, [1, 1, 1]), [33300, 33300, 33400]);
assert.deepEqual(splitAmount(45750, [30, 70]), [13700, 32050]);
assert.deepEqual(splitAmount(250, [1, 1, 1]), [83, 83, 84], "мелкая сумма делится без округления");
assert.deepEqual(splitAmount(0, [50, 50]), []);
for (const [t, s] of [[99999, [30, 40, 30]], [12345, [1, 1, 1, 1]], [777, [50, 50]]] as const) assert.equal(splitAmount(t, s).reduce((a, b) => a + b, 0), t);
assert.deepEqual(partTitles("3eq", 3), ["Часть 1 из 3", "Часть 2 из 3", "Часть 3 из 3"]);
assert.equal(scheduleDates(D("2026-09-20T09:00:00Z"), 3, 14)[2].toISOString(), "2026-10-18T09:00:00.000Z");

// Просрочка — по календарному дню в поясе приложения, срок «сегодня» ещё не просрочен
assert.equal(isOverdue({ kind: "PART", amount: 1, dueDate: D("2026-09-17T09:00:00Z"), paidAt: null }, now), false);
assert.equal(isOverdue({ kind: "PART", amount: 1, dueDate: D("2026-09-16T09:00:00Z"), paidAt: null }, now), true);
assert.equal(isOverdue({ kind: "PART", amount: 1, dueDate: D("2026-09-16T09:00:00Z"), paidAt: now }, now), false);

// Частями + принятая опция + чаевые
const deal: MoneyDeal = {
  amount: 100000,
  paymentPlan: "INSTALLMENTS",
  addons: [
    { price: 20000, status: "ACCEPTED" },
    { price: 15000, status: "PROPOSED" },
    { price: 9000, status: "DECLINED" },
  ],
  payments: [
    { kind: "PART", title: "Предоплата", amount: 50000, dueDate: D("2026-09-01T09:00:00Z"), paidAt: D("2026-09-02T09:00:00Z") },
    { kind: "PART", title: "После сдачи", amount: 50000, dueDate: D("2026-09-10T09:00:00Z"), paidAt: null },
    { kind: "ADDON", title: "Онлайн-запись", amount: 20000, dueDate: D("2026-09-30T09:00:00Z"), paidAt: null },
    { kind: "TIP", amount: 3000, dueDate: null, paidAt: D("2026-09-12T09:00:00Z") },
  ],
};
const t = dealTotals(deal, now);
assert.deepEqual(
  { contract: t.contract, paid: t.paid, tips: t.tips, outstanding: t.outstanding, scheduled: t.scheduled, unscheduled: t.unscheduled, addonsProposed: t.addonsProposed, status: t.status },
  { contract: 120000, paid: 50000, tips: 3000, outstanding: 70000, scheduled: 70000, unscheduled: 0, addonsProposed: 15000, status: "partial" },
);
assert.equal(t.overdue.length, 1);
assert.equal(t.overdue[0].title, "После сдачи");
assert.equal(t.nextDue?.title, "Онлайн-запись");
assert.equal(Math.round(t.progress * 100), 42);

// Переплата, без суммы, целиком
assert.equal(dealTotals({ amount: 10000, paymentPlan: "FULL", addons: [], payments: [{ kind: "PART", amount: 12000, dueDate: null, paidAt: now }] }, now).overpaid, 2000);
assert.equal(dealTotals({ amount: null, paymentPlan: "FULL", addons: [], payments: [] }, now).status, "no_amount");
const unplanned = dealTotals({ amount: 40000, paymentPlan: "FULL", addons: [], payments: [] }, now);
assert.deepEqual([unplanned.status, unplanned.unscheduled, unplanned.nextDue], ["unpaid", 40000, null]);
assert.equal(dealTotals({ amount: 0, paymentPlan: "FULL", addons: [], payments: [{ kind: "TIP", amount: 500, dueDate: null, paidAt: now }] }, now).status, "no_amount", "одни чаевые не делают сделку оплаченной");

console.log("money: все проверки пройдены");

/**
 * Деньги по сделке — чистые функции, проверяются scripts/money-check.ts.
 *
 * Договор = сумма за основную работу + принятые доп. опции.
 * Получено = оплаченные части и оплаты опций (без чаевых). Чаевые считаются отдельно и остаток не уменьшают.
 */
import { dayKey } from "@/lib/time";

export type MoneyPayment = {
  id?: string;
  kind: "PART" | "TIP" | "ADDON";
  amount: number;
  dueDate: Date | null;
  paidAt: Date | null;
  title?: string | null;
};
export type MoneyAddon = { id?: string; price: number; status: "PROPOSED" | "ACCEPTED" | "DECLINED" };
export type MoneyDeal = { amount: number | null; paymentPlan: "FULL" | "INSTALLMENTS"; payments: MoneyPayment[]; addons: MoneyAddon[] };

export type DealTotals = {
  contract: number;
  base: number;
  addonsAccepted: number;
  addonsProposed: number;
  paid: number;
  tips: number;
  outstanding: number;
  overpaid: number;
  scheduled: number; // запланировано, но не оплачено
  unscheduled: number; // остаток, на который нет ни оплаты, ни плана
  overdue: MoneyPayment[];
  nextDue: MoneyPayment | null;
  progress: number; // 0..1
  status: "no_amount" | "paid" | "partial" | "unpaid";
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function isOverdue(p: MoneyPayment, now = new Date()): boolean {
  return !p.paidAt && p.dueDate != null && dayKey(p.dueDate) < dayKey(now);
}

export function dealTotals(deal: MoneyDeal, now = new Date()): DealTotals {
  const base = deal.amount ?? 0;
  const addonsAccepted = sum(deal.addons.filter((a) => a.status === "ACCEPTED").map((a) => a.price));
  const addonsProposed = sum(deal.addons.filter((a) => a.status === "PROPOSED").map((a) => a.price));
  const contract = base + addonsAccepted;

  const work = deal.payments.filter((p) => p.kind !== "TIP");
  const paid = sum(work.filter((p) => p.paidAt).map((p) => p.amount));
  const tips = sum(deal.payments.filter((p) => p.kind === "TIP" && p.paidAt).map((p) => p.amount));
  const scheduled = sum(work.filter((p) => !p.paidAt).map((p) => p.amount));
  const outstanding = Math.max(contract - paid, 0);
  const upcoming = work.filter((p) => !p.paidAt && p.dueDate).sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime());

  return {
    contract,
    base,
    addonsAccepted,
    addonsProposed,
    paid,
    tips,
    outstanding,
    overpaid: Math.max(paid - contract, 0),
    scheduled,
    unscheduled: Math.max(outstanding - scheduled, 0),
    overdue: upcoming.filter((p) => isOverdue(p, now)),
    nextDue: upcoming.find((p) => !isOverdue(p, now)) ?? null,
    progress: contract > 0 ? Math.min(paid / contract, 1) : 0,
    status: contract === 0 && paid === 0 ? "no_amount" : paid >= contract && contract > 0 ? "paid" : paid > 0 ? "partial" : "unpaid",
  };
}

export const SPLIT_PRESETS = {
  full: { label: "Целиком", shares: [100] },
  "50/50": { label: "50% предоплата, 50% после сдачи", shares: [50, 50] },
  "30/70": { label: "30% предоплата, 70% после сдачи", shares: [30, 70] },
  "30/40/30": { label: "30 / 40 / 30 по этапам", shares: [30, 40, 30] },
  "3eq": { label: "Три равные части", shares: [1, 1, 1] },
  "4eq": { label: "Четыре равные части", shares: [1, 1, 1, 1] },
} as const;
export type SplitPreset = keyof typeof SPLIT_PRESETS;

/**
 * Делит сумму по долям. Части округляются до сотни рублей, остаток уходит в последнюю часть,
 * чтобы сумма частей всегда равнялась исходной.
 */
export function splitAmount(total: number, shares: readonly number[], roundTo = 100): number[] {
  if (total <= 0 || !shares.length) return [];
  const weight = sum([...shares]);
  const parts = shares.map((s) => Math.floor(((total * s) / weight) / roundTo) * roundTo);
  parts[parts.length - 1] += total - sum(parts);
  if (parts.some((p) => p <= 0)) {
    // сумма слишком мала для округления — делим без округления
    const raw = shares.map((s) => Math.floor((total * s) / weight));
    raw[raw.length - 1] += total - sum(raw);
    return raw;
  }
  return parts;
}

export function partTitles(preset: SplitPreset, count: number): string[] {
  if (preset === "full") return ["Оплата целиком"];
  if (preset === "50/50" || preset === "30/70") return ["Предоплата", "Оплата после сдачи"];
  return Array.from({ length: count }, (_, i) => `Часть ${i + 1} из ${count}`);
}

/** Даты частей: первая — firstDue, дальше через intervalDays. */
export function scheduleDates(firstDue: Date, count: number, intervalDays: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(firstDue.getTime() + i * intervalDays * 86_400_000));
}

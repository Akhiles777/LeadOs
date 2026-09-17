"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { PaymentKind } from "@/generated/prisma/enums";
import { suggestAddons } from "@/ai/tasks/addons";
import type { FormState } from "@/lib/actions";
import type { AiActionResult } from "@/lib/ai-actions";
import { db } from "@/lib/db";
import { optDate, optInt } from "@/lib/lead-input";
import { dealTotals, partTitles, scheduleDates, SPLIT_PRESETS, type SplitPreset, splitAmount } from "@/lib/money";
import { parseDateInput } from "@/lib/time";

function refresh(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
  revalidatePath("/analytics");
  revalidatePath("/leads");
}

async function dealWithLead(dealId: string) {
  return db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { payments: true, addons: true } });
}

const basicsSchema = z.object({
  amount: optInt,
  stage: z.string().trim().min(1, "Укажи этап").max(100).default("Старт"),
  startedAt: optDate,
  closedAt: optDate,
  paymentPlan: z.enum(["FULL", "INSTALLMENTS"]).default("FULL"),
});

export async function saveDealBasics(leadId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = basicsSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$"))));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await db.deal.upsert({ where: { leadId }, create: { leadId, ...parsed.data }, update: parsed.data });
  refresh(leadId);
  return { ok: true };
}

/**
 * Разбивает неоплаченный остаток договора на части по шаблону. Оплаченные части не трогает,
 * запланированные, но не оплаченные — заменяет.
 */
export async function planPayments(dealId: string, preset: SplitPreset, firstDue: string, intervalDays: number): Promise<AiActionResult> {
  if (!(preset in SPLIT_PRESETS)) return { error: "Неизвестный шаблон" };
  const deal = await dealWithLead(dealId);
  const totals = dealTotals(deal);
  const remaining = totals.contract - totals.paid;
  if (totals.contract <= 0) return { error: "Сначала укажи сумму сделки" };
  if (remaining <= 0) return { error: "Договор уже оплачен полностью" };

  const shares = SPLIT_PRESETS[preset].shares;
  const amounts = splitAmount(remaining, shares);
  const start = parseDateInput(firstDue) ?? new Date();
  const dates = scheduleDates(start, amounts.length, Math.max(1, Math.min(365, Math.round(intervalDays) || 14)));
  const titles = partTitles(preset, amounts.length);

  await db.$transaction([
    db.payment.deleteMany({ where: { dealId, paidAt: null, kind: { in: ["PART", "ADDON"] } } }),
    db.payment.createMany({ data: amounts.map((amount, i) => ({ dealId, kind: "PART" as const, title: titles[i], amount, dueDate: dates[i] })) }),
    db.deal.update({ where: { id: dealId }, data: { paymentPlan: amounts.length > 1 ? "INSTALLMENTS" : "FULL" } }),
  ]);
  refresh(deal.leadId);
  return { ok: true };
}

const paymentSchema = z.object({
  kind: z.enum(["PART", "TIP", "ADDON"]).default("PART"),
  title: z.string().trim().max(200).default(""),
  amount: optInt,
  dueDate: optDate,
  paidAt: optDate,
  method: z.string().trim().max(100).default(""),
  addonId: z.string().trim().default(""),
  note: z.string().trim().max(1000).default(""),
});

export async function addPayment(dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = paymentSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$"))));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const p = parsed.data;
  if (!p.amount || p.amount <= 0) return { error: "Укажи сумму больше нуля" };
  if (p.kind === "TIP" && !p.paidAt) p.paidAt = new Date();
  const deal = await dealWithLead(dealId);
  if (p.addonId && !deal.addons.some((a) => a.id === p.addonId)) return { error: "Опция не найдена" };

  await db.payment.create({
    data: {
      dealId,
      kind: p.kind as PaymentKind,
      title: p.title || (p.kind === "TIP" ? "Чаевые" : null),
      amount: p.amount,
      dueDate: p.dueDate,
      paidAt: p.paidAt,
      method: p.method || null,
      addonId: p.addonId || null,
      note: p.note || null,
    },
  });
  refresh(deal.leadId);
  return { ok: true };
}

export async function setPaymentPaid(paymentId: string, paid: boolean, method?: string) {
  const payment = await db.payment.update({
    where: { id: paymentId },
    data: { paidAt: paid ? new Date() : null, ...(method !== undefined && { method: method || null }) },
    select: { deal: { select: { leadId: true } } },
  });
  refresh(payment.deal.leadId);
}

export async function deletePayment(paymentId: string) {
  const payment = await db.payment.delete({ where: { id: paymentId }, select: { deal: { select: { leadId: true } } } });
  refresh(payment.deal.leadId);
}

/** «Оплачено целиком» для сделки без графика: одна часть на весь неоплаченный остаток. */
export async function markDealPaidInFull(dealId: string, method: string): Promise<AiActionResult> {
  const deal = await dealWithLead(dealId);
  const totals = dealTotals(deal);
  const remaining = totals.contract - totals.paid;
  if (totals.contract <= 0) return { error: "Сначала укажи сумму сделки" };
  if (remaining <= 0) return { error: "Уже оплачено" };
  await db.$transaction([
    db.payment.deleteMany({ where: { dealId, paidAt: null, kind: { in: ["PART", "ADDON"] } } }),
    db.payment.create({ data: { dealId, kind: "PART", title: totals.paid ? "Оплата остатка" : "Оплата целиком", amount: remaining, paidAt: new Date(), method: method || null } }),
  ]);
  refresh(deal.leadId);
  return { ok: true };
}

const addonSchema = z.object({
  title: z.string().trim().min(1, "Название опции").max(200),
  price: optInt,
  description: z.string().trim().max(2000).default(""),
  status: z.enum(["PROPOSED", "ACCEPTED", "DECLINED"]).default("PROPOSED"),
});

export async function addAddon(dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = addonSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$"))));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (!parsed.data.price || parsed.data.price <= 0) return { error: "Укажи цену" };
  const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, select: { leadId: true } });
  await db.dealAddon.create({
    data: {
      dealId,
      title: parsed.data.title,
      price: parsed.data.price,
      description: parsed.data.description || null,
      status: parsed.data.status,
      decidedAt: parsed.data.status === "PROPOSED" ? null : new Date(),
    },
  });
  refresh(deal.leadId);
  return { ok: true };
}

export async function setAddonStatus(addonId: string, status: "PROPOSED" | "ACCEPTED" | "DECLINED") {
  const addon = await db.dealAddon.update({
    where: { id: addonId },
    data: { status, decidedAt: status === "PROPOSED" ? null : new Date() },
    select: { deal: { select: { leadId: true } } },
  });
  // Отклонённая опция не должна висеть в неоплаченном графике.
  if (status !== "ACCEPTED") await db.payment.deleteMany({ where: { addonId, paidAt: null } });
  refresh(addon.deal.leadId);
}

export async function deleteAddon(addonId: string) {
  const addon = await db.dealAddon.findUniqueOrThrow({ where: { id: addonId }, select: { deal: { select: { leadId: true } }, payments: { where: { paidAt: { not: null } }, select: { id: true } } } });
  if (addon.payments.length) throw new Error("По опции есть оплата — сначала отмени её");
  await db.dealAddon.delete({ where: { id: addonId } });
  refresh(addon.deal.leadId);
}

export async function suggestAddonsNow(leadId: string): Promise<AiActionResult> {
  try {
    const n = await suggestAddons(leadId);
    refresh(leadId);
    return n ? { ok: true } : { error: "AI не нашёл новых опций для этой сделки" };
  } catch (e) {
    const { aiErrorMessage } = await import("@/lib/ai-errors");
    return { error: aiErrorMessage(e) };
  }
}

/** Отметки для повторных продаж: попросил отзыв/рекомендацию, предложил доработки. */
export async function markRetention(dealId: string, kind: "referral" | "upsell", done: boolean) {
  const deal = await db.deal.update({
    where: { id: dealId },
    data: kind === "referral" ? { referralAskedAt: done ? new Date() : null } : { upsellAt: done ? new Date() : null },
    select: { leadId: true },
  });
  refresh(deal.leadId);
}

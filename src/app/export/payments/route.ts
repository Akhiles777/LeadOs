import { db } from "@/lib/db";
import { csvResponse, toCsv } from "@/lib/export";
import { dayKey } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KIND = { PART: "Оплата", TIP: "Чаевые", ADDON: "Доп. опция" } as const;

/** Все платежи: полученные и запланированные — для учёта доходов и налогов. */
export async function GET() {
  const payments = await db.payment.findMany({
    orderBy: [{ paidAt: "asc" }, { dueDate: "asc" }],
    include: { deal: { select: { lead: { select: { title: true, id: true } } } }, addon: { select: { title: true } } },
  });
  const date = (d: Date | null) => (d ? dayKey(d).split("-").reverse().join(".") : "");
  const rows = payments.map((p) => [
    date(p.paidAt),
    date(p.dueDate),
    p.paidAt ? "получен" : "ожидается",
    p.amount,
    KIND[p.kind],
    p.title ?? p.addon?.title,
    p.method,
    p.deal.lead.title,
    p.note,
    p.deal.lead.id,
  ]);
  return csvResponse(
    `leados-payments-${dayKey(new Date())}.csv`,
    toCsv(["Дата оплаты", "Срок", "Статус", "Сумма", "Тип", "Назначение", "Способ", "Клиент", "Заметка", "ID лида"], rows),
  );
}

import { db } from "@/lib/db";
import { csvResponse, toCsv } from "@/lib/export";
import { SOURCE_LABEL, STATUS_LABEL } from "@/lib/leads";
import { dealTotals } from "@/lib/money";
import { dayKey } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Все лиды со сделками — для бэкапа, бухгалтерии и переноса. Формат совместим с «Импортом». Закрыто паролем, как весь интерфейс. */
export async function GET() {
  const leads = await db.lead.findMany({
    orderBy: { createdAt: "asc" },
    include: { deal: { include: { payments: true, addons: true } }, referredBy: { select: { title: true } } },
  });
  const date = (d: Date | null | undefined) => (d ? dayKey(d).split("-").reverse().join(".") : "");

  const rows = leads.map((l) => {
    const t = l.deal ? dealTotals(l.deal) : null;
    return [
      date(l.createdAt),
      l.title,
      SOURCE_LABEL[l.source],
      STATUS_LABEL[l.status],
      l.category,
      l.region,
      l.contactName,
      l.contactPhone,
      l.contactTg,
      l.contactEmail,
      l.website,
      l.sourceRef,
      l.budgetMin,
      l.budgetMax,
      t?.contract ?? l.deal?.amount ?? "",
      t?.paid ?? "",
      t?.tips ?? "",
      t?.outstanding ?? "",
      l.deal?.addons.filter((a) => a.status === "ACCEPTED").map((a) => `${a.title} (${a.price})`).join(", ") ?? "",
      date(l.deal?.closedAt),
      l.referredBy?.title,
      l.score,
      l.rawText,
      l.id,
    ];
  });

  const headers = [
    "Дата",
    "Клиент",
    "Источник",
    "Статус",
    "Ниша",
    "Город",
    "Контакт",
    "Телефон",
    "Telegram",
    "Email",
    "Сайт",
    "Ссылка",
    "Бюджет от",
    "Бюджет до",
    "Сумма",
    "Оплачено",
    "Чаевые",
    "Остаток",
    "Доп. опции",
    "Дата сдачи",
    "Кто порекомендовал",
    "Оценка AI",
    "Комментарий",
    "ID",
  ];
  return csvResponse(`leados-leads-${dayKey(new Date())}.csv`, toCsv(headers, rows));
}

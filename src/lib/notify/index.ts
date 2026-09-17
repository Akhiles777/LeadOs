import { db } from "@/lib/db";
import { daysSince, formatBudget, formatDate, staleDays } from "@/lib/leads";
import { getNotificationSettings } from "@/lib/notify/settings";
import { appLink, botConfigured, escapeHtml, sendTelegram } from "@/lib/notify/telegram-bot";
import { dayKey } from "@/lib/time";

/**
 * Отправка с защитой от повторов: одно и то же событие (ключ) уходит один раз, даже если cron повторился
 * или одновременно работают воркер и Vercel. Неудачная отправка повторится при следующем запуске.
 */
export async function notifyOnce(key: string, html: string): Promise<"sent" | "skipped" | "disabled"> {
  const settings = await getNotificationSettings();
  if (!botConfigured() || !settings.chatId) return "disabled";
  const existing = await db.notificationLog.findUnique({ where: { key } });
  if (existing?.ok) return "skipped";

  // Застолбить ключ до отправки, чтобы параллельный запуск не отправил то же самое.
  try {
    if (!existing) await db.notificationLog.create({ data: { key, ok: false, error: "sending" } });
    else {
      const claimed = await db.notificationLog.updateMany({ where: { key, ok: false, sentAt: { lt: new Date(Date.now() - 60_000) } }, data: { sentAt: new Date(), error: "sending" } });
      if (!claimed.count) return "skipped";
    }
  } catch {
    return "skipped"; // ключ только что создал параллельный процесс
  }

  try {
    await sendTelegram(settings.chatId, html);
    await db.notificationLog.update({ where: { key }, data: { ok: true, error: null, sentAt: new Date() } });
    return "sent";
  } catch (e) {
    await db.notificationLog.update({ where: { key }, data: { ok: false, error: e instanceof Error ? e.message.slice(0, 1000) : String(e) } });
    throw e;
  }
}

const rub = (n: number) => `${n.toLocaleString("ru-RU")} ₽`;

/** Утренняя сводка. Пустых разделов нет; если делать нечего — null и ничего не отправляется. */
export async function buildDailyMessage(now = new Date()): Promise<string | null> {
  const day = dayKey(now);
  const endOfTomorrow = new Date(now.getTime() + 2 * 86_400_000);
  const staleThreshold = new Date(now.getTime() - staleDays() * 86_400_000);

  const [digest, stale, payments, calls, referral, upsell] = await Promise.all([
    db.digest.findUnique({ where: { day } }),
    db.lead.findMany({
      where: {
        OR: [
          { status: { in: ["CONTACTED", "NEGOTIATING"] }, lastActivityAt: { lt: staleThreshold } },
          { status: { notIn: ["WON", "LOST", "SKIPPED"] }, followUpAt: { lte: now }, source: { not: "COLD_LOCAL" } },
        ],
      },
      orderBy: { lastActivityAt: "asc" },
      take: 8,
      select: { id: true, title: true, lastActivityAt: true, offers: { where: { channel: "follow_up", sentAt: null }, take: 1, select: { id: true } } },
    }),
    db.payment.findMany({
      where: { paidAt: null, kind: { not: "TIP" }, dueDate: { lte: endOfTomorrow } },
      orderBy: { dueDate: "asc" },
      take: 10,
      select: { amount: true, title: true, dueDate: true, deal: { select: { lead: { select: { id: true, title: true } } } } },
    }),
    db.lead.count({ where: { source: "COLD_LOCAL", status: { notIn: ["WON", "LOST", "SKIPPED"] }, followUpAt: { lte: now } } }),
    db.deal.count({ where: { lead: { status: "WON" }, referralAskedAt: null, closedAt: { lte: new Date(now.getTime() - 14 * 86_400_000) } } }),
    db.deal.count({ where: { lead: { status: "WON" }, upsellAt: null, closedAt: { lte: new Date(now.getTime() - 90 * 86_400_000) } } }),
  ]);

  const sections: string[] = [];

  const summary = digest?.summary as { headline?: string; top?: { leadId: string; why: string }[] } | null;
  if (digest && digest.leadIds.length) {
    const topIds = (summary?.top ?? []).map((t) => t.leadId);
    const topLeads = topIds.length ? await db.lead.findMany({ where: { id: { in: topIds } }, select: { id: true, title: true, score: true, budgetMin: true, budgetMax: true } }) : [];
    const lines = (summary?.top ?? [])
      .slice(0, 3)
      .map((t) => {
        const l = topLeads.find((x) => x.id === t.leadId);
        return l ? `• ${appLink(`/leads/${l.id}`, l.title)}${l.score != null ? ` — ${l.score}` : ""}, ${escapeHtml(formatBudget(l.budgetMin, l.budgetMax))}\n  ${escapeHtml(t.why)}` : null;
      })
      .filter(Boolean);
    sections.push(
      [`<b>📬 Новых лидов за сутки: ${digest.leadIds.length}</b>`, summary?.headline ? escapeHtml(summary.headline) : "", ...lines, appLink("/digest", "Весь дайджест")].filter(Boolean).join("\n"),
    );
  }

  if (payments.length) {
    sections.push(
      [
        "<b>💸 Оплаты</b>",
        ...payments.map((p) => {
          const late = p.dueDate! < now && dayKey(p.dueDate!) < day;
          return `• ${late ? "просрочено" : dayKey(p.dueDate!) === day ? "сегодня" : "завтра"}: ${escapeHtml(rub(p.amount))} — ${appLink(`/leads/${p.deal.lead.id}`, p.deal.lead.title)}${p.title ? ` (${escapeHtml(p.title)})` : ""}${late ? `, срок был ${formatDate(p.dueDate!)}` : ""}`;
        }),
      ].join("\n"),
    );
  }

  if (stale.length) {
    sections.push(
      [
        "<b>⏳ Follow-up</b>",
        ...stale.map((l) => `• ${appLink(`/leads/${l.id}`, l.title)} — тишина ${daysSince(l.lastActivityAt, now)} дн.${l.offers.length ? ", черновик готов" : ""}`),
      ].join("\n"),
    );
  }

  if (calls) sections.push(`<b>📞 Перезвонить сегодня:</b> ${calls} — ${appLink("/prospecting", "список обзвона")}`);
  if (referral || upsell) {
    sections.push(
      [
        "<b>🔁 Повторные продажи</b>",
        referral ? `• попросить отзыв и рекомендацию: ${referral}` : "",
        upsell ? `• предложить доработки: ${upsell}` : "",
        appLink("/", "на дашборде"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!sections.length) return null;
  return [`<b>LeadOS · ${formatDate(now)}</b>`, ...sections].join("\n\n");
}

export async function sendDailyNotification(now = new Date()): Promise<"sent" | "skipped" | "disabled" | "empty"> {
  const settings = await getNotificationSettings();
  if (!settings.daily || !botConfigured() || !settings.chatId) return "disabled";
  const key = `daily:${dayKey(now)}`;
  if ((await db.notificationLog.findUnique({ where: { key } }))?.ok) return "skipped";
  const message = await buildDailyMessage(now);
  if (!message) return "empty";
  return notifyOnce(key, message);
}

/** Горячий лид: высокая оценка у свежего нового лида — чтобы откликнуться первым. */
export async function notifyHotLead(leadId: string) {
  const settings = await getNotificationSettings();
  if (!settings.hotLeads) return "disabled" as const;
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, title: true, source: true, status: true, score: true, scoreReason: true, budgetMin: true, budgetMax: true, createdAt: true, sourceRef: true },
  });
  if (!lead || lead.score == null || lead.score < settings.hotThreshold || lead.status !== "NEW") return "skipped" as const;
  if (Date.now() - lead.createdAt.getTime() > 24 * 3_600_000) return "skipped" as const;
  const text = [
    `<b>🔥 ${lead.score} · ${appLink(`/leads/${lead.id}`, lead.title)}</b>`,
    escapeHtml(formatBudget(lead.budgetMin, lead.budgetMax)),
    lead.scoreReason ? escapeHtml(lead.scoreReason) : "",
    lead.sourceRef?.startsWith("https://") ? `<a href="${escapeHtml(lead.sourceRef)}">Открыть в источнике</a>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return notifyOnce(`hot:${lead.id}`, text);
}

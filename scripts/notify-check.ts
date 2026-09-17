/**
 * Уведомления без настоящего Telegram: pnpm test:notify
 * fetch подменяется; работает с БД из DATABASE_URL и удаляет всё, что создал.
 */
import "dotenv/config";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
process.env.TELEGRAM_CHAT_ID = "999";
process.env.APP_URL = "https://leads.example.ru";

const sent: { method: string; body: Record<string, unknown> }[] = [];
let failNext = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const method = String(url).split("/").pop()!;
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (method === "getUpdates") {
    return new Response(JSON.stringify({ ok: true, result: [
      { message: { text: "/start", chat: { id: 111, type: "group" } } },
      { message: { text: "/start", chat: { id: 555, type: "private", username: "freelancer" } } },
      { message: { text: "привет", chat: { id: 777, type: "private" } } },
    ] }));
  }
  sent.push({ method, body });
  if (failNext > 0) {
    failNext--;
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }));
}) as typeof fetch;

async function main() {
  const { db } = await import("@/lib/db");
  const { buildDailyMessage, notifyHotLead, notifyOnce, sendDailyNotification } = await import("@/lib/notify");
  const { escapeHtml, findStartChat, splitMessage } = await import("@/lib/notify/telegram-bot");
  const { dayKey } = await import("@/lib/time");

  const MARK = `NOTIFY-CHECK-${Date.now()}`;
  const started = new Date();

  try {
    // Разметка и нарезка
    assert.equal(escapeHtml(`<b>Тест & "Ко"</b>`), `&lt;b&gt;Тест &amp; "Ко"&lt;/b&gt;`);
    const long = Array.from({ length: 300 }, (_, i) => `строка ${i} ${"x".repeat(20)}`).join("\n");
    const parts = splitMessage(long, 1000);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));
    assert.equal(parts.join("\n"), long, "ничего не потеряно");
    assert.equal(splitMessage("x".repeat(50), 10)[0].length <= 10, true);

    // Поиск чата: только личный чат с /start
    assert.deepEqual(await findStartChat(), { chatId: "555", name: "@freelancer" });

    // Один ключ — одно сообщение, даже при одновременных вызовах
    const key = `${MARK}:once`;
    const results = await Promise.all([notifyOnce(key, "a"), notifyOnce(key, "a"), notifyOnce(key, "a")]);
    assert.equal(results.filter((r) => r === "sent").length, 1, `одна отправка из трёх: ${results}`);
    assert.equal(await notifyOnce(key, "a"), "skipped");

    // Ошибка Telegram — ключ не помечен отправленным, следующая попытка (через минуту) проходит
    const failKey = `${MARK}:fail`;
    failNext = 1;
    await assert.rejects(notifyOnce(failKey, "b"), /chat not found/);
    assert.equal((await db.notificationLog.findUnique({ where: { key: failKey } }))?.ok, false);
    await db.notificationLog.update({ where: { key: failKey }, data: { sentAt: new Date(Date.now() - 120_000) } });
    assert.equal(await notifyOnce(failKey, "b"), "sent");

    // Утренняя сводка: оплаты, follow-up, звонки, дайджест; ссылки ведут на APP_URL
    const now = new Date();
    const client = await db.lead.create({
      data: {
        title: `${MARK} Клиника <Улыбка>`,
        source: "REFERRAL",
        status: "WON",
        furthestStage: 5,
        rawText: "",
        deal: { create: { amount: 100000, closedAt: new Date(now.getTime() - 20 * 86_400_000), payments: { create: [{ amount: 50000, title: "Вторая часть", dueDate: new Date(now.getTime() - 2 * 86_400_000) }] } } },
      },
    });
    const stale = await db.lead.create({
      data: { title: `${MARK} Зависший`, source: "KWORK", status: "CONTACTED", furthestStage: 2, rawText: "", lastActivityAt: new Date(now.getTime() - 30 * 86_400_000), offers: { create: { channel: "follow_up", text: "…" } } },
    });
    await db.lead.create({ data: { title: `${MARK} Перезвонить`, source: "COLD_LOCAL", rawText: "", followUpAt: new Date(now.getTime() - 3_600_000) } });
    const hot = await db.lead.create({ data: { title: `${MARK} Горячий`, source: "KWORK", rawText: "", score: 88, scoreReason: "Бюджет и стек подходят", budgetMax: 60000, sourceRef: "https://kwork.ru/projects/1" } });
    const existingDigest = await db.digest.findUnique({ where: { day: dayKey(now) } });
    if (!existingDigest) {
      await db.digest.create({ data: { day: dayKey(now), periodStart: new Date(now.getTime() - 86_400_000), periodEnd: now, leadIds: [hot.id], summary: { headline: "Один сильный заказ", top: [{ leadId: hot.id, why: "Стек совпадает" }], skipNote: "" } } });
    }

    const text = (await buildDailyMessage(now))!.replace(/\u00a0/g, " ");
  if (process.env.DEBUG_NOTIFY) console.log(text);
    assert.ok(text.includes("Оплаты") && text.includes("просрочено") && text.includes("50 000 ₽"), "просроченная часть в сводке");
    assert.ok(text.includes(`href="https://leads.example.ru/leads/${client.id}"`), "ссылка на лид");
    assert.ok(text.includes("Клиника &lt;Улыбка&gt;"), "название экранировано");
    assert.ok(text.includes("Зависший") && text.includes("черновик готов"));
    assert.ok(/Перезвонить сегодня:<\/b> \d+/.test(text));
    assert.ok(text.includes("попросить отзыв и рекомендацию"));
    if (!existingDigest) assert.ok(text.includes("Один сильный заказ") && text.includes("Стек совпадает"));

    // Сводка за день уходит один раз; горячий лид — один раз и только выше порога
    const dailyKey = `daily:${dayKey(now)}`;
    const hadDaily = await db.notificationLog.findUnique({ where: { key: dailyKey } });
    if (!hadDaily) {
      assert.equal(await sendDailyNotification(now), "sent");
      assert.equal(await sendDailyNotification(now), "skipped");
    }
    assert.equal(await notifyHotLead(hot.id), "sent");
    assert.equal(await notifyHotLead(hot.id), "skipped");
    assert.ok(String(sent.at(-1)!.body.text).includes("🔥 88"));
    await db.lead.update({ where: { id: stale.id }, data: { score: 40, status: "NEW" } });
    assert.equal(await notifyHotLead(stale.id), "skipped", "ниже порога");

    console.log(`notify: все проверки пройдены (${sent.length} подменённых отправок)`);


  } finally {
    await db.digest.deleteMany({ where: { createdAt: { gte: started } } });
    await db.lead.deleteMany({ where: { title: { startsWith: MARK } } });
    await db.notificationLog.deleteMany({ where: { OR: [{ key: { startsWith: MARK } }, { sentAt: { gte: started } }] } });
    globalThis.fetch = realFetch;
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

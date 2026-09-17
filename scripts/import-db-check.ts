/** Импорт в настоящую БД и отмена: pnpm test:import-db. Удаляет за собой всё созданное. */
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { importChunk, startImportBatch, undoImport } from "@/lib/import/service";
import { dealTotals } from "@/lib/money";
import { dayKey } from "@/lib/time";

const MARK = `IMPORT-CHECK-${Date.now()}`;

async function main() {
  const existing = await db.lead.create({ data: { title: `${MARK} уже есть`, source: "MANUAL", rawText: "", contactPhone: "+7 900 111-22-33" } });
  let batchId: string | null = null;
  try {
    const batch = await startImportBatch("test.csv");
    batchId = batch.id;
    const mapping = { title: 0, contactPhone: 1, amount: 2, paid: 3, status: 4, date: 5, tips: 6, source: 7 };
    const rows = [
      [`${MARK} Клиника`, "8 (901) 000-00-01", "120 000", "да", "Сдан", "01.03.2026", "5000", "рекомендация"],
      [`${MARK} Магазин`, "", "80000", "30 000", "в работе", "10.03.2026", "", "kwork"],
      [`${MARK} Дубль телефона`, "89001112233", "10000", "", "отказ", "11.03.2026", "", ""],
      ["", "", "5000", "", "", "", "", ""],
      [`${MARK} Клиника`, "", "", "", "", "01.03.2026", "", ""], // то же название и день, что в строке 2
      [`${MARK} Лид без сделки`, "", "25000", "", "переговоры", "", "", ""],
    ];
    const res = await importChunk({ batchId: batch.id, offset: 0, rows, mapping, options: { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false } });
    assert.equal(res.created, 3, JSON.stringify(res));
    assert.deepEqual(res.skipped.map((s) => s.row), [4, 5, 6]);
    assert.match(res.skipped[0].reason, /телефон/);
    assert.match(res.skipped[1].reason, /названия/);
    assert.match(res.skipped[2].reason, /названием и датой/);

    const leads = await db.lead.findMany({ where: { importBatch: batch.id }, include: { deal: { include: { payments: true, addons: true } }, activities: true }, orderBy: { createdAt: "asc" } });
    const clinic = leads.find((l) => l.title.endsWith("Клиника"))!;
    assert.equal(clinic.status, "WON");
    assert.equal(clinic.source, "REFERRAL");
    assert.equal(clinic.furthestStage, 5);
    assert.equal(dayKey(clinic.createdAt), "2026-03-01");
    assert.equal(clinic.contactPhone, "+7 901 000-00-01");
    const clinicTotals = dealTotals(clinic.deal!);
    assert.deepEqual([clinicTotals.contract, clinicTotals.paid, clinicTotals.tips, clinicTotals.status], [120000, 120000, 5000, "paid"]);
    assert.ok(clinic.deal!.referralAskedAt, "история не попадает в напоминания о рекомендации");
    assert.equal(clinic.activities.length, 1);

    const shop = leads.find((l) => l.title.endsWith("Магазин"))!;
    assert.equal(shop.source, "KWORK");
    assert.deepEqual([dealTotals(shop.deal!).paid, dealTotals(shop.deal!).outstanding], [30000, 50000]);

    const open = leads.find((l) => l.title.endsWith("Лид без сделки"))!;
    assert.equal(open.status, "NEGOTIATING");
    assert.equal(open.deal, null);
    assert.equal(open.budgetMax, 25000);

    assert.equal(await db.aiJob.count({ where: { leadId: { in: leads.map((l) => l.id) } } }), 0, "импорт не ставит AI-оценку");
    const b = await db.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    assert.deepEqual([b.created, b.skipped], [3, 3]);

    // Повторный импорт того же файла — всё уже есть
    const again = await startImportBatch("test.csv");
    const res2 = await importChunk({ batchId: again.id, offset: 0, rows: rows.slice(0, 2), mapping, options: { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false } });
    assert.equal(res2.created, 0);
    await undoImport(again.id);

    // Отмена удаляет лиды, сделки и оплаты
    const dealIds = leads.map((l) => l.deal?.id).filter(Boolean) as string[];
    assert.equal(await undoImport(batch.id), 3);
    batchId = null;
    assert.equal(await db.lead.count({ where: { title: { startsWith: MARK }, id: { not: existing.id } } }), 0);
    assert.equal(await db.payment.count({ where: { dealId: { in: dealIds } } }), 0);

    // Некорректный ввод отклоняется целиком
    await assert.rejects(importChunk({ batchId: "nope", offset: 0, rows: [["x"]], mapping: { title: 0 }, options: { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false } }));
    const probe = await startImportBatch("test.csv");
    await assert.rejects(
      importChunk({ batchId: probe.id, offset: 0, rows: [["x"]], mapping: { title: 0, hacked: 0 } as never, options: { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false } }),
      /hacked|key|Invalid/i,
      "неизвестное поле сопоставления отклоняется",
    );
    await assert.rejects(
      importChunk({ batchId: probe.id, offset: 0, rows: [["x"]], mapping: { title: 0 }, options: { defaultSource: "HACKED", defaultStatus: "NEW", wonArePaid: false } as never }),
      "неизвестный источник отклоняется",
    );
    assert.equal(await undoImport(probe.id), 0);

    // Круг: экспорт в CSV → разбор → колонки распознаются сами → значения совпадают
    const { GET: exportLeads } = await import("@/app/export/leads/route");
    const { GET: exportPayments } = await import("@/app/export/payments/route");
    const referrer = await db.lead.create({ data: { title: `${MARK} Рекомендатель`, source: "MANUAL", status: "WON", furthestStage: 5, rawText: "" } });
    const exported = await db.lead.create({
      data: {
        title: `${MARK} Экспорт; "кавычки"`,
        source: "REFERRAL",
        status: "WON",
        furthestStage: 5,
        rawText: "=HYPERLINK(\"http://evil\")\nвторая строка",
        contactPhone: "+7 902 333-44-55",
        referredById: referrer.id,
        deal: {
          create: {
            amount: 70000,
            closedAt: new Date("2026-04-10T09:00:00Z"),
            addons: { create: { title: "SEO", price: 10000, status: "ACCEPTED" } },
            payments: { create: [{ amount: 50000, paidAt: new Date("2026-04-10T09:00:00Z"), method: "СБП" }, { kind: "TIP", amount: 2000, paidAt: new Date("2026-04-11T09:00:00Z") }] },
          },
        },
      },
    });
    const res3 = await exportLeads();
    assert.equal(res3.headers.get("content-type"), "text/csv; charset=utf-8");
    const bytes = new Uint8Array(await res3.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM для Excel");
    const csv = new TextDecoder().decode(bytes);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")`), "формула обезврежена");
    const { parseCsv } = await import("@/lib/import/csv");
    const { buildRecords, guessMapping } = await import("@/lib/import/mapping");
    const table = parseCsv(csv);
    const map = guessMapping(table[0]);
    for (const f of ["title", "source", "status", "contactPhone", "amount", "paid", "tips", "date", "closedAt", "notes", "referredBy", "category", "region"] as const) {
      assert.ok(map[f] != null, `колонка ${f} распознана`);
    }
    const row = table.find((r) => r[map.title!] === `${MARK} Экспорт; "кавычки"`)!;
    const [rec] = buildRecords([row], map, { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false });
    assert.deepEqual(
      [rec.source, rec.status, rec.contactPhone, rec.amount, rec.paid, rec.tips, dayKey(rec.closedAt!), rec.referredByTitle],
      ["REFERRAL", "WON", "+7 902 333-44-55", 80000, 50000, 2000, "2026-04-10", `${MARK} Рекомендатель`],
    );
    assert.ok(rec.notes.includes("вторая строка"), "перенос строки внутри ячейки сохранился");
    // Импорт этой строки в пустое место восстанавливает связь с рекомендателем
    await db.lead.delete({ where: { id: exported.id } });
    const back = await startImportBatch("test.csv");
    const imported = await importChunk({ batchId: back.id, offset: 0, rows: [row], mapping: map, options: { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: false } });
    assert.equal(imported.created, 1);
    const restored = await db.lead.findFirstOrThrow({ where: { importBatch: back.id } });
    assert.equal(restored.referredById, referrer.id);
    await undoImport(back.id);
    const payCsv = await (await exportPayments()).text();
    assert.ok(payCsv.split("\r\n")[0].includes("Дата оплаты;Срок;Статус;Сумма"));

    console.log("import-db: все проверки пройдены");
  } finally {
    if (batchId) await undoImport(batchId);
    await db.lead.deleteMany({ where: { title: { startsWith: MARK } } });
    await db.importBatch.deleteMany({ where: { fileName: "test.csv" } });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

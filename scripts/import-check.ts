/** Проверка разбора таблиц: pnpm test:import (без БД). */
import assert from "node:assert/strict";
import { decodeTableFile, detectDelimiter, parseCsv } from "@/lib/import/csv";
import { buildRecords, guessMapping, parseAmount, parsePaid, parseSource, parseStatus, parseTableDate, stageForStatus } from "@/lib/import/mapping";
import { dayKey } from "@/lib/time";

// CSV: кавычки, «;», переносы в ячейке, BOM, пустые строки
const excel = '﻿Клиент;Сумма;Комментарий\r\n"ООО ""Ромашка""";50 000;"сайт\r\nи CRM"\r\n\r\nКлиника;30000;\r\n';
assert.equal(detectDelimiter(excel), ";");
assert.deepEqual(parseCsv(excel), [["Клиент", "Сумма", "Комментарий"], ['ООО "Ромашка"', "50 000", "сайт\r\nи CRM"], ["Клиника", "30000", ""]]);
assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
assert.equal(detectDelimiter('"a;b",c,d'), ",", "разделитель внутри кавычек не считается");
assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);

// Кодировка: Windows-1251 распознаётся
const cp1251 = new Uint8Array([0xca, 0xeb, 0xe8, 0xe5, 0xed, 0xf2]); // «Клиент»
assert.equal(decodeTableFile(cp1251), "Клиент");
assert.equal(decodeTableFile(new TextEncoder().encode("Клиент")), "Клиент");

// Суммы
assert.equal(parseAmount("50 000 ₽"), 50000);
assert.equal(parseAmount("1.234.567"), 1234567);
assert.equal(parseAmount("1 234,50 руб."), 1235);
assert.equal(parseAmount("45к"), 45000);
assert.equal(parseAmount("по договорённости"), null);
assert.equal(parseAmount(""), null);

// Даты
assert.equal(dayKey(parseTableDate("17.09.2026")!), "2026-09-17");
assert.equal(dayKey(parseTableDate("7.9.26")!), "2026-09-07");
assert.equal(dayKey(parseTableDate("2026-09-17 14:00")!), "2026-09-17");
assert.equal(dayKey(parseTableDate("46282")!), "2026-09-17", "серийная дата Excel");
assert.equal(parseTableDate("31.02.2026"), null, "несуществующая дата");
assert.equal(parseTableDate("вчера"), null);

// Статусы, источники, оплата
assert.equal(parseStatus("Оплачено"), "WON");
assert.equal(parseStatus("В работе"), "WON");
assert.equal(parseStatus("Отказ клиента"), "LOST");
assert.equal(parseStatus("не интересно"), "LOST");
assert.equal(parseStatus("переговоры"), "NEGOTIATING");
assert.equal(parseStatus("???"), null);
assert.equal(parseSource("Кворк"), "KWORK");
assert.equal(parseSource("сарафан"), "REFERRAL");
assert.equal(parseSource("2ГИС"), "COLD_LOCAL");
assert.equal(parseSource("Авито"), "MANUAL");
assert.equal(parsePaid("да", 30000), 30000);
assert.equal(parsePaid("+", 30000), 30000);
assert.equal(parsePaid("нет", 30000), null);
assert.equal(parsePaid("не оплачено", 30000), null);
assert.equal(parsePaid("15 000", 30000), 15000);
assert.equal(stageForStatus("WON"), 5);
assert.equal(stageForStatus("LOST"), 2);

// Угадывание колонок
const headers = ["Дата", "Клиент", "Телефон", "Ниша", "Сумма, ₽", "Оплачено", "Статус", "Источник", "Что делали", "Дата сдачи"];
const mapping = guessMapping(headers);
assert.deepEqual(mapping, { date: 0, title: 1, contactPhone: 2, category: 3, amount: 4, paid: 5, status: 6, source: 7, notes: 8, closedAt: 9 });
assert.equal(guessMapping(["Дата оплаты", "Дата"]).date, 1, "точное совпадение важнее вхождения");

// Записи
const records = buildRecords(
  [
    ["01.03.2026", "Стоматология «Улыбка»", "8 (989) 464-65-78", "клиника", "120 000", "да", "Сдан", "рекомендация", "CRM и запись", "20.04.2026"],
    ["05.03.2026", "", "", "", "", "", "", "", "", ""],
    ["10.03.2026", "Магазин", "", "розница", "не знаю", "", "непонятно", "", "", ""],
    ["15.03.2026", "Барбершоп", "", "", "40000", "", "выигран", "", "", ""],
  ],
  mapping,
  { defaultSource: "MANUAL", defaultStatus: "LOST", wonArePaid: true },
);
assert.equal(records[0].contactPhone, "+7 989 464-65-78");
assert.deepEqual([records[0].status, records[0].source, records[0].amount, records[0].paid], ["WON", "REFERRAL", 120000, 120000]);
assert.equal(dayKey(records[0].createdAt!), "2026-03-01");
assert.equal(dayKey(records[0].closedAt!), "2026-04-20");
assert.equal(records[1].error, "нет названия клиента");
assert.equal(records[2].status, "LOST");
assert.equal(records[2].warnings.length, 2);
assert.equal(records[3].paid, null, "если колонка «Оплачено» есть, пустое значение — не оплачено, даже при wonArePaid");
assert.equal(dayKey(records[3].closedAt!), "2026-03-15", "без даты закрытия — дата строки");

const noPaidColumn = buildRecords([["Клиент А", "50000", "выигран"]], { title: 0, amount: 1, status: 2 }, { defaultSource: "MANUAL", defaultStatus: "NEW", wonArePaid: true });
assert.equal(noPaidColumn[0].paid, 50000, "без колонки оплаты выигранные считаются оплаченными, если так выбрано");

console.log("import: все проверки пройдены");

/** Проверка помощников времени: pnpm test:time. Запускается дважды — в Москве и в поясе с переходом на летнее время. */
import assert from "node:assert/strict";
import { APP_TIMEZONE, dayKey, hourInZone, monthStart, parseDateInput, zonedTime } from "@/lib/time";

const zone = process.env.APP_TIMEZONE ?? "Europe/Moscow";
assert.equal(APP_TIMEZONE, zone);

if (zone === "Europe/Moscow") {
  // 21:30 UTC 30 сентября — уже 1 октября по Москве
  assert.equal(dayKey(new Date("2026-09-30T21:30:00Z")), "2026-10-01");
  assert.equal(monthStart(new Date("2026-09-30T21:30:00Z")).toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(parseDateInput("2026-09-18")!.toISOString(), "2026-09-18T09:00:00.000Z");
  assert.equal(dayKey(parseDateInput("2026-09-18")!), "2026-09-18");
  assert.equal(hourInZone(new Date("2026-09-17T05:00:00Z")), 8);
}
if (zone === "America/New_York") {
  // переход на летнее время 8 марта 2026: полдень всё равно тот же день
  for (const d of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-11-01"]) assert.equal(dayKey(parseDateInput(d)!), d);
  assert.equal(zonedTime(2026, 3, 8, 12).toISOString(), "2026-03-08T16:00:00.000Z");
  assert.equal(zonedTime(2026, 1, 15, 12).toISOString(), "2026-01-15T17:00:00.000Z");
  assert.equal(monthStart(new Date("2026-11-15T12:00:00Z")).toISOString(), "2026-11-01T04:00:00.000Z");
}
assert.equal(parseDateInput("18.09.2026"), null);
console.log(`time (${zone}): все проверки пройдены`);

/**
 * Автоматический поиск компаний: pnpm test:cold
 * Разбор данных — на фикстурах; затем один настоящий запрос к OpenStreetMap и запись лидов в БД (всё удаляется).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { searchNiche } from "@/lib/cold-search";
import { enrichCompany, findCompanyToEnrich } from "@/lib/lead-service";
import { buildQuery, mapLookupLinks, OverpassUnavailableError, parseElement, tagsForNiche } from "@/lib/osm";

const MARK = "COLD-SEARCH-CHECK";

async function main() {
  // Ниша → теги
  assert.equal(tagsForNiche("стоматология")?.tags[0], '"amenity"="dentist"');
  assert.equal(tagsForNiche("Детские стоматологии")?.label, "стоматологии");
  assert.ok(tagsForNiche("продуктовый магазин")?.tags[0].includes("supermarket"));
  assert.equal(tagsForNiche("сапоги-скороходы"), null);

  // Запрос
  const q = buildQuery(['"amenity"="dentist"'], 42.9764, 47.5024, 12000, 20);
  assert.match(q, /\[out:json\]\[timeout:60\];\(nwr\["amenity"="dentist"\]\(around:12000,42\.97640,47\.50240\);\);out center tags 20;/);
  assert.match(buildQuery(['"shop"="beauty"'], 0, 0, 999999, 9999), /around:999999,0\.00000,0\.00000.*out center tags 500;/);

  // Разбор элементов
  const place = parseElement({
    type: "way",
    id: 42,
    center: { lat: 42.9, lon: 47.5 },
    tags: { name: "Дентал Хаус", "contact:phone": "+7 989 464-65-78;+7 989 000-00-00", website: "https://dh-05.ru", "addr:street": "улица Зои Космодемьянской", "addr:housenumber": "54Ж", "addr:city": "Махачкала", amenity: "dentist", opening_hours: "Mo-Sa 09:00-19:00" },
  })!;
  assert.deepEqual(
    { url: place.osmUrl, name: place.name, phone: place.phone, site: place.website, address: place.address, cat: place.category },
    { url: "https://www.openstreetmap.org/way/42", name: "Дентал Хаус", phone: "+7 989 464-65-78", site: "https://dh-05.ru", address: "Махачкала, улица Зои Космодемьянской, 54Ж", cat: "dentist" },
  );
  assert.equal(parseElement({ type: "node", id: 1, tags: { amenity: "dentist" } }), null, "без названия не берём");
  assert.match(mapLookupLinks("Дентал Хаус", "улица Зои Космодемьянской, 54Ж", "Махачкала").yandex, /yandex\.ru\/maps\/\?text=.+/);

  // Настоящий поиск (один запрос к OpenStreetMap). Публичные серверы бывают перегружены — тогда пропускаем сетевую часть.
  const city = "Махачкала";
  const before = await db.lead.count();
  let result;
  try {
    result = await searchNiche({ niche: "стоматология", city, radiusKm: 5, limit: 3, withOffers: 0 });
  } catch (e) {
    if (e instanceof OverpassUnavailableError) {
      console.log("cold-search: разбор данных проверен; сеть OpenStreetMap недоступна — сетевую часть пропустил");
      return;
    }
    throw e;
  }
  console.log("найдено в OSM:", result.found, "| добавлено:", result.created, "| с телефоном:", result.withPhone, "| дублей:", result.duplicates);
  assert.ok(result.found > 0, "OpenStreetMap вернул компании");
  assert.ok(result.created > 0 && result.created <= 3, "лимит соблюдён");
  assert.equal(await db.lead.count(), before + result.created);

  const created = await db.lead.findMany({ where: { sourceRef: { startsWith: "https://www.openstreetmap.org/" } }, include: { activities: true } });
  assert.equal(created.length, result.created);
  const sample = created[0];
  assert.equal(sample.source, "COLD_LOCAL");
  assert.equal(sample.category, "стоматология");
  assert.match(sample.rawText, /OpenStreetMap/);
  assert.equal(await db.aiJob.count({ where: { leadId: { in: created.map((l) => l.id) }, type: "SITE_CHECK" } }), result.created, "проверка сайта поставлена в очередь");

  // Повторный поиск пропускает уже добавленные и берёт следующие компании — без дублей
  const again = await searchNiche({ niche: "стоматология", city, radiusKm: 5, limit: 3, withOffers: 0 });
  assert.ok(again.duplicates >= result.created, `уже добавленные пропущены (${again.duplicates})`);
  const all = await db.lead.findMany({ where: { sourceRef: { startsWith: "https://www.openstreetmap.org/" } }, select: { sourceRef: true, title: true, region: true } });
  assert.equal(new Set(all.map((l) => l.sourceRef)).size, all.length, "одна компания — один лид");
  assert.equal(new Set(all.map((l) => `${l.title}|${l.region}`)).size, all.length, "нет двух лидов с одним названием в городе");

  // Телефон с карт дописывается в найденную компанию, а не создаёт дубль
  const countBeforeEnrich = await db.lead.count();
  const noPhone = (await db.lead.findMany({ where: { sourceRef: { startsWith: "https://www.openstreetmap.org/" } } })).find((l) => !l.contactPhone);
  if (noPhone) {
    const payload = {
      source: "COLD_LOCAL" as const,
      title: `${noPhone.title} | стоматология`,
      rawText: "",
      sourceRef: "https://yandex.ru/maps/org/123",
      category: null,
      budgetMin: null,
      budgetMax: null,
      contactName: null,
      contactPhone: "+7 988 111-22-33",
      contactTg: null,
      contactEmail: null,
      website: null,
      region: noPhone.region,
      followUpAt: null,
      referredById: null,
    };
    const target = await findCompanyToEnrich(payload);
    assert.equal(target, noPhone.id, "нашлась та же компания по названию");
    await enrichCompany(target!, payload);
    const enriched = await db.lead.findUniqueOrThrow({ where: { id: noPhone.id } });
    assert.equal(enriched.contactPhone, "+7 988 111-22-33");
    assert.match(enriched.rawText, /Карточка на картах/);
    assert.equal(await db.lead.count(), countBeforeEnrich, "дубль не появился");
  } else {
    console.log("(у всех найденных компаний уже есть телефон — проверку дополнения пропустил)");
  }

  console.log("cold-search: все проверки пройдены");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const ids = (await db.lead.findMany({ where: { sourceRef: { startsWith: "https://www.openstreetmap.org/" } }, select: { id: true } })).map((l) => l.id);
    await db.aiJob.deleteMany({ where: { leadId: { in: ids } } });
    await db.lead.deleteMany({ where: { id: { in: ids } } });
    await db.lead.deleteMany({ where: { title: { startsWith: MARK } } });
    await db.$disconnect();
  });

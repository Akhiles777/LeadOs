/**
 * Автоматический поиск компаний по нише и городу: OpenStreetMap → лиды → проверка сайта и примерный оффер.
 * Что нашли, складываем к себе (лицензия OSM это разрешает), телефон добираем по кнопке в списке обзвона.
 */
import type { Prisma } from "@/generated/prisma/client";
import { autoScoreEnabled, enqueue } from "@/ai/jobs";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/lead-input";
import { geocodeCity, mapLookupLinks, type OsmPlace, OSM_ATTRIBUTION, searchPlaces, tagsForNiche } from "@/lib/osm";

export const MAX_PER_SEARCH = 60;
const GEO_KEY = "geocode";

export type SearchResult = {
  found: number;
  created: number;
  duplicates: number;
  withPhone: number;
  withSite: number;
  city: string;
  offersQueued: number;
};

/** Координаты города с запоминанием: сервис геокодирования просит не частить запросами. */
async function cityCoordinates(city: string): Promise<{ lat: number; lon: number; label: string }> {
  const row = await db.appSetting.findUnique({ where: { key: GEO_KEY } });
  const cache = (row?.value as Record<string, { lat: number; lon: number; label: string }> | null) ?? {};
  const key = city.trim().toLowerCase();
  if (cache[key]) return cache[key];

  const found = await geocodeCity(city);
  if (!found) throw new Error(`Не нашёл город «${city}» — проверь написание в настройках холодного поиска`);
  const value = { ...cache, [key]: found } as unknown as Prisma.InputJsonObject;
  await db.appSetting.upsert({ where: { key: GEO_KEY }, create: { key: GEO_KEY, value }, update: { value } });
  return found;
}

function leadText(place: OsmPlace, niche: string): string {
  return [
    `Ниша: ${niche}`,
    place.address ? `Адрес: ${place.address}` : "",
    place.openingHours ? `Часы работы: ${place.openingHours}` : "",
    place.phone ? "" : "Телефон не указан в источнике — добери на картах кнопкой «найти телефон»",
    `Источник: ${OSM_ATTRIBUTION}, ${place.osmUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Уже есть такая компания? Считаем по ссылке на объект, телефону и по названию в том же городе. */
async function findExisting(place: OsmPlace, region: string): Promise<string | null> {
  const phone = place.phone ? normalizePhone(place.phone) : null;
  const existing = await db.lead.findFirst({
    where: {
      OR: [
        { sourceRef: place.osmUrl },
        ...(phone?.startsWith("+7 ") ? [{ contactPhone: phone }] : []),
        { title: { equals: place.name, mode: "insensitive" as const }, region: { equals: region, mode: "insensitive" as const } },
      ],
    },
    select: { id: true },
  });
  return existing?.id ?? null;
}

export async function searchNiche(params: { niche: string; city: string; radiusKm: number; limit: number; withOffers: number }): Promise<SearchResult> {
  const mapping = tagsForNiche(params.niche);
  if (!mapping) throw new Error(`Не знаю, что искать по нише «${params.niche}». Попробуй проще: «стоматология», «автосервис», «продуктовый магазин».`);
  if (!params.city.trim()) throw new Error("Укажи город в настройках холодного поиска");

  const { lat, lon } = await cityCoordinates(params.city);
  const limit = Math.min(Math.max(params.limit, 1), MAX_PER_SEARCH);
  const places = await searchPlaces({ tags: mapping.tags, lat, lon, radiusM: Math.min(Math.max(params.radiusKm, 1), 50) * 1000, limit: limit * 3 });

  const result: SearchResult = { found: places.length, created: 0, duplicates: 0, withPhone: 0, withSite: 0, city: params.city, offersQueued: 0 };

  for (const place of places) {
    if (result.created >= limit) break;
    if (await findExisting(place, params.city)) {
      result.duplicates++;
      continue;
    }
    const lead = await db.lead.create({
      data: {
        source: "COLD_LOCAL",
        sourceRef: place.osmUrl,
        title: place.name,
        rawText: leadText(place, params.niche),
        category: params.niche,
        region: place.city ?? params.city,
        contactPhone: place.phone ? normalizePhone(place.phone) : null,
        website: place.website,
      },
      select: { id: true, website: true },
    });
    result.created++;
    if (place.phone) result.withPhone++;
    if (place.website) result.withSite++;

    // Сайт проверяем всегда: без сайта результат «нет сайта» — это лучший аргумент для звонка.
    await enqueue("SITE_CHECK", lead.id);
    if (autoScoreEnabled() && result.offersQueued < params.withOffers) {
      await enqueue("COLD_OFFER", lead.id, new Date(Date.now() + 60_000));
      result.offersQueued++;
    }
  }
  return result;
}

export { mapLookupLinks };

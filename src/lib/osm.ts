/**
 * Автоматический поиск компаний в OpenStreetMap через Overpass API.
 *
 * Почему OSM: его лицензия (ODbL) разрешает хранить и использовать данные у себя — нужна лишь ссылка на источник.
 * У Яндекс Карт и 2ГИС в условиях API это прямо запрещено, поэтому оттуда компании добавляются только вручную закладкой.
 * Ограничение OSM: телефон и сайт заполнены не у всех — их добираем по кнопке «найти телефон».
 */
import { APP_TIMEZONE } from "@/lib/time";

// Публичные серверы Overpass часто перегружены — при отказе пробуем следующий.
const OVERPASS_MIRRORS = (process.env.OVERPASS_URL?.trim() ? [process.env.OVERPASS_URL.trim()] : []).concat([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]);
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = `LeadOS/1.0 (personal CRM; ${APP_TIMEZONE})`;
export const OSM_ATTRIBUTION = "Данные компаний — © участники OpenStreetMap (ODbL)";

/** Ниша (как её пишет пользователь) → теги OSM. Совпадение по основам слов, поэтому «стоматологии» тоже сработают. */
const NICHE_TAGS: { match: RegExp; tags: string[]; label: string }[] = [
  { match: /стомат|дантист|зубн/i, tags: ['"amenity"="dentist"', '"healthcare"="dentist"'], label: "стоматологии" },
  { match: /клиник|медицин|больниц|поликлин|врач/i, tags: ['"amenity"~"^(clinic|doctors)$"', '"healthcare"~"^(clinic|doctor|centre)$"'], label: "клиники" },
  { match: /ветеринар|ветклиник/i, tags: ['"amenity"="veterinary"'], label: "ветклиники" },
  { match: /салон красоты|космет|space|спа|spa/i, tags: ['"shop"="beauty"', '"leisure"="spa"'], label: "салоны красоты" },
  { match: /парикмахер|барбер/i, tags: ['"shop"="hairdresser"'], label: "парикмахерские и барбершопы" },
  { match: /автосервис|шиномонт|сто\b|автомойк/i, tags: ['"shop"="car_repair"', '"shop"="tyres"', '"amenity"="car_wash"'], label: "автосервисы" },
  { match: /автозапчаст/i, tags: ['"shop"="car_parts"'], label: "автозапчасти" },
  { match: /продукт|супермаркет|гастроном|магазин у дома/i, tags: ['"shop"~"^(supermarket|convenience|greengrocer|butcher)$"'], label: "продуктовые магазины" },
  { match: /строитель|стройматериал|ремонт квартир/i, tags: ['"shop"~"^(doityourself|hardware|paint|trade)$"'], label: "строительные магазины" },
  { match: /мебел/i, tags: ['"shop"="furniture"'], label: "мебель" },
  { match: /одежд|обув|бутик/i, tags: ['"shop"~"^(clothes|shoes|boutique)$"'], label: "одежда и обувь" },
  { match: /юрид|юрист|адвокат|нотариус/i, tags: ['"office"~"^(lawyer|notary)$"'], label: "юридические услуги" },
  { match: /бухгалт|аудит/i, tags: ['"office"~"^(accountant|tax_advisor)$"'], label: "бухгалтерия" },
  { match: /недвижим|риэлт/i, tags: ['"office"="estate_agent"'], label: "агентства недвижимости" },
  { match: /фитнес|спортзал|тренаж|йог/i, tags: ['"leisure"~"^(fitness_centre|sports_centre)$"'], label: "фитнес" },
  { match: /кафе|кофейн|пекарн|кондитер/i, tags: ['"amenity"~"^(cafe|bakery)$"', '"shop"~"^(bakery|pastry|coffee)$"'], label: "кафе и пекарни" },
  { match: /ресторан|бар\b|столов|пицц|суши|доставка ед/i, tags: ['"amenity"~"^(restaurant|fast_food|bar)$"'], label: "рестораны и доставка" },
  { match: /отел|гостиниц|хостел/i, tags: ['"tourism"~"^(hotel|hostel|guest_house)$"'], label: "гостиницы" },
  { match: /детск|школ|курс|репетит|образован|садик|языков/i, tags: ['"amenity"~"^(kindergarten|language_school|driving_school|music_school|college)$"', '"office"="educational_institution"'], label: "детские центры и курсы" },
  { match: /аптек/i, tags: ['"amenity"="pharmacy"'], label: "аптеки" },
  { match: /туристи|турагент/i, tags: ['"shop"="travel_agency"'], label: "турагентства" },
  { match: /цвет/i, tags: ['"shop"="florist"'], label: "цветочные" },
  { match: /тату|маникюр|ногт/i, tags: ['"shop"~"^(tattoo|nails)$"', '"shop"="beauty"'], label: "тату и ногтевые студии" },
];

export function tagsForNiche(niche: string): { tags: string[]; label: string } | null {
  return NICHE_TAGS.find((n) => n.match.test(niche)) ?? null;
}

export function knownNiches(): string[] {
  return NICHE_TAGS.map((n) => n.label);
}

export type OsmPlace = {
  osmUrl: string; // ссылка на объект — она же sourceRef лида
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  openingHours: string | null;
  category: string | null;
  lat: number | null;
  lon: number | null;
};

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export function buildQuery(tags: string[], lat: number, lon: number, radiusM: number, limit: number): string {
  const parts = tags.map((t) => `nwr[${t}](around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)});`).join("");
  return `[out:json][timeout:60];(${parts});out center tags ${Math.min(Math.max(limit, 1), 500)};`;
}

export function parseElement(el: OverpassElement): OsmPlace | null {
  const t = el.tags ?? {};
  const name = (t.name ?? t["name:ru"] ?? "").trim();
  if (!name) return null; // безымянные объекты для обзвона бесполезны

  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(", ");
  const city = t["addr:city"] ?? null;
  const category = t.shop ?? t.amenity ?? t.office ?? t.leisure ?? t.healthcare ?? t.tourism ?? null;

  return {
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    name: name.slice(0, 200),
    phone: (t.phone ?? t["contact:phone"] ?? t["contact:mobile"] ?? "").split(";")[0].trim() || null,
    website: (t.website ?? t["contact:website"] ?? t.url ?? "").split(";")[0].trim() || null,
    address: [city, street].filter(Boolean).join(", ") || null,
    city,
    openingHours: t.opening_hours ?? null,
    category,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
  };
}

async function request(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(init.timeoutMs ?? 70_000) });
  if (res.status === 429 || res.status === 503 || res.status === 504) throw new Error("Сервер OpenStreetMap перегружен");
  if (!res.ok) throw new Error(`OpenStreetMap ответил ${res.status}`);
  return res;
}

/** Город → координаты центра (Nominatim). Результат кэшируется вызывающим кодом: сервис просит не частить. */
export async function geocodeCity(city: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(city)}&format=json&limit=1&accept-language=ru`;
  const res = await request(url, { timeoutMs: 20_000 });
  const data = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  const hit = data[0];
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name } : null;
}

export async function searchPlaces(params: { tags: string[]; lat: number; lon: number; radiusM: number; limit: number }): Promise<OsmPlace[]> {
  const data = await queryOverpass(buildQuery(params.tags, params.lat, params.lon, params.radiusM, params.limit));
  const places = (data.elements ?? []).map(parseElement).filter((p): p is OsmPlace => p != null);
  // Один и тот же магазин бывает и точкой, и контуром здания — оставляем по одному на название+адрес.
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = `${p.name.toLowerCase()}|${p.address ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class OverpassUnavailableError extends Error {}

/** Запрос к Overpass с перебором зеркал: один сервер часто отвечает 429 или 504. */
async function queryOverpass(query: string): Promise<{ elements?: OverpassElement[] }> {
  let lastError: unknown = null;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      return (await res.json()) as { elements?: OverpassElement[] };
    } catch (e) {
      lastError = e;
    }
  }
  console.error("[osm] все зеркала Overpass недоступны:", lastError);
  throw new OverpassUnavailableError("OpenStreetMap сейчас не отвечает — попробуй через несколько минут");
}

/** Ссылки, чтобы добрать телефон: карточка компании на картах по названию и адресу. */
export function mapLookupLinks(name: string, address: string | null, region: string | null) {
  const query = encodeURIComponent([name, address ?? region ?? ""].filter(Boolean).join(" "));
  return { yandex: `https://yandex.ru/maps/?text=${query}`, twoGis: `https://2gis.ru/search/${query}` };
}

/**
 * Автоматический поиск компаний в OpenStreetMap через Overpass API.
 *
 * Почему OSM: его лицензия (ODbL) разрешает хранить и использовать данные у себя — нужна лишь ссылка на источник.
 * У Яндекс Карт и 2ГИС в условиях API это прямо запрещено, поэтому оттуда компании добавляются только вручную закладкой.
 * Ограничение OSM: телефон и сайт заполнены не у всех — их добираем с сайта компании и веб-поиском (src/ai/tasks/find-contacts.ts).
 */
import { type Contact, contactsFromOsmTags } from "@/lib/contacts";
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
  { match: /автосалон|автодилер|продажа авто/i, tags: ['"shop"="car"'], label: "автосалоны" },
  { match: /автосервис|шиномонт|(?<!\p{L})сто(?!\p{L})|автомойк/iu, tags: ['"shop"="car_repair"', '"shop"="tyres"', '"amenity"="car_wash"'], label: "автосервисы" },
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
  { match: /ресторан|(?<!\p{L})бар(?!\p{L})|столов|пицц|суши|доставка ед/iu, tags: ['"amenity"~"^(restaurant|fast_food|bar)$"'], label: "рестораны и доставка" },
  { match: /отел|гостиниц|хостел/i, tags: ['"tourism"~"^(hotel|hostel|guest_house)$"'], label: "гостиницы" },
  { match: /детск|школ|курс|репетит|образован|садик|языков/i, tags: ['"amenity"~"^(kindergarten|language_school|driving_school|music_school|college)$"', '"office"="educational_institution"'], label: "детские центры и курсы" },
  { match: /аптек/i, tags: ['"amenity"="pharmacy"'], label: "аптеки" },
  { match: /туристи|турагент/i, tags: ['"shop"="travel_agency"'], label: "турагентства" },
  { match: /оптик|очк/i, tags: ['"shop"="optician"'], label: "оптики" },
  { match: /зоомагаз|зоотовар/i, tags: ['"shop"="pet"'], label: "зоомагазины" },
  { match: /электрон|телефон|гаджет|ремонт техник/i, tags: ['"shop"~"^(electronics|mobile_phone|computer)$"', '"craft"="electronics_repair"'], label: "электроника и ремонт" },
  { match: /типограф|печат|полиграф/i, tags: ['"shop"="copyshop"', '"craft"="printer"'], label: "типографии" },
  { match: /ателье|химчист|прачечн/i, tags: ['"shop"~"^(tailor|dry_cleaning|laundry)$"'], label: "ателье и химчистки" },
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
  contacts: Contact[];
  /** Федеральная сеть (у бренда есть статья в Wikidata): решения там принимает центральный офис, не филиал. */
  chain: boolean;
  /** Что ещё известно из карточки: кухня, бренд, описание — AI опирается на это в оффере. */
  details: string[];
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
  const category = t.shop ?? t.amenity ?? t.office ?? t.leisure ?? t.healthcare ?? t.tourism ?? t.craft ?? null;
  const contacts = contactsFromOsmTags(t);
  const details = [
    t.brand && t.brand !== name ? `Сеть/бренд: ${t.brand}` : "",
    t.cuisine ? `Кухня: ${t.cuisine.replace(/;/g, ", ")}` : "",
    t.description ? `Описание: ${t.description}` : "",
    t.delivery === "yes" ? "Есть доставка" : "",
    t.takeaway === "yes" ? "Еда навынос" : "",
    t["healthcare:speciality"] ? `Специализация: ${t["healthcare:speciality"].replace(/;/g, ", ")}` : "",
    t.operator && t.operator !== name ? `Владелец/оператор: ${t.operator}` : "",
  ].filter(Boolean);

  return {
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    name: name.slice(0, 200),
    phone: contacts.find((c) => c.kind === "phone")?.value ?? null,
    website: (t.website ?? t["contact:website"] ?? t.url ?? "").split(";")[0].trim() || null,
    address: [city, street].filter(Boolean).join(", ") || null,
    city,
    openingHours: t.opening_hours ?? null,
    category,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
    contacts,
    details,
    chain: Boolean(t["brand:wikidata"] || t["brand:wikipedia"] || t["operator:wikidata"]),
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
  // Филиалы одной компании с общим сайтом — это один клиент: оставляем первый.
  const seen = new Set<string>();
  const unique = places.filter((p) => {
    const keys = [`${p.name.toLowerCase()}|${p.address ?? ""}`, ...(p.website ? [`site|${siteHost(p.website)}`] : [])];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
  // Сначала те, с кем можно связаться сразу: телефон/мессенджер, потом с сайтом (контакты найдутся на нём), потом остальные.
  return unique.sort((a, b) => reachRank(b) - reachRank(a));
}

const SHARED_HOSTS = /^(vk\.com|vk\.ru|m\.vk\.com|ok\.ru|instagram\.com|facebook\.com|t\.me|wa\.me|taplink\.(cc|ws)|linktr\.ee|youtube\.com|dzen\.ru|avito\.ru|2gis\.ru|yandex\.ru|business\.site|tilda\.ws|wixsite\.com|nethouse\.ru|ucoz\.ru)$/;

/**
 * Ключ сайта для поиска дублей: домен компании. На общих площадках (VK, Instagram, taplink, *.tilda.ws…)
 * у всех один домен — там ключ включает путь или поддомен, иначе разные компании склеились бы в одну.
 */
export function siteHost(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return SHARED_HOSTS.test(host) ? `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}` : host;
  } catch {
    return url.toLowerCase();
  }
}

export function reachRank(p: Pick<OsmPlace, "contacts" | "website">): number {
  const direct = p.contacts.some((c) => c.kind === "phone" || c.kind === "whatsapp" || c.kind === "telegram") ? 2 : 0;
  return direct + (p.website ? 1 : 0) + (p.contacts.some((c) => c.kind === "email") ? 0.5 : 0);
}

export class OverpassUnavailableError extends Error {}

/**
 * Запрос к Overpass с перебором зеркал: один сервер часто отвечает 429 или 504.
 * Если отказали все — ещё один круг через несколько секунд: лимит частоты у публичных серверов короткий.
 */
async function queryOverpass(query: string): Promise<{ elements?: OverpassElement[] }> {
  let lastError: unknown = null;
  const attempts = [...OVERPASS_MIRRORS, ...OVERPASS_MIRRORS];
  for (const [i, url] of attempts.entries()) {
    if (i === OVERPASS_MIRRORS.length) await new Promise((r) => setTimeout(r, 4_000));
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

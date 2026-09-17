import type { Source } from "@/generated/prisma/enums";

const TRACKING_PARAMS = /^(utm_|yclid$|gclid$|fbclid$|ref$|from$)/i;

/**
 * Приводит sourceRef к каноническому виду, чтобы один и тот же заказ/пост не расходился
 * из-за мелочей: http/https, www, завершающий слэш, #якорь, utm-метки.
 *   https://www.kwork.ru/projects/123456/view?utm_source=x → https://kwork.ru/projects/123456
 *   https://kwork.ru/new_offer?project=123456 → https://kwork.ru/projects/123456
 *   https://t.me/s/channel/42 → https://t.me/channel/42
 *   https://yandex.ru/maps/28/makhachkala/org/dental_khaus/203173276250/ → https://yandex.ru/maps/org/203173276250
 *   https://2gis.ru/makhachkala/firm/70000001105749762?stat=… → https://2gis.ru/firm/70000001105749762
 */
export function normalizeSourceRef(source: Source, raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return value; // не URL (например, ID места в 2GIS) — храним как есть
  }
  if (!url.hostname.includes(".")) return value;

  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  let path = url.pathname.replace(/\/+$/, "");

  if (source === "KWORK" || url.hostname === "kwork.ru") {
    // /projects/123, /projects/123/view, /new_offer?project=123
    const id = path.match(/^\/projects\/(\d+)/)?.[1] ?? (path === "/new_offer" ? url.searchParams.get("project") : null);
    if (id) return `https://kwork.ru/projects/${id}`;
  }
  // Карточки организаций: слаг и город в пути меняются, id — нет.
  if (url.hostname === "yandex.ru" || url.hostname === "yandex.com") {
    const id = path.match(/\/maps\/(?:.*\/)?org\/(?:[^/]+\/)?(\d+)/)?.[1];
    if (id) return `https://yandex.ru/maps/org/${id}`;
  }
  if (url.hostname === "2gis.ru") {
    const id = path.match(/\/firm\/(\d+)/)?.[1];
    if (id) return `https://2gis.ru/firm/${id}`;
  }
  if (source === "TELEGRAM" || url.hostname === "t.me") {
    path = path.replace(/^\/s\//, "/");
    url.search = "";
  }

  return `https://${url.hostname}${path}${url.search}`;
}

/**
 * Проверки без сети и базы: контакты с сайта и из OSM, подтверждение контактов из веб-поиска,
 * подбор решений под нишу, детектор штампов. Запуск: pnpm test:contacts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { findSolution, solutionsFor } from "@/ai/solutions";
import { findCliches } from "@/ai/style";
import { nameTokens, verifyContacts } from "@/ai/tasks/find-contacts";
import { allContacts, contactFromUrl, contactsFromOsmTags, extractContacts, fieldsFromContacts, hasReachableContact, mailtoLink, mergeContacts, whatsappLink } from "@/lib/contacts";
import { checkWebsite, findContactsPage, type Fetcher } from "@/lib/site-check";
import { parseElement, siteHost } from "@/lib/osm";

async function main() {
  // ── Контакты со страницы ──
  const home = `<html><head><title>Кафе Лагуна — Махачкала</title><meta name="description" content="Европейская и кавказская кухня, доставка"></head>
  <body><header><a href="tel:+7 (872) 255-11-22">+7 (872) 255-11-22</a>
  <a href="https://wa.me/79281234567?text=hi">WhatsApp</a><a href="https://t.me/laguna_cafe">tg</a>
  <a href="https://t.me/share/url?url=x">поделиться</a><a href="https://vk.com/laguna_mkala">vk</a><a href="https://vk.com/share.php?x">share</a>
  <a href="https://instagram.com/p/abc">пост</a><a href="/kontakty">Контакты</a></header>
  <h1>Лагуна</h1><h2>Бизнес-ланч с 12 до 16</h2>
  <p>Звоните: 8 928 765-43-21, пишите: info@laguna-cafe.ru или logo@2x.png</p>
  <script>var x = "8 999 000 00 00";</script></body></html>`;
  const found = extractContacts(home);
  const kinds = found.map((c) => `${c.kind}:${c.value}`);
  assert.ok(kinds.includes("phone:+7 872 255-11-22"), kinds.join(" "));
  assert.ok(kinds.includes("phone:+7 928 765-43-21"), "номер из текста");
  assert.ok(kinds.includes("whatsapp:+7 928 123-45-67"), "WhatsApp из wa.me");
  assert.ok(kinds.includes("telegram:@laguna_cafe"));
  assert.ok(kinds.includes("vk:vk.com/laguna_mkala"));
  assert.ok(kinds.includes("email:info@laguna-cafe.ru"));
  assert.ok(!kinds.some((k) => k.includes("share") || k.includes("2x.png") || k.includes("999 000")), "мусор отброшен: share, картинки, номера в скриптах");
  assert.ok(!kinds.some((k) => k.startsWith("instagram")), "ссылка на пост — не профиль");

  assert.equal(contactFromUrl("https://t.me/joinchat/abc", "site"), null);
  assert.equal(contactFromUrl("https://api.whatsapp.com/send?phone=79001112233", "site")?.value, "+7 900 111-22-33");
  assert.equal(contactFromUrl("mailto:Sales@Firm.RU?subject=x", "site")?.value, "sales@firm.ru");

  // ── Страница «Контакты» и проверка сайта с ней ──
  assert.equal(findContactsPage(home, new URL("https://laguna-cafe.ru/"))?.pathname, "/kontakty");
  const pages: Record<string, string> = {
    "https://laguna-cafe.ru/": home,
    "https://laguna-cafe.ru/kontakty": `<p>Банкеты: <a href="mailto:banket@laguna-cafe.ru">banket@laguna-cafe.ru</a>, MAX: <a href="https://max.ru/laguna">max</a></p>`,
  };
  const fetcher: Fetcher = async (url) => ({ finalUrl: url, status: pages[url.toString()] ? 200 : 404, html: pages[url.toString()] ?? "" });
  const check = await checkWebsite("laguna-cafe.ru", fetcher);
  assert.equal(check.status, "ok");
  assert.equal(check.description, "Европейская и кавказская кухня, доставка");
  assert.ok(check.headings?.includes("Бизнес-ланч с 12 до 16"));
  assert.ok(check.excerpt?.includes("Звоните"));
  assert.ok(check.contacts?.some((c) => c.value === "banket@laguna-cafe.ru" && c.note === "страница «Контакты»"), "контакты со страницы «Контакты»");
  assert.ok(check.contacts?.some((c) => c.kind === "max"));

  const social = await checkWebsite("https://vk.com/laguna_mkala", fetcher);
  assert.equal(social.status, "social_only");
  assert.equal(social.contacts?.[0]?.kind, "vk", "соцсеть вместо сайта — сама становится контактом");

  // ── OSM ──
  const osm = contactsFromOsmTags({
    phone: "+7 872 200-00-01; +7 928 000-00-02",
    "contact:whatsapp": "+79280000003",
    "contact:telegram": "@osm_cafe",
    "contact:vk": "https://vk.com/osmcafe",
    email: "hi@osm.ru",
  });
  assert.deepEqual(
    osm.map((c) => c.kind),
    ["phone", "phone", "whatsapp", "telegram", "vk", "email"],
  );
  const place = parseElement({ type: "node", id: 1, lat: 1, lon: 2, tags: { name: "Лагуна", amenity: "cafe", cuisine: "european;caucasian", "contact:phone": "8 928 111 22 33", delivery: "yes" } });
  assert.equal(place?.phone, "+7 928 111-22-33");
  assert.ok(place?.details.includes("Кухня: european, caucasian") && place.details.includes("Есть доставка"));
  assert.equal(place?.chain, false);
  assert.equal(parseElement({ type: "node", id: 2, tags: { name: "Инвитро", healthcare: "laboratory", "brand:wikidata": "Q4201224" } })?.chain, true, "федеральная сеть");
  assert.equal(siteHost("https://www.celitel05.ru/about"), "celitel05.ru");
  assert.equal(siteHost("vk.com/Laguna"), "vk.com/laguna", "на общих площадках ключ — со страницей");
  assert.notEqual(siteHost("https://instagram.com/cafe_a"), siteHost("https://instagram.com/cafe_b"));

  // ── Слияние и ссылки ──
  const merged = mergeContacts(osm, found);
  assert.equal(new Set(merged.map((c) => `${c.kind}|${c.value}`)).size, merged.length, "без дублей");
  assert.ok(hasReachableContact(merged));
  assert.ok(!hasReachableContact([{ kind: "vk", value: "vk.com/x", source: "osm" }]), "только VK — ещё не «можно связаться»");
  const lead = { contactPhone: null, contactTg: "@manual_tg", contactEmail: null, contacts: osm };
  assert.equal(allContacts(lead)[0].value, "@manual_tg", "ручные поля идут первыми");
  assert.deepEqual(fieldsFromContacts(lead, allContacts(lead)), { contactPhone: "+7 872 200-00-01", contactEmail: "hi@osm.ru" });
  assert.equal(whatsappLink(osm, "Привет"), "https://wa.me/79280000003?text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82");
  assert.equal(mailtoLink(osm, "Тема", "Текст письма"), "mailto:hi@osm.ru?subject=%D0%A2%D0%B5%D0%BC%D0%B0&body=%D0%A2%D0%B5%D0%BA%D1%81%D1%82%20%D0%BF%D0%B8%D1%81%D1%8C%D0%BC%D0%B0");

  // ── Контакты из веб-поиска: верим только тому, что есть в источнике про эту компанию ──
  assert.deepEqual(nameTokens("Стоматология «Юго-Дент»"), ["юго", "дент"]);
  const verified = verifyContacts(
    {
      found: true,
      website: "https://yugo-dent.ru",
      phones: [
        { value: "+7 (872) 299-88-77", sourceUrl: "https://2gis.ru/firm/1" },
        { value: "+7 900 000-00-00", sourceUrl: "https://2gis.ru/firm/1" }, // модель выдумала
        { value: "+7 928 555-44-33", sourceUrl: "https://other.ru" }, // номер есть, но на странице про другую компанию
      ],
      emails: [{ value: "clinic@yugo-dent.ru", sourceUrl: "https://yugo-dent.ru" }],
      links: [{ url: "https://wa.me/79285554433", sourceUrl: "https://other.ru" }],
      note: "",
    },
    [
      { url: "https://2gis.ru/firm/1", text: "Юго-Дент, стоматология, Махачкала. Телефон +7 (872) 299-88-77. Сайт yugo-dent.ru" },
      { url: "https://yugo-dent.ru", text: "Клиника Юго-Дент. Почта clinic@yugo-dent.ru" },
      { url: "https://other.ru", text: "Салон Жемчужина, +7 928 555-44-33" },
    ],
    "Стоматология Юго-Дент",
  );
  assert.deepEqual(
    verified.contacts.map((c) => c.value),
    ["+7 872 299-88-77", "clinic@yugo-dent.ru"],
  );
  assert.equal(verified.website, "https://yugo-dent.ru");
  assert.equal(verified.contacts[0].note, "нашёл: 2gis.ru");
  const aggregator = verifyContacts({ found: true, website: "https://2gis.ru/firm/1", phones: [], emails: [], links: [], note: "" }, [{ url: "https://2gis.ru/firm/1", text: "Юго-Дент" }], "Юго-Дент");
  assert.equal(aggregator.website, null, "карточка справочника — не сайт компании");

  // ── Каталог решений ──
  const cafe = solutionsFor("кафе Лагуна", { status: "no_site", checkedAt: "" });
  assert.ok(cafe.some((s) => s.id === "e_menu") && cafe.some((s) => s.id === "tg_orders"), cafe.map((s) => s.id).join(","));
  assert.ok(cafe[0].signal, "первым идёт решение с сигналом из проверки сайта");
  const clinic = solutionsFor("стоматология", { status: "ok", checkedAt: "", hasBooking: true, hasCrmWidget: true, mobile: true, https: true }, 6).map((s) => s.id);
  assert.ok(clinic.includes("clinic_crm") && clinic.includes("wa_booking"), clinic.join(","));
  assert.ok(!solutionsFor("стоматология", null).some((s) => s.id === "e_menu"), "клинике не предлагаем меню");
  assert.ok(solutionsFor("автосервис", null).some((s) => s.id === "service_crm"));
  assert.ok(findSolution("clinic_crm")?.deliverables.length);

  // ── Штампы ──
  assert.deepEqual(findCliches("Здравствуйте! Меня зовут Ахмед, я опытный разработчик. Индивидуальный подход, качественно и в срок."), [
    "«Меня зовут…» — начинать с себя",
    "представление «я разработчик»",
    "«индивидуальный подход»",
    "«качественно и в срок»",
  ]);
  assert.deepEqual(findCliches("Добрый день, меня зовут Ахмед", { allowIntro: true }), []);
  assert.deepEqual(findCliches("Увидел, что у «Лагуны» бизнес-ланч с 12 до 16, а меню только на фото в Instagram."), []);

  console.log("contacts: все проверки пройдены");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

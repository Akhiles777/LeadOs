/*
 * LeadOS · универсальная закладка «любая страница»: объявление на Авито, пост VK, заказ на FL.ru или Хабр Фрилансе,
 * сайт компании. Берёт адрес страницы, заголовок и выделенный текст (если выделить описание заказа — будет точнее),
 * находит в нём телефоны, email и Telegram и открывает окно LeadOS. Лид создаётся как «Ручной ввод» после твоей проверки.
 *
 * __LEADOS_ORIGIN__ подставляет страница /bookmarklet. Только блочные комментарии: код собирается в одну ссылку.
 */
(function () {
  var ORIGIN = "__LEADOS_ORIGIN__";
  if (location.origin === ORIGIN) {
    alert("LeadOS: эту закладку нажимают на странице с клиентом или заказом, а не в самом LeadOS");
    return;
  }
  var popup = window.open(ORIGIN + "/capture", "leados-capture", "width=640,height=880");
  if (!popup) {
    alert("LeadOS: браузер заблокировал окно. Разреши всплывающие окна для этого сайта и нажми ещё раз.");
    return;
  }

  function line(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }
  function uniq(list) {
    return list.filter(function (v, i) { return v && list.indexOf(v) === i; });
  }
  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return el ? line(el.getAttribute("content")) : "";
  }
  function attrs(selector, prefix) {
    return Array.prototype.map.call(document.querySelectorAll(selector), function (a) {
      return decodeURIComponent((a.getAttribute("href") || "").replace(prefix, "").split("?")[0]);
    });
  }

  var selection = String(window.getSelection ? window.getSelection() : "").trim().slice(0, 15000);
  var text = selection || meta("og:description") || meta("description");
  var firstLine = line(selection.split("\n")[0]).slice(0, 150);

  var host = location.hostname.replace(/^www\./, "");
  var marketplace = /(avito|vk\.com|vk\.ru|ok\.ru|fl\.ru|freelance\.habr|habr|kwork|youdo|profi\.ru|t\.me|instagram|facebook|hh\.ru|weblancer|freelance\.ru|workzilla)/.test(host);
  /* Где искать контакты: в выделенном тексте; без выделения на сайте компании — во всей странице (шапка, подвал).
     На площадках без выделения всю страницу не читаем: там телефоны чужих объявлений и самой площадки. */
  var contactText = selection || (marketplace ? text : text + "\n" + String(document.body ? document.body.innerText : "").slice(0, 50000));

  var PHONE = /(?:\+7|8)[\s(\u2012\u2013-]*\d{3}[\s)\u2012\u2013-]*\d{3}[\s\u2012\u2013-]*\d{2}[\s\u2012\u2013-]*\d{2}/g;
  var phones = uniq((contactText.match(PHONE) || []).map(line));
  if (!phones.length && !selection) phones = uniq(attrs('a[href^="tel:"]', "tel:")).slice(0, 3);
  var emails = uniq((contactText.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) || []).map(function (e) { return e.toLowerCase(); }));
  if (!emails.length && !selection) emails = uniq(attrs('a[href^="mailto:"]', "mailto:")).slice(0, 2);
  /* «@ник» считаем Telegram только в выделенном тексте: на странице это часто Instagram или VK. */
  var TG = selection ? /(?:t\.me\/|(?:^|[\s(])@)([a-zA-Z][\w]{4,31})/g : /t\.me\/([a-zA-Z][\w]{4,31})/g;
  var tgs = uniq((contactText.match(TG) || []).map(function (t) { return "@" + t.replace(/^[\s(]*(t\.me\/|@)/, ""); }));
  if (!tgs.length && !selection && !marketplace) tgs = uniq(attrs('a[href*="t.me/"]', /^https?:\/\/t\.me\//).map(function (u) { return u ? "@" + u.split("/")[0] : ""; })).slice(0, 1);

  var url = location.href.split("#")[0];

  var payload = {
    kind: "generic",
    source: "MANUAL",
    sourceRef: url,
    title: firstLine || line(meta("og:title") || document.title).slice(0, 150),
    rawText: [selection || text, "", "—", "Страница: " + line(document.title), url].join("\n").trim(),
    contactPhone: phones[0] || null,
    contactEmail: emails[0] || null,
    contactTg: tgs[0] || null,
    website: marketplace ? null : location.origin,
    region: null,
    category: null
  };

  function onMessage(event) {
    if (event.origin !== ORIGIN || event.source !== popup || !event.data || event.data.type !== "leados:ready") return;
    popup.postMessage({ type: "leados:lead", payload: payload }, ORIGIN);
  }
  window.addEventListener("message", onMessage);
  setTimeout(function () { window.removeEventListener("message", onMessage); }, 120000);
})();

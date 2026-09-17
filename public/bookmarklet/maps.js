/*
 * LeadOS · закладка для Яндекс Карт и 2ГИС.
 *
 * Нажимается на открытой карточке компании, которую ты выбрал сам:
 *   yandex.ru/maps/…/org/<slug>/<id>  — данные из микроразметки schema.org в карточке;
 *   2gis.ru/…/firm/<id>               — данные из initialState страницы (он обновляется и при переходах внутри 2ГИС).
 * Открывает окно LeadOS /capture и передаёт туда одну карточку. Никакого обхода списков и выгрузки.
 *
 * __LEADOS_ORIGIN__ подставляет страница /bookmarklet. Только блочные комментарии: код собирается в одну ссылку.
 */
(function () {
  var ORIGIN = "__LEADOS_ORIGIN__";
  var host = location.hostname.replace(/^www\./, "");
  var isYandex = /^yandex\.(ru|com)$/.test(host) && /\/maps\//.test(location.pathname);
  var is2gis = host === "2gis.ru";
  var yandexId = isYandex ? (location.pathname.match(/\/org\/(?:[^/]+\/)?(\d+)/) || [])[1] : null;
  var gisId = is2gis ? (location.pathname.match(/\/firm\/(\d+)/) || [])[1] : null;

  if (!yandexId && !gisId) {
    alert("LeadOS: открой карточку конкретной компании на Яндекс Картах или в 2ГИС и нажми ещё раз");
    return;
  }

  var popup = window.open(ORIGIN + "/capture", "leados-capture", "width=640,height=880");
  if (!popup) {
    alert("LeadOS: браузер заблокировал окно. Разреши всплывающие окна для этого сайта и нажми ещё раз.");
    return;
  }

  function line(s) {
    return String(s == null ? "" : s).replace(/[\s​]+/g, " ").trim();
  }

  function uniq(list) {
    return list.filter(function (v, i) { return v && list.indexOf(v) === i; });
  }

  function cleanUrl(u) {
    try {
      var url = new URL(u);
      Array.from(url.searchParams.keys()).forEach(function (k) {
        if (/^(utm_|yclid$|gclid$|fbclid$|_openstat$|from$)/i.test(k)) url.searchParams.delete(k);
      });
      return url.toString().replace(/\/$/, "");
    } catch {
      return u;
    }
  }

  var REGION_PART = /(область|край|республика|округ|район|россия)/i;
  function cityFromAddress(address) {
    var parts = line(address).split(",").map(line);
    for (var i = 0; i < parts.length - 1; i++) {
      if (!REGION_PART.test(parts[i]) && !/\d/.test(parts[i])) return parts[i];
    }
    return null;
  }

  function fromYandex() {
    var card = document.querySelector(".business-card-view");
    if (!card) throw new Error("не нашёл карточку компании — дождись, пока она загрузится");
    var meta = function (prop) {
      return Array.prototype.map.call(card.querySelectorAll('[itemprop="' + prop + '"]'), function (el) {
        return line(el.getAttribute("content") || el.getAttribute("href") || el.textContent);
      });
    };
    var name = meta("name")[0] || line((card.querySelector("h1") || {}).textContent);
    var address = (meta("address")[0] || "").split(" · ")[0];
    var phones = uniq(meta("telephone"));
    var site = meta("url").filter(function (u) { return /^https?:/.test(u) && !/yandex\./.test(u); })[0] || null;
    var social = uniq(meta("sameAs").map(function (u) { return u.split("?")[0]; }));
    var categories = uniq(Array.prototype.map.call(card.querySelectorAll(".business-categories-view__category"), function (el) { return line(el.textContent); }));
    var ratingText = line((card.querySelector(".business-header-rating-view") || {}).textContent);
    var rating = (ratingText.match(/(\d[,.]\d)/) || [])[1];
    var votes = (ratingText.match(/(\d+)\s+оцен/) || ratingText.match(/\((\d+)\)/) || [])[1];
    var hours = meta("openingHours");

    return build({
      provider: "Яндекс Карты",
      sourceRef: "https://yandex.ru/maps/org/" + yandexId,
      name: name,
      address: address,
      city: cityFromAddress(address),
      phones: phones,
      site: site,
      social: social,
      categories: categories,
      rating: rating ? rating.replace(",", ".") + (votes ? " (" + votes + " оценок)" : "") : null,
      extra: hours.length ? ["Режим работы: " + hours.join("; ")] : []
    });
  }

  function from2gis() {
    var state = window.initialState;
    var profile = state && state.data && state.data.entity && state.data.entity.profile && state.data.entity.profile[gisId];
    var d = profile && profile.data;
    if (!d) return from2gisDom();

    var contacts = [];
    (d.contact_groups || []).forEach(function (g) { (g.contacts || []).forEach(function (c) { contacts.push(c); }); });
    var byType = function (type) { return contacts.filter(function (c) { return c.type === type; }); };
    var city = (d.adm_div || []).filter(function (a) { return a.type === "city"; })[0];
    var reviews = d.reviews || {};

    return build({
      provider: "2ГИС",
      sourceRef: "https://2gis.ru/firm/" + gisId,
      name: line((d.org && d.org.primary) || d.name),
      address: line([city && city.name, d.address_name].filter(Boolean).join(", ")),
      city: city ? city.name : null,
      phones: uniq(byType("phone").map(function (c) { return c.value || c.text; })),
      site: (byType("website")[0] || {}).url || null,
      social: uniq(contacts.filter(function (c) { return /^(vkontakte|telegram|whatsapp|instagram|ok|youtube|viber)$/.test(c.type); }).map(function (c) { return c.url || c.value; })).map(function (u) { return String(u).split("?")[0]; }),
      categories: uniq((d.rubrics || []).map(function (r) { return line(r.name); })),
      rating: reviews.general_rating ? reviews.general_rating + (reviews.general_review_count ? " (" + reviews.general_review_count + " отзывов)" : "") : null,
      extra: d.org && d.org.branch_count > 1 ? ["Филиалов: " + d.org.branch_count] : []
    });
  }

  /* Разбор вёрстки 2ГИС не используем: рядом с карточкой видны телефоны и сайты других компаний из списка,
     и легко сохранить чужой номер. Без данных страницы честно просим обновить её. */
  function from2gisDom() {
    throw new Error("не нашёл данные карточки — открой карточку компании, обнови страницу (F5) и нажми ещё раз");
  }

  function build(c) {
    var facts = [
      "Источник: " + c.provider,
      c.address ? "Адрес: " + c.address : "",
      c.categories.length ? "Рубрики: " + c.categories.join(", ") : "",
      c.phones.length > 1 ? "Телефоны: " + c.phones.join(", ") : "",
      c.rating ? "Рейтинг: " + c.rating : "",
      c.social.length ? "Соцсети и мессенджеры: " + c.social.join(", ") : ""
    ].concat(c.extra).filter(Boolean);

    return {
      source: "COLD_LOCAL",
      sourceRef: c.sourceRef,
      title: c.name,
      category: c.categories.slice(0, 2).join(", ") || null,
      contactPhone: c.phones[0] || null,
      website: c.site ? cleanUrl(c.site) : null,
      region: c.city,
      rawText: facts.join("\n")
    };
  }

  var data = Promise.resolve()
    .then(function () { return yandexId ? fromYandex() : from2gis(); })
    .catch(function (e) {
      return { error: String((e && e.message) || e), sourceRef: yandexId ? "https://yandex.ru/maps/org/" + yandexId : "https://2gis.ru/firm/" + gisId };
    });

  function onMessage(event) {
    if (event.origin !== ORIGIN || event.source !== popup || !event.data || event.data.type !== "leados:ready") return;
    data.then(function (payload) {
      popup.postMessage({ type: "leados:lead", payload: payload }, ORIGIN);
    });
  }
  window.addEventListener("message", onMessage);
  setTimeout(function () { window.removeEventListener("message", onMessage); }, 120000);
})();

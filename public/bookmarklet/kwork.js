/*
 * LeadOS · закладка для Kwork.
 *
 * Запускается только твоим кликом на странице заказа (kwork.ru/projects/<id> или /new_offer?project=<id>):
 * берёт данные заказа, открывает окно LeadOS /capture и передаёт их через postMessage.
 * Токенов и паролей внутри нет — в окне LeadOS действует твоя обычная авторизация.
 *
 * Источник данных по приоритету:
 *   1. window.stateData.wantData на открытой странице заказа;
 *   2. тот же stateData из HTML /projects/<id>/view (со страницы отклика) — один запрос, как при обычном переходе;
 *   3. вёрстка карточки .want-card, если Kwork уберёт stateData.
 *
 * __LEADOS_ORIGIN__ подставляет страница /bookmarklet. Только блочные комментарии: код собирается в одну ссылку.
 */
(function () {
  var ORIGIN = "__LEADOS_ORIGIN__";
  var match = location.pathname.match(/\/projects\/(\d+)/) || location.search.match(/[?&]project=(\d+)/);
  if (!/(^|\.)kwork\.ru$/.test(location.hostname) || !match) {
    alert("LeadOS: открой страницу конкретного заказа на Kwork");
    return;
  }
  var id = match[1];

  /* Окно открываем синхронно с кликом — иначе сработает блокировщик всплывающих окон. */
  var popup = window.open(ORIGIN + "/capture", "leados-capture", "width=640,height=880");
  if (!popup) {
    alert("LeadOS: браузер заблокировал окно. Разреши всплывающие окна для kwork.ru и нажми ещё раз.");
    return;
  }

  function line(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  function rub(n) {
    return Math.round(Number(n)).toLocaleString("ru-RU") + " ₽";
  }

  function decodeDescription(s) {
    var withEmoji = String(s || "").replace(/\[:([0-9a-f-]+)\]/gi, function (all, codes) {
      try {
        return String.fromCodePoint.apply(null, codes.split("-").map(function (c) { return parseInt(c, 16); }));
      } catch {
        return all;
      }
    });
    var doc = new DOMParser().parseFromString("<!doctype html><body>" + withEmoji.replace(/<br\s*\/?>/gi, "\n"), "text/html");
    return doc.body.textContent
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(function (l) { return l.replace(/[ \t ]+/g, " ").trim(); })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function fromWant(w) {
    var user = w.user || {};
    var stats = user.data || {};
    var price = Number(w.priceLimit) || null;
    var possible = Number(w.possiblePriceLimit) || null;
    var dates = w.wantDates || {};

    var facts = [
      price ? "Бюджет: до " + rub(price) + (possible && possible > price ? " (допустимо до " + rub(possible) + ")" : "") : "",
      w.max_days ? "Срок: до " + w.max_days + " дн." : "",
      user.username
        ? "Покупатель: " + user.username +
          (stats.wants_count ? " — проектов на бирже: " + stats.wants_count : "") +
          (stats.wants_hired_percent ? ", нанято: " + stats.wants_hired_percent + "%" : "")
        : "",
      w.kwork_count != null ? "Предложений: " + w.kwork_count : "",
      w.timeLeft ? "Осталось: " + line(w.timeLeft) + (dates.dateExpire ? " (до " + dates.dateExpire + ")" : "") : "",
      w.files && w.files.length ? "Файлов во вложении: " + w.files.length : ""
    ].filter(Boolean);

    return {
      source: "KWORK",
      sourceRef: "https://kwork.ru/projects/" + id,
      title: line(w.name),
      rawText: decodeDescription(w.description) + (facts.length ? "\n\n—\n" + facts.join("\n") : ""),
      budgetMax: price ? Math.round(price) : null,
      contactName: user.username || null
    };
  }

  /* Достаёт JSON-объект после `window.stateData=` из текста скрипта, не выполняя его. */
  function extractStateData(html) {
    var marker = "window.stateData=";
    var at = html.indexOf(marker);
    if (at === -1) return null;
    var start = html.indexOf("{", at + marker.length);
    var depth = 0, inString = false, escaped = false;
    for (var i = start; i < html.length; i++) {
      var ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function fromCard(doc) {
    var card = doc.querySelector(".want-card");
    if (!card) return null;
    var title = card.querySelector(".wants-card__header-title");
    var desc = card.querySelector(".wants-card__description-text");
    var price = card.querySelector(".wants-card__price");
    var buyer = card.querySelector('.want-payer-statistic a[href*="/user/"]');
    var text = "";
    if (desc) {
      var copy = desc.cloneNode(true);
      copy.querySelectorAll("img[alt]").forEach(function (img) { img.replaceWith(img.alt); });
      copy.querySelectorAll("a[href]").forEach(function (a) { a.replaceWith(a.href); });
      text = decodeDescription(copy.innerHTML.replace(/\n/g, " "));
    }
    var budget = price ? Number(price.textContent.replace(/[^\d]/g, "")) || null : null;
    return {
      source: "KWORK",
      sourceRef: "https://kwork.ru/projects/" + id,
      title: line(title ? title.textContent : doc.title.replace(/\s*-\s*Kwork\s*$/, "")),
      rawText: text + (price ? "\n\n—\n" + line(price.textContent) : ""),
      budgetMax: budget,
      contactName: buyer ? line(buyer.textContent) : null
    };
  }

  function currentWant(state) {
    var w = state && state.wantData;
    return w && String(w.id) === id ? w : null;
  }

  var data = Promise.resolve()
    .then(function () {
      var live = currentWant(window.stateData);
      if (live) return fromWant(live);
      if (/\/projects\/\d+/.test(location.pathname)) {
        var card = fromCard(document);
        if (card) return card;
      }
      return fetch("/projects/" + id + "/view", { credentials: "include" })
        .then(function (r) {
          if (!r.ok) throw new Error("Kwork ответил " + r.status);
          return r.text();
        })
        .then(function (html) {
          var want = currentWant(extractStateData(html));
          if (want) return fromWant(want);
          var card = fromCard(new DOMParser().parseFromString(html, "text/html"));
          if (card) return card;
          throw new Error("не нашёл данные заказа — возможно, Kwork изменил страницу");
        });
    })
    .catch(function (e) {
      return { error: String((e && e.message) || e), sourceRef: "https://kwork.ru/projects/" + id };
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

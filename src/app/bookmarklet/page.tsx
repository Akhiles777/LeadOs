import { headers } from "next/headers";
import { buildBookmarklet, resolveOrigin } from "@/lib/bookmarklet";
import { BookmarkletLink } from "@/components/bookmarklet-link";
import { Card, PageHeader } from "@/components/ui";

export default async function BookmarkletPage() {
  const origin = resolveOrigin(await headers());
  const [kwork, maps, page] = await Promise.all([buildBookmarklet("kwork", origin), buildBookmarklet("maps", origin), buildBookmarklet("page", origin)]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title="Закладки" subtitle="Один клик на открытой странице — и заказ или компания в LeadOS. Без роботов и выгрузок: только страница, которую ты открыл сам." />

      <Card title="Kwork">
        <ol className="mb-5 list-inside list-decimal space-y-2 text-sm">
          <li>Включи панель закладок (⌘⇧B в Chrome, ⌘⇧B в Safari).</li>
          <li>Перетащи зелёную кнопку на панель.</li>
          <li>
            Открой заказ на Kwork — <code>kwork.ru/projects/…</code> или страницу отклика <code>new_offer?project=…</code> — и нажми закладку.
          </li>
          <li>В первый раз браузер может заблокировать окно — разреши всплывающие окна для kwork.ru.</li>
        </ol>
        <BookmarkletLink href={kwork.href} label="→ LeadOS" />
        <p className="mt-4 text-xs text-zinc-500">
          Версия {kwork.version} · адрес LeadOS: {origin}. Если адрес поменяется (например, переедешь с localhost на VPS) — удали старую закладку и
          перетащи заново. Если кнопку не получается перетащить: «Скопировать код» → новая закладка → вставить в поле адреса.
        </p>
      </Card>

      <Card title="Яндекс Карты и 2ГИС">
        <ol className="mb-5 list-inside list-decimal space-y-2 text-sm">
          <li>Перетащи кнопку на панель закладок.</li>
          <li>
            Найди компании на карте (удобно со страницы <a href="/prospecting" className="underline">Холодный поиск</a>), открой карточку нужной и нажми
            закладку.
          </li>
          <li>LeadOS заберёт название, рубрики, телефон, сайт, адрес и рейтинг, проверит сайт и покажет, насколько компания похожа на клиента.</li>
          <li>Одна и та же компания с Яндекс Карт и 2ГИС распознаётся по телефону — дубля не будет.</li>
        </ol>
        <BookmarkletLink href={maps.href} label="→ LeadOS (карты)" />
        <p className="mt-4 text-xs text-zinc-500">Версия {maps.version}. Как и у Kwork-закладки, после смены адреса LeadOS перетащи заново.</p>
      </Card>

      <Card title="Любая страница: Авито, VK, FL.ru, Хабр Фриланс, сайт компании">
        <ol className="mb-5 list-inside list-decimal space-y-2 text-sm">
          <li>Перетащи кнопку на панель закладок.</li>
          <li>На странице с заказом или клиентом выдели текст объявления или поста (необязательно, но так точнее) и нажми закладку.</li>
          <li>LeadOS заберёт ссылку, заголовок и текст, найдёт телефон, email и Telegram. Сайт компании сохранится для проверки.</li>
        </ol>
        <BookmarkletLink href={page.href} label="→ LeadOS (любая страница)" />
        <p className="mt-4 text-xs text-zinc-500">Версия {page.version}. Лид создаётся как «Ручной ввод» — источник можно поменять в окне перед сохранением.</p>
      </Card>

      <Card title="Что происходит при нажатии">
        <ul className="list-inside list-disc space-y-2 text-sm">
          <li>Закладка берёт данные из самой открытой страницы — одной карточки или одного заказа.</li>
          <li>
            Открывает окно LeadOS и передаёт их туда. Окно принимает данные только от <code>kwork.ru</code>, <code>yandex.ru</code> и{" "}
            <code>2gis.ru</code>, а в самой закладке нет ни пароля, ни токена.
          </li>
          <li>Ты проверяешь поля и жмёшь «Добавить». Если лид уже есть — окно сразу покажет его статус.</li>
        </ul>
      </Card>
    </div>
  );
}

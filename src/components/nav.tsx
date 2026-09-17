"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type Item = { href: string; label: string };

const PRIMARY: Item[] = [
  { href: "/", label: "Дашборд" },
  { href: "/pipeline", label: "Воронка" },
  { href: "/leads", label: "Лиды" },
  { href: "/digest", label: "Дайджест" },
  { href: "/prospecting", label: "Холодный поиск" },
  { href: "/analytics", label: "Аналитика" },
];

const MORE: { title: string; items: Item[] }[] = [
  { title: "Источники", items: [{ href: "/telegram", label: "Telegram-каналы" }, { href: "/bookmarklet", label: "Закладки" }, { href: "/import", label: "Импорт из таблицы" }] },
  { title: "Настройка", items: [{ href: "/ai", label: "AI" }, { href: "/settings", label: "Настройки" }] },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname === "/leads" || (/^\/leads\//.test(pathname) && pathname !== "/leads/new");
  return pathname === href || pathname.startsWith(`${href}/`);
}

const linkClass = (active: boolean) =>
  `block whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
    active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
  }`;

export function Nav() {
  const pathname = usePathname();
  // Меню привязано к странице, на которой его открыли: переход по ссылке закрывает его без эффектов.
  const [openOn, setOpenOn] = useState<{ kind: "more" | "mobile"; path: string } | null>(null);
  const open = openOn?.path === pathname ? openOn.kind : null;
  const toggle = (kind: "more" | "mobile") => setOpenOn(open === kind ? null : { kind, path: pathname });
  const moreActive = MORE.some((g) => g.items.some((i) => isActive(pathname, i.href)));

  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <nav className="hidden items-center gap-1 lg:flex" aria-label="Основные разделы">
        {PRIMARY.map((item) => (
          <Link key={item.href} href={item.href} className={linkClass(isActive(pathname, item.href))}>
            {item.label}
          </Link>
        ))}
        <div className="relative">
          <button type="button" aria-expanded={open === "more"} onClick={() => toggle("more")} className={linkClass(moreActive || open === "more")}>
            Ещё ▾
          </button>
          {open === "more" && (
            <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
              <MenuGroups pathname={pathname} />
            </div>
          )}
        </div>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <Link
          href="/leads/new"
          className="whitespace-nowrap rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          + Лид
        </Link>
        <button
          type="button"
          aria-expanded={open === "mobile"}
          aria-label="Меню"
          onClick={() => toggle("mobile")}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm lg:hidden dark:border-zinc-700"
        >
          {open === "mobile" ? "✕" : "☰"}
        </button>
      </div>

      {open === "mobile" && (
        <div className="absolute inset-x-0 top-full z-20 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-zinc-200 bg-white p-4 shadow-lg lg:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <div className="grid grid-cols-2 gap-1">
            {PRIMARY.map((item) => (
              <Link key={item.href} href={item.href} className={linkClass(isActive(pathname, item.href))}>
                {item.label}
              </Link>
            ))}
          </div>
          <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900">
            <MenuGroups pathname={pathname} />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuGroups({ pathname }: { pathname: string }) {
  return (
    <div className="flex flex-col gap-3">
      {MORE.map((group) => (
        <div key={group.title}>
          <p className="px-3 pb-1 text-xs font-medium text-zinc-500">{group.title}</p>
          {group.items.map((item) => (
            <Link key={item.href} href={item.href} className={linkClass(isActive(pathname, item.href))}>
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

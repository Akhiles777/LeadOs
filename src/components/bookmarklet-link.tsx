"use client";

import { useEffect, useRef, useState } from "react";
import { ghostButtonClass } from "@/components/ui";

/** React блокирует javascript:-ссылки в href, поэтому ставим атрибут напрямую в DOM. */
export function BookmarkletLink({ href, label }: { href: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ref.current?.setAttribute("href", href);
  }, [href]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        ref={ref}
        onClick={(e) => {
          e.preventDefault();
          alert("Не нажимай здесь — перетащи кнопку на панель закладок, а нажимай уже на странице заказа Kwork.");
        }}
        className="cursor-grab rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-500 active:cursor-grabbing"
      >
        {label}
      </a>
      <button
        type="button"
        className={ghostButtonClass}
        onClick={async () => {
          await navigator.clipboard.writeText(href);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Скопировано ✓" : "Скопировать код"}
      </button>
    </div>
  );
}

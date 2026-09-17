"use client";

import Link from "next/link";
import { buttonClass, ghostButtonClass } from "@/components/ui";

/** Ошибка на странице: база недоступна, таймаут, баг. Данные не потеряны — можно повторить. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const db = /database|prisma|connect|ECONNREFUSED|P1001|P1002|timeout/i.test(error.message);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-16">
      <h1 className="text-2xl font-semibold">{db ? "Нет связи с базой данных" : "Что-то пошло не так"}</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {db
          ? "Сервер не смог достучаться до базы. Обычно это проходит за минуту; если нет — проверь DATABASE_URL и состояние базы."
          : "Страница не загрузилась. Изменения, сохранённые до этого, на месте — попробуй ещё раз."}
      </p>
      {error.digest && <p className="text-xs text-zinc-500">Код ошибки для логов: {error.digest}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={() => retry()} className={buttonClass}>
          Повторить
        </button>
        <Link href="/" className={ghostButtonClass}>
          На дашборд
        </Link>
      </div>
    </div>
  );
}

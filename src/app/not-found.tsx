import Link from "next/link";
import { ghostButtonClass } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-16">
      <h1 className="text-2xl font-semibold">Не найдено</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Такой страницы или лида нет — возможно, его удалили или отменили импорт.</p>
      <Link href="/leads" className={`${ghostButtonClass} self-start`}>
        Ко всем лидам
      </Link>
    </div>
  );
}

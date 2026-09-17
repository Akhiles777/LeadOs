"use client";

import { useTransition } from "react";
import { rollbackImport } from "@/lib/import/actions";

export function UndoImportButton({ id, count }: { id: string; count: number }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="text-xs text-rose-600 underline disabled:opacity-50"
      onClick={() => confirm(`Удалить ${count} лидов этого импорта вместе со сделками и историей?`) && start(async () => void (await rollbackImport(id)))}
    >
      {pending ? "Отменяю…" : "отменить импорт"}
    </button>
  );
}

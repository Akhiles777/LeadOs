"use client";

import { useTransition } from "react";
import { deleteLead } from "@/lib/actions";

export function DeleteLeadButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (confirm("Удалить лид вместе с историей? Это необратимо.")) startTransition(() => deleteLead(id));
      }}
      className="text-sm text-rose-600 hover:underline disabled:opacity-50"
    >
      {pending ? "Удаляю…" : "Удалить лид"}
    </button>
  );
}

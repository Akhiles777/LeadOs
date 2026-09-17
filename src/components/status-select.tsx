"use client";

import { useState, useTransition } from "react";
import type { LeadStatus } from "@/generated/prisma/enums";
import { changeStatus } from "@/lib/actions";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/leads";
import { inputClass } from "@/components/ui";

export function StatusSelect({ id, status, compact = false }: { id: string; status: LeadStatus; compact?: boolean }) {
  const [pending, startTransition] = useTransition();
  // Локальное значение: там, где страница не перерисовывается с сервера (окно захвата), список не откатывается.
  const [value, setValue] = useState(status);
  const [prevStatus, setPrevStatus] = useState(status);
  if (status !== prevStatus) {
    setPrevStatus(status);
    setValue(status);
  }

  return (
    <select
      aria-label="Статус"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as LeadStatus;
        setValue(next);
        startTransition(() => changeStatus(id, next));
      }}
      className={compact ? "rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700" : inputClass}
    >
      {STATUS_ORDER.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

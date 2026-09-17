"use client";

import { createContext, type ReactNode, useContext, useState, useTransition } from "react";
import type { LeadStatus } from "@/generated/prisma/enums";
import { bulkChangeStatus } from "@/lib/actions";
import { STATUS_LABEL } from "@/lib/leads";
import { ghostButtonClass } from "@/components/ui";

type Ctx = { selected: Set<string>; toggle: (id: string) => void; setAll: (on: boolean) => void; ids: string[] };
const SelectionContext = createContext<Ctx | null>(null);

/** Выбор нескольких лидов в таблице для массовой смены статуса — быстрый разбор потока из Telegram и дайджеста. */
export function BulkSelect({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  // Выбор, оставшийся от лидов, которых уже нет в списке (фильтр, смена статуса), не учитывается.
  const visible = new Set([...selected].filter((id) => ids.includes(id)));

  const ctx: Ctx = {
    selected: visible,
    ids,
    toggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
  };

  const apply = (status: LeadStatus) =>
    start(async () => {
      const count = await bulkChangeStatus([...visible], status);
      setSelected(new Set());
      setMessage(`${STATUS_LABEL[status]}: ${count}`);
      setTimeout(() => setMessage(null), 3000);
    });

  return (
    <SelectionContext.Provider value={ctx}>
      {children}
      {(visible.size > 0 || message) && (
        <div className="sticky bottom-4 z-10 mx-auto mt-3 flex w-fit flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          {message ? (
            <span className="text-sm text-emerald-700 dark:text-emerald-400">Готово · {message}</span>
          ) : (
            <>
              <span className="text-sm">Выбрано: {visible.size}</span>
              {(["QUALIFIED", "SKIPPED", "LOST"] as const).map((s) => (
                <button key={s} type="button" disabled={pending} className={`${ghostButtonClass} px-2! py-1! text-xs!`} onClick={() => apply(s)}>
                  {STATUS_LABEL[s]}
                </button>
              ))}
              <button type="button" className="text-xs underline" onClick={() => setSelected(new Set())}>
                снять выбор
              </button>
            </>
          )}
        </div>
      )}
    </SelectionContext.Provider>
  );
}

export function RowCheckbox({ id, label }: { id: string; label: string }) {
  const ctx = useContext(SelectionContext);
  if (!ctx) return null;
  return <input type="checkbox" aria-label={`Выбрать «${label}»`} checked={ctx.selected.has(id)} onChange={() => ctx.toggle(id)} className="h-4 w-4" />;
}

export function AllCheckbox() {
  const ctx = useContext(SelectionContext);
  if (!ctx) return null;
  const all = ctx.ids.length > 0 && ctx.selected.size === ctx.ids.length;
  return <input type="checkbox" aria-label="Выбрать все" checked={all} onChange={(e) => ctx.setAll(e.target.checked)} className="h-4 w-4" />;
}

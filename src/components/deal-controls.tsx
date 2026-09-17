"use client";

import { useState, useTransition } from "react";
import {
  deleteAddon,
  deletePayment,
  markDealPaidInFull,
  markRetention,
  planPayments,
  setAddonStatus,
  setPaymentPaid,
  suggestAddonsNow,
} from "@/lib/deal-actions";
import { SPLIT_PRESETS, type SplitPreset } from "@/lib/money";
import { ghostButtonClass, inputClass } from "@/components/ui";

const small = `${ghostButtonClass} px-2! py-1! text-xs!`;

export function PaymentRowActions({ id, paid }: { id: string; paid: boolean }) {
  const [pending, start] = useTransition();
  return (
    <span className="flex shrink-0 items-center gap-2">
      <button type="button" disabled={pending} className={small} onClick={() => start(() => setPaymentPaid(id, !paid))}>
        {paid ? "Отменить оплату" : "Оплачено"}
      </button>
      <button type="button" disabled={pending} className="text-xs text-rose-600 underline" onClick={() => confirm("Удалить платёж?") && start(() => deletePayment(id))}>
        удалить
      </button>
    </span>
  );
}

export function PlanPayments({ dealId, defaultFirstDue }: { dealId: string; defaultFirstDue: string }) {
  const [preset, setPreset] = useState<SplitPreset>("50/50");
  const [firstDue, setFirstDue] = useState(defaultFirstDue);
  const [interval, setInterval] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      <p className="text-xs font-medium text-zinc-500">Разбить неоплаченный остаток на части</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <select value={preset} onChange={(e) => setPreset(e.target.value as SplitPreset)} className={`${inputClass} text-sm`}>
          {(Object.keys(SPLIT_PRESETS) as SplitPreset[]).map((k) => (
            <option key={k} value={k}>
              {SPLIT_PRESETS[k].label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          первая
          <input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} className={`${inputClass} text-sm`} />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          шаг, дн.
          <input type="number" min={1} max={365} value={interval} onChange={(e) => setInterval(Number(e.target.value))} className={`${inputClass} text-sm`} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          className={small}
          onClick={() =>
            confirm("Неоплаченные части будут заменены новым графиком. Оплаченные останутся.") &&
            start(async () => {
              setError(null);
              const r = await planPayments(dealId, preset, firstDue, interval);
              if ("error" in r) setError(r.error);
            })
          }
        >
          Составить график
        </button>
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
    </div>
  );
}

export function PaidInFullButton({ dealId, label }: { dealId: string; label: string }) {
  const [method, setMethod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="способ: карта, СБП, Kwork…" className={`${inputClass} w-48 text-sm`} />
      <button
        type="button"
        disabled={pending}
        className={small}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await markDealPaidInFull(dealId, method);
            if ("error" in r) setError(r.error);
          })
        }
      >
        {label}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </div>
  );
}

export function AddonActions({ id, status }: { id: string; status: "PROPOSED" | "ACCEPTED" | "DECLINED" }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-2">
      {status !== "ACCEPTED" && (
        <button type="button" disabled={pending} className={small} onClick={() => start(() => setAddonStatus(id, "ACCEPTED"))}>
          Принята
        </button>
      )}
      {status !== "DECLINED" && (
        <button type="button" disabled={pending} className={small} onClick={() => start(() => setAddonStatus(id, "DECLINED"))}>
          Отказ
        </button>
      )}
      {status !== "PROPOSED" && (
        <button type="button" disabled={pending} className="text-xs underline" onClick={() => start(() => setAddonStatus(id, "PROPOSED"))}>
          вернуть в предложенные
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        className="text-xs text-rose-600 underline"
        onClick={() =>
          confirm("Удалить опцию?") &&
          start(async () => {
            try {
              await deleteAddon(id);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Не удалось удалить");
            }
          })
        }
      >
        удалить
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}

export function SuggestAddonsButton({ leadId }: { leadId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={small}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await suggestAddonsNow(leadId);
            if ("error" in r) setError(r.error);
          })
        }
      >
        {pending ? "Подбираю… (до минуты)" : "Подобрать опции с AI"}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}

export function RetentionToggle({ dealId, kind, doneAt, label }: { dealId: string; kind: "referral" | "upsell"; doneAt: string | null; label: string }) {
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" disabled={pending} checked={Boolean(doneAt)} onChange={(e) => start(() => markRetention(dealId, kind, e.target.checked))} />
      {label}
      {doneAt && <span className="text-xs text-zinc-500">· {doneAt}</span>}
    </label>
  );
}

export function MarkPaidButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <span className="text-xs text-emerald-700 dark:text-emerald-400">оплачено ✓</span>;
  return (
    <button
      type="button"
      disabled={pending}
      className="text-xs underline disabled:opacity-50"
      onClick={() =>
        start(async () => {
          await setPaymentPaid(id, true);
          setDone(true);
        })
      }
    >
      {pending ? "…" : "оплачено"}
    </button>
  );
}

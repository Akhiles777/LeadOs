"use client";

import { useState, useTransition } from "react";
import { type CallOutcome, logCall, runSiteCheck } from "@/lib/cold-actions";
import { ghostButtonClass } from "@/components/ui";

const BUTTONS: { outcome: CallOutcome; label: string; tone: string }[] = [
  { outcome: "no_answer", label: "Не дозвонился", tone: "" },
  { outcome: "callback", label: "Перезвонить", tone: "" },
  { outcome: "interested", label: "Интересно", tone: "border-emerald-500 text-emerald-700 dark:text-emerald-400" },
  { outcome: "not_interested", label: "Не интересно", tone: "border-rose-300 text-rose-700 dark:text-rose-400" },
];

export function CallControls({ leadId }: { leadId: string }) {
  const [comment, setComment] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Комментарий к звонку (необязательно)"
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
      />
      <div className="flex flex-wrap gap-1.5">
        {BUTTONS.map((b) => (
          <button
            key={b.outcome}
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await logCall(leadId, b.outcome, comment);
                setComment("");
              })
            }
            className={`${ghostButtonClass} px-2! py-1! text-xs! ${b.tone}`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SiteCheckButton({ leadId, label = "Проверить сайт" }: { leadId: string; label?: string }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => void (await runSiteCheck(leadId)))} className="text-xs underline disabled:opacity-50">
      {pending ? "Проверяю…" : label}
    </button>
  );
}

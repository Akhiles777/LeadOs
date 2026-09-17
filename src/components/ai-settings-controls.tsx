"use client";

import { useState, useTransition } from "react";
import { deletePortfolioCase, requestDigest, retryFailed, scoreUnscoredLeads, setCaseActive } from "@/lib/ai-actions";
import { ghostButtonClass } from "@/components/ui";

export function QueueButtons({ failed }: { failed: number }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          className={ghostButtonClass}
          onClick={() =>
            start(async () => {
              const n = await scoreUnscoredLeads();
              setNote(n ? `В очередь на оценку: ${n}` : "Все активные лиды уже оценены");
            })
          }
        >
          Оценить неоценённые лиды
        </button>
        <button type="button" disabled={pending} className={ghostButtonClass} onClick={() => start(async () => { await requestDigest(); setNote("Дайджест поставлен в очередь"); })}>
          Собрать дайджест сейчас
        </button>
        {failed > 0 && (
          <button type="button" disabled={pending} className={ghostButtonClass} onClick={() => start(() => retryFailed())}>
            Повторить упавшие ({failed})
          </button>
        )}
      </div>
      {note && <p className="text-xs text-zinc-500">{note}</p>}
    </div>
  );
}

export function CaseControls({ id, active }: { id: string; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <span className="flex gap-3 text-xs">
      <button type="button" disabled={pending} className="underline" onClick={() => start(() => setCaseActive(id, !active))}>
        {active ? "скрыть от AI" : "вернуть AI"}
      </button>
      <button type="button" disabled={pending} className="text-rose-600 underline" onClick={() => confirm("Удалить кейс?") && start(() => deletePortfolioCase(id))}>
        удалить
      </button>
    </span>
  );
}

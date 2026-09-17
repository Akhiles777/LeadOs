"use client";

import { useState, useTransition } from "react";
import type { LeadStatus } from "@/generated/prisma/enums";
import {
  type AiActionResult,
  applyTuningRule,
  assessLeadNow,
  deleteAssessmentFeedback,
  deleteDraft,
  generateDraftNow,
  markDraftSent,
  runTuning,
  submitAssessmentFeedback,
  updateDraftText,
} from "@/lib/ai-actions";
import { changeStatus } from "@/lib/actions";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui";

type Channel = "kwork_response" | "telegram_reply" | "cold_message" | "cold_call_script" | "follow_up" | "referral_request" | "upsell";

function useAiAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<AiActionResult>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if ("error" in res) setError(res.error);
    });
  return { pending, error, run };
}

export function AssessButton({ leadId, label }: { leadId: string; label: string }) {
  const { pending, error, run } = useAiAction();
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" disabled={pending} onClick={() => run(() => assessLeadNow(leadId))} className={ghostButtonClass}>
        {pending ? "Оцениваю… (до минуты)" : label}
      </button>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function VerdictActions({ leadId, status }: { leadId: string; status: LeadStatus }) {
  const [pending, start] = useTransition();
  if (status !== "NEW") return null;
  return (
    <div className="flex gap-2">
      <button type="button" disabled={pending} onClick={() => start(() => changeStatus(leadId, "QUALIFIED", "По оценке AI"))} className={ghostButtonClass}>
        Квалифицировать
      </button>
      <button type="button" disabled={pending} onClick={() => start(() => changeStatus(leadId, "SKIPPED", "По оценке AI"))} className={ghostButtonClass}>
        Пропустить
      </button>
    </div>
  );
}

export function GenerateButtons({ leadId, channels, labels }: { leadId: string; channels: Channel[]; labels: Record<Channel, string> }) {
  const { pending, error, run } = useAiAction();
  const [current, setCurrent] = useState<Channel | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {channels.map((c) => (
          <button
            key={c}
            type="button"
            disabled={pending}
            onClick={() => {
              setCurrent(c);
              run(() => generateDraftNow(leadId, c));
            }}
            className={ghostButtonClass}
          >
            {pending && current === c ? "Пишу… (до минуты)" : `+ ${labels[c]}`}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function DraftEditor({ draft, label }: { draft: { id: string; text: string; notes: string | null; sentAt: string | null; model: string | null; createdAt: string }; label: string }) {
  const [text, setText] = useState(draft.text);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const dirty = text !== draft.text;

  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${draft.sentAt ? "border-emerald-300 dark:border-emerald-900" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span>
          {draft.sentAt ? `отправлено ${draft.sentAt}` : `черновик от ${draft.createdAt}`}
          {draft.model ? ` · ${draft.model}` : ""}
        </span>
      </div>
      {draft.notes && <p className="text-xs text-zinc-500">{draft.notes}</p>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(18, Math.max(5, text.split("\n").length + 1))} className={`${inputClass} text-sm`} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ghostButtonClass}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Скопировано ✓" : "Копировать"}
        </button>
        {dirty && (
          <button type="button" disabled={pending} onClick={() => start(() => updateDraftText(draft.id, text))} className={ghostButtonClass}>
            Сохранить правки
          </button>
        )}
        {!draft.sentAt && (
          <button type="button" disabled={pending} onClick={() => start(() => markDraftSent(draft.id, text))} className={buttonClass}>
            Отправил
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => confirm("Удалить черновик?") && start(() => deleteDraft(draft.id))}
          className="ml-auto text-xs text-rose-600 underline"
        >
          удалить
        </button>
      </div>
    </div>
  );
}

export function FeedbackForm({ leadId, feedback }: { leadId: string; feedback: { id: string; correctVerdict: string; note: string; createdAt: string }[] }) {
  const [verdict, setVerdict] = useState<"TAKE" | "CONSIDER" | "SKIP">("SKIP");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const { pending, error, run } = useAiAction();
  const labels = { TAKE: "брать", CONSIDER: "подумать", SKIP: "пропустить" } as const;

  return (
    <div className="flex flex-col gap-2">
      {feedback.map((f) => (
        <div key={f.id} className="flex items-start justify-between gap-2 rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
          <span>
            Твоя поправка от {f.createdAt}: правильно — <b>{labels[f.correctVerdict as keyof typeof labels]}</b>. {f.note}
          </span>
          <button type="button" className="shrink-0 text-rose-600 underline" onClick={() => run(async () => (await deleteAssessmentFeedback(f.id), { ok: true }))}>
            убрать
          </button>
        </div>
      ))}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="self-start text-xs underline">
          Оценка неверна?
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="flex items-center gap-2 text-sm">
            На самом деле:
            <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-sm dark:border-zinc-700">
              <option value="TAKE">брать</option>
              <option value="CONSIDER">подумать</option>
              <option value="SKIP">пропустить</option>
            </select>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Почему: «бюджет нормальный, такие заказы быстро закрываю» или «это не разработка, а поддержка 24/7»"
            className={`${inputClass} text-sm`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              className={ghostButtonClass}
              onClick={() =>
                run(async () => {
                  const res = await submitAssessmentFeedback(leadId, verdict, note);
                  if ("ok" in res) {
                    setNote("");
                    setOpen(false);
                  }
                  return res;
                })
              }
            >
              Сохранить поправку
            </button>
            <button type="button" className="text-xs underline" onClick={() => setOpen(false)}>
              отмена
            </button>
          </div>
          <p className="text-xs text-zinc-500">Последние поправки AI учитывает в следующих оценках.</p>
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function TuningButton() {
  const { pending, error, run } = useAiAction();
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" disabled={pending} onClick={() => run(() => runTuning())} className={ghostButtonClass}>
        {pending ? "Анализирую… (до пары минут)" : "Предложить донастройку"}
      </button>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function ApplyRuleButton({ index, applied }: { index: number; applied: boolean }) {
  const [pending, start] = useTransition();
  if (applied) return <span className="text-xs text-emerald-700 dark:text-emerald-400">применено ✓</span>;
  return (
    <button type="button" disabled={pending} onClick={() => confirm("Заменить правила этой категории предложенным текстом?") && start(() => applyTuningRule(index))} className={ghostButtonClass}>
      Применить
    </button>
  );
}

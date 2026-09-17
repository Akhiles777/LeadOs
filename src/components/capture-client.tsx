"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { LeadStatus } from "@/generated/prisma/enums";
import { captureLead, lookupLead } from "@/lib/actions";
import { MAX_RAW_TEXT } from "@/lib/leads";
import type { Opportunity } from "@/lib/site-check";
import { OpportunityView } from "@/components/opportunity";
import { LeadFields } from "@/components/lead-fields";
import { StatusSelect } from "@/components/status-select";
import { buttonClass, Card, ghostButtonClass, PageHeader, StatusBadge } from "@/components/ui";

/**
 * Откуда и что принимаем. Источник лида определяется адресом отправителя, а не данными в сообщении:
 * страница Kwork не может прислать «компанию с карт» и наоборот.
 */
const SENDERS: Record<string, Sender> = {
  "https://kwork.ru": { source: "KWORK", ref: /^https:\/\/kwork\.ru\/projects\/\d+$/ },
  "https://www.kwork.ru": { source: "KWORK", ref: /^https:\/\/kwork\.ru\/projects\/\d+$/ },
  "https://yandex.ru": { source: "COLD_LOCAL", ref: /^https:\/\/yandex\.ru\/maps\/org\/\d+$/ },
  "https://2gis.ru": { source: "COLD_LOCAL", ref: /^https:\/\/2gis\.ru\/firm\/\d+$/ },
};
const READY_INTERVAL_MS = 250;
const READY_ATTEMPTS = 60;

type Payload = {
  source: "KWORK" | "COLD_LOCAL" | "MANUAL";
  sourceRef: string;
  title: string;
  rawText: string;
  budgetMax: number | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactTg: string | null;
  website: string | null;
  category: string | null;
  region: string | null;
};

type FoundLead = { id: string; title: string; status: LeadStatus; matchedBy?: "link" | "phone" };

type Phase =
  | { kind: "connecting" }
  | { kind: "no-opener" }
  | { kind: "timeout" }
  | { kind: "error"; message: string; sourceRef?: string; source?: Payload["source"] }
  | { kind: "checking"; payload: Payload }
  | { kind: "exists"; lead: FoundLead }
  | { kind: "form"; payload: Payload };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const optStr = (v: unknown, max: number) => str(v, max).trim() || null;

type Sender = { source: Payload["source"]; ref: RegExp };

/**
 * Универсальная закладка работает на любом сайте: лид создаётся как ручной, ссылка обязана вести на тот же сайт,
 * с которого пришло сообщение, — чужая страница не может подсунуть лид «от имени» Kwork или карт.
 */
function senderFor(origin: string, data: unknown): Sender | null {
  const generic = (data as { payload?: { kind?: string } } | null)?.payload?.kind === "generic";
  if (!generic) return SENDERS[origin] ?? null;
  // http тоже: у малого бизнеса много сайтов без HTTPS. Лид всё равно сохраняется только после проверки в окне.
  if (!/^https?:\/\/[^/]+$/.test(origin)) return null;
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { source: "MANUAL", ref: new RegExp(`^${escaped}(/|$)`) };
}

function toPayload(raw: unknown, sender: Sender): Payload | { error: string; sourceRef?: string } {
  if (!raw || typeof raw !== "object") return { error: "Пустые данные от закладки" };
  const r = raw as Record<string, unknown>;
  if (typeof r.error === "string") return { error: r.error, sourceRef: str(r.sourceRef, 1000) || undefined };

  const sourceRef = str(r.sourceRef, 1000);
  if (!sender.ref.test(sourceRef)) return { error: "Закладка прислала странную ссылку — переустанови её на странице «Закладки»" };
  const budget = typeof r.budgetMax === "number" && Number.isFinite(r.budgetMax) && r.budgetMax >= 0 ? Math.round(r.budgetMax) : null;

  return {
    source: sender.source,
    sourceRef,
    title: str(r.title, 300),
    rawText: str(r.rawText, MAX_RAW_TEXT),
    budgetMax: budget,
    contactName: optStr(r.contactName, 500),
    contactPhone: optStr(r.contactPhone, 100),
    contactEmail: optStr(r.contactEmail, 200),
    contactTg: optStr(r.contactTg, 100),
    website: optStr(r.website, 1000),
    category: optStr(r.category, 500),
    region: optStr(r.region, 500),
  };
}

export function CaptureClient() {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });

  useEffect(() => {
    const opener = window.opener as Window | null;
    let received = false;
    let attempts = 0;

    const onMessage = (event: MessageEvent) => {
      const sender = senderFor(event.origin, event.data);
      if (received || event.source !== opener || !sender) return;
      if (event.data?.type !== "leados:lead") return;
      received = true;

      const payload = toPayload(event.data.payload, sender);
      if ("error" in payload) {
        setPhase({ kind: "error", message: payload.error, sourceRef: payload.sourceRef, source: sender.source });
        return;
      }
      setPhase({ kind: "checking", payload });
      lookupLead(payload.source, payload.sourceRef, payload.contactPhone)
        .then((lead) => setPhase(lead ? { kind: "exists", lead } : { kind: "form", payload }))
        .catch(() => setPhase({ kind: "form", payload }));
    };
    window.addEventListener("message", onMessage);

    // Закладка может повесить слушатель чуть позже, чем загрузится это окно, — стучимся, пока не ответит.
    const timer = setInterval(() => {
      if (received) return clearInterval(timer);
      if (!opener || opener.closed) {
        clearInterval(timer);
        setPhase({ kind: "no-opener" });
        return;
      }
      if (++attempts > READY_ATTEMPTS) {
        clearInterval(timer);
        setPhase({ kind: "timeout" });
        return;
      }
      opener.postMessage({ type: "leados:ready" }, "*"); // в сообщении нет данных, только сигнал готовности
    }, READY_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  switch (phase.kind) {
    case "connecting":
    case "checking":
      return <PageHeader title="Добавить в LeadOS" subtitle={phase.kind === "connecting" ? "Получаю данные со страницы…" : "Проверяю, нет ли уже в LeadOS…"} />;

    case "no-opener":
      return (
        <>
          <PageHeader title="Добавить в LeadOS" />
          <Card>
            <p className="text-sm">
              Это окно открывается закладкой со страницы заказа на Kwork или карточки компании на картах.{" "}
              <Link href="/bookmarklet" className="underline">
                Как установить закладку
              </Link>
            </p>
          </Card>
        </>
      );

    case "timeout":
      return (
        <>
          <PageHeader title="Страница не ответила" />
          <Card>
            <p className="text-sm">
              Закрой окно и нажми закладку ещё раз. Если повторяется —{" "}
              <Link href="/bookmarklet" className="underline">
                переустанови закладку
              </Link>
              : возможно, у неё устарел адрес LeadOS.
            </p>
          </Card>
        </>
      );

    case "error":
      return (
        <>
          <PageHeader title="Не удалось прочитать страницу" subtitle={phase.message} />
          <Card>
            <p className="text-sm">
              Можно добавить вручную:{" "}
              <Link href={`/leads/new?source=${phase.source ?? "MANUAL"}`} className="underline">
                форма нового лида
              </Link>
              {phase.sourceRef && <> (ссылка: {phase.sourceRef})</>}
            </p>
          </Card>
        </>
      );

    case "exists":
      return <Result lead={phase.lead} created={false} />;

    case "form":
      return <CaptureForm payload={phase.payload} />;
  }
}

function CaptureForm({ payload }: { payload: Payload }) {
  const [state, formAction] = useActionState(captureLead, undefined);
  if (state?.lead) return <Result lead={state.lead} created={!!state.created} opportunity={state.opportunity} />;

  return (
    <>
      <PageHeader title="Добавить в LeadOS" subtitle="Проверь и поправь, если нужно." />
      <Card>
        <form action={formAction} onReset={(e) => e.preventDefault()} className="flex flex-col gap-4">
          <LeadFields lead={payload} defaultSource={payload.source} />
          <div className="flex items-center gap-3">
            <Submit />
            <button type="button" onClick={() => window.close()} className={ghostButtonClass}>
              Отмена
            </button>
            {state?.error && <p className="text-sm text-rose-600">{state.error}</p>}
          </div>
        </form>
      </Card>
    </>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass}>
      {pending ? "Сохраняю и проверяю сайт…" : "Добавить лид"}
    </button>
  );
}

function Result({ lead, created, opportunity }: { lead: FoundLead; created: boolean; opportunity?: Opportunity }) {
  return (
    <>
      <PageHeader
        title={created ? "Добавлено ✓" : "Уже в LeadOS"}
        subtitle={
          <>
            {lead.title}
            {lead.matchedBy === "phone" && " — совпал телефон (скорее всего, та же компания с другой карты)"}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500">Статус:</span>
            {created ? <StatusSelect id={lead.id} status={lead.status} compact /> : <StatusBadge status={lead.status} />}
          </div>
          {opportunity && opportunity.level !== "unknown" && <OpportunityView opportunity={opportunity} />}
          <div className="flex flex-wrap gap-3">
            <a href={`/leads/${lead.id}`} target="_blank" rel="noreferrer" className={buttonClass}>
              Открыть в LeadOS ↗
            </a>
            <button type="button" onClick={() => window.close()} className={ghostButtonClass}>
              Закрыть окно
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}

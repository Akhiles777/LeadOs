import type { Deal, DealAddon, Payment } from "@/generated/prisma/client";
import { addAddon, addPayment, saveDealBasics } from "@/lib/deal-actions";
import { formatDate } from "@/lib/leads";
import { dealTotals, isOverdue } from "@/lib/money";
import { dateInputValue } from "@/lib/time";
import { ActionForm } from "@/components/action-form";
import { InlineBar } from "@/components/bars";
import { AddonActions, PaidInFullButton, PaymentRowActions, PlanPayments, RetentionToggle, SuggestAddonsButton } from "@/components/deal-controls";
import { Field, inputClass } from "@/components/ui";

type FullDeal = Deal & { payments: Payment[]; addons: DealAddon[] };

const rub = (n: number) => `${n.toLocaleString("ru-RU")} ₽`;
const ADDON_STATUS = {
  PROPOSED: { label: "предложена", tone: "text-zinc-500" },
  ACCEPTED: { label: "принята", tone: "text-emerald-700 dark:text-emerald-400" },
  DECLINED: { label: "отказ", tone: "text-rose-600" },
} as const;
const KIND_LABEL = { PART: "", TIP: "чаевые", ADDON: "опция" } as const;

export function DealPanel({ leadId, deal, won }: { leadId: string; deal: FullDeal | null; won: boolean }) {
  const now = new Date();
  const totals = deal ? dealTotals(deal, now) : null;
  const payments = (deal?.payments ?? []).slice().sort((a, b) => (a.dueDate ?? a.paidAt ?? a.createdAt).getTime() - (b.dueDate ?? b.paidAt ?? b.createdAt).getTime());
  const plannedPart = payments.some((p) => p.kind !== "TIP");

  return (
    <div className="flex flex-col gap-5">
      {totals && totals.status !== "no_amount" && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label="Договор" value={rub(totals.contract)} hint={totals.addonsAccepted ? `в т.ч. опции ${rub(totals.addonsAccepted)}` : undefined} />
            <Stat label="Получено" value={rub(totals.paid)} />
            <Stat label="Остаток" value={rub(totals.outstanding)} tone={totals.overdue.length ? "text-rose-600" : undefined} />
            <Stat label="Чаевые" value={rub(totals.tips)} />
          </div>
          <InlineBar value={totals.progress} max={1} label={`${Math.round(totals.progress * 100)}%`} title={`Оплачено ${rub(totals.paid)} из ${rub(totals.contract)}`} />
          {totals.overdue.length > 0 && (
            <p className="text-sm text-rose-600">
              Просрочено: {totals.overdue.map((p) => `${p.title ?? "платёж"} ${rub(p.amount)} (срок ${formatDate(p.dueDate!)})`).join(", ")}
            </p>
          )}
          {totals.overpaid > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">Получено больше договора на {rub(totals.overpaid)} — проверь суммы.</p>}
          {totals.unscheduled > 0 && plannedPart && (
            <p className="text-xs text-amber-700 dark:text-amber-400">Не распределено по графику: {rub(totals.unscheduled)} — составь график заново или добавь платёж.</p>
          )}
        </div>
      )}

      {/* key: график и «Оплачено целиком» меняют сделку в обход формы — пересоздаём форму, чтобы она не вернула старые значения */}
      <ActionForm
        key={deal ? `${deal.paymentPlan}|${deal.amount}|${deal.stage}|${deal.startedAt?.getTime()}|${deal.closedAt?.getTime()}` : "new"}
        action={saveDealBasics.bind(null, leadId)}
        submitLabel={deal ? "Сохранить сделку" : "Создать сделку"}
        successText="Сохранено"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Сумма за работу, ₽">
            <input name="amount" inputMode="numeric" defaultValue={deal?.amount ?? ""} className={inputClass} />
          </Field>
          <Field label="Оплата">
            <select name="paymentPlan" defaultValue={deal?.paymentPlan ?? "FULL"} className={inputClass}>
              <option value="FULL">Целиком</option>
              <option value="INSTALLMENTS">Частями</option>
            </select>
          </Field>
          <Field label="Этап проекта">
            <input name="stage" defaultValue={deal?.stage ?? "Старт"} className={inputClass} />
          </Field>
          <div />
          <Field label="Начало">
            <input name="startedAt" type="date" defaultValue={dateInputValue(deal?.startedAt)} className={inputClass} />
          </Field>
          <Field label="Закрыта">
            <input name="closedAt" type="date" defaultValue={dateInputValue(deal?.closedAt)} className={inputClass} />
          </Field>
        </div>
      </ActionForm>

      {deal && (
        <>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-zinc-500">Платежи</h3>
            {payments.length === 0 && <p className="text-sm text-zinc-500">Платежей нет.</p>}
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
              {payments.map((p) => {
                const overdue = isOverdue(p, now);
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium tabular-nums">{rub(p.amount)}</span> {p.title}
                      {KIND_LABEL[p.kind] && p.title?.toLowerCase() !== KIND_LABEL[p.kind] && <span className="ml-1 text-xs text-zinc-500">· {KIND_LABEL[p.kind]}</span>}
                      <span className={`block text-xs ${p.paidAt ? "text-emerald-700 dark:text-emerald-400" : overdue ? "text-rose-600" : "text-zinc-500"}`}>
                        {p.paidAt ? `оплачено ${formatDate(p.paidAt)}${p.method ? ` · ${p.method}` : ""}` : p.dueDate ? `${overdue ? "просрочено, срок" : "срок"} ${formatDate(p.dueDate)}` : "без срока"}
                      </span>
                    </span>
                    <PaymentRowActions id={p.id} paid={Boolean(p.paidAt)} />
                  </li>
                );
              })}
            </ul>

            {totals && totals.contract > 0 && totals.outstanding > 0 && (
              <>
                <PaidInFullButton dealId={deal.id} label={totals.paid ? `Остаток ${rub(totals.outstanding)} оплачен` : `Оплачено целиком (${rub(totals.outstanding)})`} />
                <PlanPayments dealId={deal.id} defaultFirstDue={dateInputValue(now)} />
              </>
            )}

            <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm">+ Платёж, чаевые или оплата опции</summary>
              <ActionForm action={addPayment.bind(null, deal.id)} submitLabel="Добавить" successText="Добавлено" resetOnSuccess className="mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Тип">
                    <select name="kind" defaultValue="PART" className={inputClass}>
                      <option value="PART">Часть оплаты</option>
                      <option value="TIP">Чаевые</option>
                      <option value="ADDON">Оплата опции</option>
                    </select>
                  </Field>
                  <Field label="Сумма, ₽">
                    <input name="amount" required inputMode="numeric" className={inputClass} />
                  </Field>
                  <Field label="Название">
                    <input name="title" placeholder="Этап 2: интеграция" className={inputClass} />
                  </Field>
                  <Field label="Опция (для оплаты опции)">
                    <select name="addonId" defaultValue="" className={inputClass}>
                      <option value="">—</option>
                      {deal.addons
                        .filter((a) => a.status === "ACCEPTED")
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Срок оплаты">
                    <input name="dueDate" type="date" className={inputClass} />
                  </Field>
                  <Field label="Оплачено (дата)">
                    <input name="paidAt" type="date" className={inputClass} />
                  </Field>
                  <Field label="Способ" className="col-span-2">
                    <input name="method" placeholder="карта, СБП, Kwork, наличные, счёт" className={inputClass} />
                  </Field>
                </div>
              </ActionForm>
            </details>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-zinc-500">
                Доп. опции
                {totals && totals.addonsProposed > 0 && <span className="ml-1">· предложено на {rub(totals.addonsProposed)}</span>}
              </h3>
              <SuggestAddonsButton leadId={leadId} />
            </div>
            {deal.addons.length === 0 && <p className="text-sm text-zinc-500">Опций нет. Предложи клиенту то, что усилит результат, — принятые опции увеличивают сумму договора.</p>}
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
              {deal.addons.map((a) => (
                <li key={a.id} className="flex flex-col gap-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{a.title}</span> <span className="tabular-nums">{rub(a.price)}</span>{" "}
                      <span className={`text-xs ${ADDON_STATUS[a.status].tone}`}>· {ADDON_STATUS[a.status].label}</span>
                      {a.source === "ai" && <span className="ml-1 text-xs text-zinc-500">· от AI</span>}
                    </span>
                    <AddonActions id={a.id} status={a.status} />
                  </div>
                  {a.description && <p className="whitespace-pre-wrap text-xs text-zinc-500">{a.description}</p>}
                </li>
              ))}
            </ul>
            <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm">+ Опция вручную</summary>
              <ActionForm action={addAddon.bind(null, deal.id)} submitLabel="Добавить опцию" successText="Добавлено" resetOnSuccess className="mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Название">
                    <input name="title" required placeholder="Онлайн-запись с напоминаниями" className={inputClass} />
                  </Field>
                  <Field label="Цена, ₽">
                    <input name="price" required inputMode="numeric" className={inputClass} />
                  </Field>
                  <Field label="Статус">
                    <select name="status" defaultValue="PROPOSED" className={inputClass}>
                      <option value="PROPOSED">Предложена</option>
                      <option value="ACCEPTED">Принята</option>
                      <option value="DECLINED">Отказ</option>
                    </select>
                  </Field>
                  <Field label="Описание" className="col-span-2">
                    <textarea name="description" rows={2} className={inputClass} />
                  </Field>
                </div>
              </ActionForm>
            </details>
          </section>

          {won && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-zinc-500">Повторные продажи</h3>
              <RetentionToggle dealId={deal.id} kind="referral" doneAt={deal.referralAskedAt ? formatDate(deal.referralAskedAt) : null} label="Попросил отзыв и рекомендацию" />
              <RetentionToggle dealId={deal.id} kind="upsell" doneAt={deal.upsellAt ? formatDate(deal.upsellAt) : null} label="Предложил доработки" />
              <p className="text-xs text-zinc-500">Черновики этих сообщений — в блоке «Черновики сообщений». Напоминания появятся на дашборде через 14 и 90 дней после закрытия.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`font-semibold tabular-nums ${tone ?? ""}`}>{value}</p>
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

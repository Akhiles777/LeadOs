import type { Lead } from "@/generated/prisma/client";
import { SOURCE_LABEL, SOURCE_ORDER } from "@/lib/leads";
import { dateInputValue } from "@/lib/time";
import { Field, inputClass } from "@/components/ui";

const dateValue = dateInputValue;

export function LeadFields({
  lead,
  defaultSource = "MANUAL",
  referrers,
}: {
  lead?: Partial<Lead>;
  defaultSource?: string;
  /** Выигранные клиенты для поля «Кто порекомендовал»; без списка поле не показывается. */
  referrers?: { id: string; title: string }[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Заголовок *" className="sm:col-span-2">
        <input name="title" required defaultValue={lead?.title} placeholder="Сайт для стоматологии «Улыбка»" className={inputClass} />
      </Field>
      <Field label="Источник">
        <select name="source" defaultValue={lead?.source ?? defaultSource} className={inputClass}>
          {SOURCE_ORDER.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ссылка / ID в источнике">
        <input name="sourceRef" defaultValue={lead?.sourceRef ?? ""} placeholder="https://kwork.ru/projects/…" className={inputClass} />
      </Field>
      <Field label="Исходный текст заказа / поста" className="sm:col-span-2">
        <textarea name="rawText" rows={5} defaultValue={lead?.rawText} className={inputClass} />
      </Field>
      <Field label="Категория / ниша">
        <input name="category" defaultValue={lead?.category ?? ""} placeholder="клиника, розница, юрфирма…" className={inputClass} />
      </Field>
      <Field label="Регион">
        <input name="region" defaultValue={lead?.region ?? ""} className={inputClass} />
      </Field>
      <Field label="Бюджет от, ₽">
        <input name="budgetMin" inputMode="numeric" defaultValue={lead?.budgetMin ?? ""} className={inputClass} />
      </Field>
      <Field label="Бюджет до, ₽">
        <input name="budgetMax" inputMode="numeric" defaultValue={lead?.budgetMax ?? ""} className={inputClass} />
      </Field>
      <Field label="Контактное лицо">
        <input name="contactName" defaultValue={lead?.contactName ?? ""} className={inputClass} />
      </Field>
      <Field label="Телефон">
        <input name="contactPhone" type="tel" defaultValue={lead?.contactPhone ?? ""} className={inputClass} />
      </Field>
      <Field label="Telegram">
        <input name="contactTg" defaultValue={lead?.contactTg ?? ""} placeholder="@username" className={inputClass} />
      </Field>
      <Field label="Email">
        <input name="contactEmail" type="email" defaultValue={lead?.contactEmail ?? ""} className={inputClass} />
      </Field>
      <Field label="Сайт">
        <input name="website" defaultValue={lead?.website ?? ""} placeholder="example.ru" className={inputClass} />
      </Field>
      {referrers && (
        <Field label="Кто порекомендовал">
          <select name="referredById" defaultValue={lead?.referredById ?? ""} className={inputClass}>
            <option value="">—</option>
            {referrers
              .filter((r) => r.id !== lead?.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
          </select>
        </Field>
      )}
      <Field label="Следующее касание">
        <input name="followUpAt" type="date" defaultValue={dateValue(lead?.followUpAt)} className={inputClass} />
      </Field>
    </div>
  );
}

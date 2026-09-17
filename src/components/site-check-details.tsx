import { formatDate } from "@/lib/leads";
import { opportunity, type SiteCheck } from "@/lib/site-check";
import { SiteCheckButton } from "@/components/call-controls";
import { OpportunityView } from "@/components/opportunity";

const STATUS_TEXT: Record<SiteCheck["status"], string> = {
  no_site: "Сайт не указан",
  social_only: "Вместо сайта — соцсеть или мессенджер",
  ok: "Сайт открывается",
  unreachable: "Сайт не открывается",
  blocked: "Адрес не проверялся (внутренний или нестандартный)",
};

const yesNo = (v: boolean | undefined, yes: string, no: string) => (v ? yes : no);

export function SiteCheckDetails({ leadId, check, category }: { leadId: string; check: SiteCheck | null; category: string | null }) {
  if (!check) {
    return (
      <p className="text-sm text-zinc-500">
        Ещё не проверялся. <SiteCheckButton leadId={leadId} />
      </p>
    );
  }

  const facts =
    check.status === "ok"
      ? [
          check.platform ? `Платформа: ${check.platform}${check.builder ? " (конструктор)" : ""}` : "Платформа не определена",
          yesNo(check.hasBooking, "Есть онлайн-запись", "Онлайн-записи не видно"),
          yesNo(check.hasShop, "Есть корзина/магазин", "Магазина не видно"),
          yesNo(check.hasCrmWidget, "Есть чат/CRM-формы", "Чата и CRM-форм не видно"),
          yesNo(check.hasAnalytics, "Метрика/аналитика есть", "Аналитики не видно"),
          yesNo(check.mobile, "Адаптирован под телефоны", "Не адаптирован под телефоны"),
          yesNo(check.https, "HTTPS", "Без HTTPS"),
          check.lastYear ? `Год в копирайте: ${check.lastYear}` : "",
        ].filter(Boolean)
      : check.error
        ? [check.error]
        : [];

  return (
    <div className="flex flex-col gap-3">
      <OpportunityView opportunity={opportunity(check, category)} />
      <div className="text-sm">
        <p className="font-medium">{STATUS_TEXT[check.status]}</p>
        {check.title && <p className="text-xs text-zinc-500">«{check.title}»</p>}
        {facts.length > 0 && (
          <ul className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        Проверено {formatDate(new Date(check.checkedAt), true)} · <SiteCheckButton leadId={leadId} label="перепроверить" />
      </p>
    </div>
  );
}

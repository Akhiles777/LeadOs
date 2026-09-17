import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { formatBudget, formatDate, isSource, isStatus, SOURCE_LABEL, SOURCE_ORDER, STATUS_LABEL, STATUS_ORDER } from "@/lib/leads";
import { ScoreBadge } from "@/components/ai-assessment";
import { AllCheckbox, BulkSelect, RowCheckbox } from "@/components/bulk-select";
import { StatusSelect } from "@/components/status-select";
import { AddLeadLink, Card, EmptyState, ghostButtonClass, inputClass, PageHeader, SourceTag } from "@/components/ui";

export default async function LeadsPage(props: PageProps<"/leads">) {
  const sp = await props.searchParams;
  const status = isStatus(sp.status) ? sp.status : undefined;
  const source = isSource(sp.source) ? sp.source : undefined;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const sort = sp.sort === "score" ? "score" : "activity";

  const where: Prisma.LeadWhereInput = {
    ...(status && { status }),
    ...(source && { source }),
    ...(q && {
      OR: ["title", "rawText", "contactName", "contactPhone", "contactTg", "category", "region"].map((f) => ({
        [f]: { contains: q, mode: "insensitive" },
      })),
    }),
  };

  const leads = await db.lead.findMany({
    where,
    orderBy: sort === "score" ? [{ score: { sort: "desc", nulls: "last" } }, { lastActivityAt: "desc" }] : { lastActivityAt: "desc" },
    take: 200,
  });

  return (
    <>
      <PageHeader title="Лиды" subtitle={`Найдено: ${leads.length}${leads.length === 200 ? "+" : ""}`} action={<AddLeadLink />} />

      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Поиск по тексту, контакту, нише…" className={`${inputClass} max-w-xs`} />
        <select name="status" defaultValue={status ?? ""} className={`${inputClass} w-auto`}>
          <option value="">Все статусы</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select name="source" defaultValue={source ?? ""} className={`${inputClass} w-auto`}>
          <option value="">Все источники</option>
          {SOURCE_ORDER.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} className={`${inputClass} w-auto`}>
          <option value="activity">Сначала свежие</option>
          <option value="score">По оценке AI</option>
        </select>
        <button className={ghostButtonClass}>Фильтр</button>
        {(q || status || source || sort === "score") && (
          <Link href="/leads" className={ghostButtonClass}>
            Сбросить
          </Link>
        )}
      </form>

      <Card className="p-0!">
        {leads.length === 0 ? (
          <EmptyState>Лидов не найдено</EmptyState>
        ) : (
          <BulkSelect ids={leads.map((l) => l.id)}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="w-8 py-3 pl-4">
                    <AllCheckbox />
                  </th>
                  <th className="px-4 py-3 font-medium">Лид</th>
                  <th className="px-4 py-3 font-medium">AI</th>
                  <th className="px-4 py-3 font-medium">Статус</th>
                  <th className="px-4 py-3 font-medium">Бюджет</th>
                  <th className="px-4 py-3 font-medium">Контакт</th>
                  <th className="px-4 py-3 font-medium">Движение</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {leads.map((l) => (
                  <tr key={l.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="py-3 pl-4 align-top">
                      <RowCheckbox id={l.id} label={l.title} />
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <Link href={`/leads/${l.id}`} className="block truncate font-medium hover:underline">
                        {l.title}
                      </Link>
                      <div className="flex gap-2">
                        <SourceTag source={l.source} />
                        {l.category && <span className="text-xs text-zinc-400">· {l.category}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ScoreBadge score={l.score} verdict={l.aiVerdict} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusSelect id={l.id} status={l.status} compact />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatBudget(l.budgetMin, l.budgetMax)}</td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {[l.contactName, l.contactPhone, l.contactTg].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">{formatDate(l.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </BulkSelect>
        )}
      </Card>
    </>
  );
}

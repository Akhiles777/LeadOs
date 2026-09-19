import Link from "next/link";
import { connection } from "next/server";
import { saveProspecting } from "@/lib/cold-actions";
import { db } from "@/lib/db";
import { daysSince, formatDate, STATUS_LABEL } from "@/lib/leads";
import { mapLookupLinks, OSM_ATTRIBUTION } from "@/lib/osm";
import { allContacts, hasReachableContact } from "@/lib/contacts";
import { readPitch } from "@/ai/tasks/pitch";
import { ContactLinks } from "@/components/contact-links";
import { getProspectingSettings, mapSearchLinks } from "@/lib/settings";
import { nicheStats } from "@/lib/report";
import { loadReportLeads } from "@/lib/report-data";
import { opportunity, type SiteCheck } from "@/lib/site-check";
import { ActionForm } from "@/components/action-form";
import { CallControls, SiteCheckButton } from "@/components/call-controls";
import { SearchNicheButton } from "@/components/cold-search";
import { OpportunityView } from "@/components/opportunity";
import { Card, EmptyState, Field, inputClass, PageHeader, StatusBadge } from "@/components/ui";

const LEVEL_ORDER = { high: 0, medium: 1, unknown: 2, low: 3 } as const;

// AI-действия и проверка сайтов — дольше стандартного лимита функции на Vercel.
export const maxDuration = 300;

export default async function ProspectingPage() {
  await connection();
  const [settings, leads, statusCounts, yearLeads, jobs] = await Promise.all([
    getProspectingSettings(),
    db.lead.findMany({
      where: { source: "COLD_LOCAL", status: { in: ["NEW", "QUALIFIED", "CONTACTED"] } },
      include: { activities: { where: { type: "CALL" }, orderBy: { createdAt: "desc" }, take: 1 } },
      take: 300,
    }),
    db.lead.groupBy({ by: ["status"], where: { source: "COLD_LOCAL" }, _count: { _all: true } }),
    loadReportLeads("365d"),
    db.aiJob.findMany({
      where: { type: { in: ["SITE_CHECK", "FIND_CONTACTS", "COLD_OFFER"] }, status: { in: ["PENDING", "RUNNING"] }, leadId: { not: null } },
      select: { leadId: true, type: true },
      take: 1000,
    }),
  ]);
  // Что сейчас делается по компании в фоне — чтобы было видно, что контакты и оффер «в пути».
  const inWork = new Map<string, string>();
  const WORK_LABEL = { SITE_CHECK: "проверяю сайт", FIND_CONTACTS: "ищу контакты в интернете", COLD_OFFER: "подбираю оффер" } as const;
  for (const j of jobs) {
    const label = WORK_LABEL[j.type as keyof typeof WORK_LABEL];
    if (j.leadId && label) inWork.set(j.leadId, inWork.has(j.leadId) ? `${inWork.get(j.leadId)}, ${label}` : label);
  }
  // Какие ниши отвечают и платят — чтобы искать там, где уже получалось. Доля — только если звонков хватает для вывода.
  const nicheResults = new Map(nicheStats(yearLeads.leads, settings.niches).map((n) => [n.niche, n]));
  const MIN_CALLED = 3;

  const now = new Date();
  // Сначала те, кому пора перезвонить; дальше — с кем можно связаться, по перспективности, новые раньше старых.
  const rows = leads
    .map((lead) => ({
      lead,
      opp: opportunity(lead.siteCheck as unknown as SiteCheck | null, lead.category),
      reachable: hasReachableContact(allContacts(lead)),
      pitch: readPitch(lead.pitch),
    }))
    .sort((a, b) => {
      const dueA = a.lead.followUpAt && a.lead.followUpAt <= now ? 0 : 1;
      const dueB = b.lead.followUpAt && b.lead.followUpAt <= now ? 0 : 1;
      return (
        dueA - dueB ||
        Number(b.reachable) - Number(a.reachable) ||
        LEVEL_ORDER[a.opp.level] - LEVEL_ORDER[b.opp.level] ||
        b.opp.points - a.opp.points ||
        b.lead.createdAt.getTime() - a.lead.createdAt.getTime()
      );
    });
  const reachableCount = rows.filter((r) => r.reachable).length;

  const total = statusCounts.reduce((sum, s) => sum + s._count._all, 0);
  const count = (status: string) => statusCounts.find((s) => s.status === status)?._count._all ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Холодный поиск"
        subtitle={
          total
            ? `Компаний в базе: ${total} · в работе: ${rows.length} · ответили: ${count("RESPONDED") + count("NEGOTIATING")} · выиграно: ${count("WON")} · отказ: ${count("LOST")}`
            : "Найди компании на карте, открой карточку и нажми закладку «→ LeadOS (карты)»"
        }
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title={`Поиск${settings.region ? ` · ${settings.region}` : ""}`} className="lg:col-span-2">
          {!settings.region && <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">Укажи регион в настройках ниже — он добавляется к запросу.</p>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {[...settings.niches]
              .sort((a, b) => {
                // Сначала ниши со сделками, затем с лучшим откликом; новые — в исходном порядке.
                const sa = nicheResults.get(a);
                const sb = nicheResults.get(b);
                const score = (s?: typeof sa) => (s ? s.won * 100 + (s.called >= MIN_CALLED ? (s.respondRate ?? 0) * 10 : 0) : 0);
                return score(sb) - score(sa);
              })
              .map((niche) => {
              const links = mapSearchLinks(`${niche} ${settings.region}`);
              const stat = nicheResults.get(niche);
              return (
                <li key={niche} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    {niche}
                    {stat && (
                      <span className="block text-xs text-zinc-500">
                        в базе {stat.companies}
                        {stat.called >= MIN_CALLED && stat.respondRate != null && <> · отвечают {Math.round(stat.respondRate * 100)}%</>}
                        {stat.won > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · сделок {stat.won}</span>}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    <SearchNicheButton niche={niche} />
                    <span className="flex gap-3">
                      <a href={links.yandex} target="_blank" rel="noreferrer" className="underline">
                        Яндекс ↗
                      </a>
                      <a href={links.twoGis} target="_blank" rel="noreferrer" className="underline">
                        2ГИС ↗
                      </a>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">
            «Найти автоматически» — компании из OpenStreetMap. Дальше само: контакты с их сайтов, поиск контактов в интернете для тех,
            у кого их нет, подобранное решение (меню, запись в WhatsApp, CRM…) со скриптом звонка, сообщением и письмом. {OSM_ATTRIBUTION}.
            <br />
            Ссылки «Яндекс» и «2ГИС» — ручной поиск: открой карточку компании и нажми закладку.{" "}
            <Link href="/bookmarklet" className="underline">
              Установить закладку
            </Link>
          </p>

          <details className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-900">
            <summary className="cursor-pointer text-sm font-medium">Настройки: регион и ниши</summary>
            <ActionForm action={saveProspecting} submitLabel="Сохранить" successText="Сохранено" className="mt-3">
              <Field label="Город или регион">
                <input name="region" defaultValue={settings.region} placeholder="Махачкала" className={inputClass} />
              </Field>
              <Field label="Ниши, по одной в строке">
                <textarea name="niches" rows={8} defaultValue={settings.niches.join("\n")} className={`${inputClass} font-mono`} />
              </Field>
            </ActionForm>
          </details>
        </Card>

        <Card title={`Обзвон (${rows.length}${rows.length ? ` · с контактами ${reachableCount}` : ""})`} className="lg:col-span-3">
          {rows.length === 0 ? (
            <EmptyState>Пока некому звонить — добавь компании с карт</EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map(({ lead, opp, reachable, pitch }) => {
                const lastCall = lead.activities[0];
                const due = lead.followUpAt && lead.followUpAt <= now;
                return (
                  <li key={lead.id} className="flex flex-col gap-2 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                          {lead.title}
                        </Link>
                        <p className="text-xs text-zinc-500">{[lead.category, lead.region].filter(Boolean).join(" · ")}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {due && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">перезвонить</span>}
                        <StatusBadge status={lead.status} />
                      </div>
                    </div>

                    {pitch && (
                      <p className="text-sm">
                        <span className="text-zinc-500">Предложить:</span> <b>{pitch.solutionTitle}</b> · {pitch.price}{" "}
                        <Link href={`/leads/${lead.id}`} className="text-xs underline">
                          тексты →
                        </Link>
                      </p>
                    )}
                    {inWork.has(lead.id) && <p className="text-xs text-sky-700 dark:text-sky-400">В работе: {inWork.get(lead.id)}…</p>}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      {lead.contactPhone && (
                        <a href={`tel:${lead.contactPhone.replace(/[^\d+]/g, "")}`} className="font-medium tabular-nums underline">
                          {lead.contactPhone}
                        </a>
                      )}
                      {reachable ? (
                        <ContactLinks lead={{ ...lead, website: null, sourceRef: null }} />
                      ) : (
                        <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          контактов нет — найти:
                          <a href={mapLookupLinks(lead.title, null, lead.region).yandex} target="_blank" rel="noreferrer" className="underline">
                            Яндекс ↗
                          </a>
                          <a href={mapLookupLinks(lead.title, null, lead.region).twoGis} target="_blank" rel="noreferrer" className="underline">
                            2ГИС ↗
                          </a>
                        </span>
                      )}
                      {lead.website ? (
                        <a href={lead.website} target="_blank" rel="noreferrer" className="truncate text-xs underline">
                          {lead.website.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-500">сайта нет</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <OpportunityView opportunity={opp} compact />
                      <SiteCheckButton leadId={lead.id} label={lead.siteCheck ? "перепроверить" : "проверить сайт"} />
                    </div>

                    {lastCall && (
                      <p className="text-xs text-zinc-500">
                        Последний звонок {daysSince(lastCall.createdAt, now) === 0 ? formatDate(lastCall.createdAt, true) : formatDate(lastCall.createdAt)}: {lastCall.note}
                      </p>
                    )}
                    <CallControls leadId={lead.id} />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            «Не дозвонился» — напомнит завтра, «Перезвонить» — через 2 дня ({STATUS_LABEL.CONTACTED}), «Интересно» — {STATUS_LABEL.RESPONDED}, «Не интересно» —{" "}
            {STATUS_LABEL.LOST}. Всё пишется в историю лида.
          </p>
        </Card>
      </div>
    </div>
  );
}

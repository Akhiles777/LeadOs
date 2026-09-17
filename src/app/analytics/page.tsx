import Link from "next/link";
import { connection } from "next/server";
import { DRAFT_CHANNELS, type DraftChannel } from "@/ai/tasks/drafts";
import { FUNNEL_STAGES, SOURCE_LABEL, STATUS_LABEL } from "@/lib/leads";
import {
  callOutcomes,
  draftEdits,
  isPeriod,
  moneyStats,
  monthlyRevenue,
  nicheStats,
  opportunityOutcome,
  outreachStats,
  type Period,
  referralStats,
  scoreCalibration,
  sourceFunnel,
  telegramChannels,
  verdictAgreement,
} from "@/lib/report";
import { loadLeadTitles, loadReceivedPayments, loadReportLeads } from "@/lib/report-data";
import { getProspectingSettings } from "@/lib/settings";
import { InlineBar, MonthBars } from "@/components/bars";
import { Card, EmptyState, PageHeader } from "@/components/ui";

const PERIOD_LABEL: Record<Period, string> = { "30d": "30 дней", "90d": "90 дней", "365d": "Год", all: "Всё время" };
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const LEVEL_LABEL = { high: "Горячий", medium: "Тёплый", low: "Холодный", unknown: "Не проверен" } as const;
const VERDICT_LABEL = { TAKE: "Брать", CONSIDER: "Подумать", SKIP: "Пропустить" } as const;
const OUTCOME_LABEL = { no_answer: "Не дозвонился", callback: "Перезвонить", interested: "Интересно", not_interested: "Не интересно", other: "Другие записи" } as const;

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const rub = (v: number | null) => (v == null ? "—" : `${Math.round(v).toLocaleString("ru-RU")} ₽`);
const th = "px-3 py-2 font-medium";
const td = "px-3 py-2";

export default async function AnalyticsPage(props: PageProps<"/analytics">) {
  await connection();
  const sp = await props.searchParams;
  const period: Period = isPeriod(sp.period) ? sp.period : "90d";
  const now = new Date();

  const [{ leads, truncated }, payments, settings] = await Promise.all([loadReportLeads(period, now), loadReceivedPayments(now), getProspectingSettings()]);

  const sources = sourceFunnel(leads);
  const months = monthlyRevenue(payments, 12, now);
  const money = moneyStats(leads, now);
  const referrerIds = [...new Set(leads.map((l) => l.referredById).filter((x): x is string => Boolean(x)))];
  const referrals = referralStats(leads, await loadLeadTitles(referrerIds));
  const niches = nicheStats(leads, settings.niches);
  const calls = callOutcomes(leads);
  const opp = opportunityOutcome(leads);
  const channels = telegramChannels(leads);
  const outreach = outreachStats(leads);
  const calibration = scoreCalibration(leads);
  const agreement = verdictAgreement(leads);
  const edits = draftEdits(leads);

  const totalCalls = Object.values(calls).reduce((a, b) => a + b, 0);
  const yearRevenue = months.reduce((s, m) => s + m.revenue, 0);
  const yearTips = months.reduce((s, m) => s + m.tips, 0);
  const maxSourceTotal = Math.max(...sources.map((s) => s.total), 0);
  const channelLabel = (c: string) => DRAFT_CHANNELS[c as DraftChannel]?.label ?? c;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Аналитика"
        subtitle={`Лиды, созданные за период: ${leads.length}${truncated ? " (показаны последние 10 000)" : ""}. Выручка — по дате оплаты.`}
        action={
          <nav className="flex gap-1">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <Link
                key={p}
                href={`/analytics?period=${p}`}
                className={`rounded-md px-3 py-1.5 text-sm ${p === period ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                {PERIOD_LABEL[p]}
              </Link>
            ))}
          </nav>
        }
      />

      <Card title="Воронка по источникам — сколько дошло до этапа">
        {sources.length === 0 ? (
          <EmptyState>За период лидов нет</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className={th}>Источник</th>
                  {FUNNEL_STAGES.map((s) => (
                    <th key={s} className={`${th} text-right`}>
                      {STATUS_LABEL[s]}
                    </th>
                  ))}
                  <th className={`${th} text-right`}>Отказ / пропуск</th>
                  <th className={`${th} text-right`}>Доля сделок</th>
                  <th className={`${th} text-right`}>Договоры</th>
                  <th className={`${th} text-right`}>Получено</th>
                  <th className={`${th} text-right`}>Средний чек</th>
                  <th className={`${th} text-right`}>До сделки</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-900">
                {sources.map((s) => (
                  <tr key={s.source}>
                    <td className={td}>
                      <Link href={`/leads?source=${s.source}`} className="hover:underline">
                        {SOURCE_LABEL[s.source]}
                      </Link>
                    </td>
                    {s.reached.map((n, i) => (
                      <td key={i} className={`${td} text-right`} title={i ? `${n} из ${s.reached[i - 1]} (${pct(s.reached[i - 1] ? n / s.reached[i - 1] : null)})` : `${n} лидов`}>
                        {n}
                        {i > 0 && s.reached[i - 1] > 0 && <span className="ml-1 text-xs text-zinc-500">{pct(n / s.reached[i - 1])}</span>}
                      </td>
                    ))}
                    <td className={`${td} text-right`}>
                      {s.lost} / {s.skipped}
                    </td>
                    <td className={`${td} text-right`}>{pct(s.winRate)}</td>
                    <td className={`${td} text-right`}>{rub(s.contract)}</td>
                    <td className={`${td} text-right`}>{rub(s.revenue)}</td>
                    <td className={`${td} text-right`}>{rub(s.avgCheck)}</td>
                    <td className={`${td} text-right`}>{s.avgDaysToClose == null ? "—" : `${Math.round(s.avgDaysToClose)} дн.`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-zinc-500">Процент рядом с числом — переход с предыдущего этапа.</p>
          </div>
        )}
        {maxSourceTotal > 0 && (
          <div className="mt-4 grid gap-1.5 sm:max-w-md">
            {sources.map((s) => (
              <div key={s.source} className="grid grid-cols-[9rem_1fr] items-center gap-2 text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">{SOURCE_LABEL[s.source]}</span>
                <InlineBar value={s.total} max={maxSourceTotal} label={`${s.total}`} title={`${SOURCE_LABEL[s.source]}: ${s.total} лидов`} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Получено за 12 месяцев · ${rub(yearRevenue)}${yearTips ? ` + чаевые ${rub(yearTips)}` : ""}`}>
        {yearRevenue === 0 ? (
          <EmptyState>Оплат пока нет — отмечай их в карточке лида в блоке «Сделка и оплата»</EmptyState>
        ) : (
          <>
            <MonthBars
              rows={months.map((m) => {
                const [y, mm] = m.month.split("-");
                return {
                  key: m.month,
                  label: MONTHS[Number(mm) - 1],
                  value: m.revenue,
                  tooltip: `${MONTHS[Number(mm) - 1]} ${y}: ${rub(m.revenue)}${m.tips ? ` + чаевые ${rub(m.tips)}` : ""} · платежей ${m.payments}`,
                };
              })}
            />
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-zinc-500">Таблица</summary>
              <table className="mt-2 text-sm tabular-nums">
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month}>
                      <td className="pr-4">{m.month}</td>
                      <td className="pr-4 text-right">{rub(m.revenue)}</td>
                      <td className="pr-4 text-right text-zinc-500">чаевые {rub(m.tips)}</td>
                      <td className="text-right text-zinc-500">платежей: {m.payments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Деньги по выигранным сделкам" className="lg:col-span-2">
          {money.deals === 0 ? (
            <EmptyState>Выигранных сделок за период нет</EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Договоры" value={rub(money.contract)} hint={`сделок: ${money.deals}`} />
              <Metric label="Получено" value={rub(money.received)} hint={money.contract ? `${pct(money.received / money.contract)} от договоров` : undefined} />
              <Metric label="Ждём" value={rub(money.outstanding)} hint={money.overdue ? `просрочено ${rub(money.overdue)}` : "просрочек нет"} alert={money.overdue > 0} />
              <Metric label="Чаевые" value={rub(money.tips)} hint={`в ${money.dealsWithTips} из ${money.deals} сделок`} />
              <Metric label="Частями" value={`${money.installments} из ${money.deals}`} hint="сделок с оплатой по графику" />
              <Metric
                label="Доп. опции"
                value={rub(money.addonsRevenue)}
                hint={`принято ${money.addonsAccepted} из ${money.addonsProposed} · ${pct(money.addonsAcceptRate)} решённых${money.aiAddonsAccepted ? ` · от AI ${money.aiAddonsAccepted}` : ""}`}
              />
              <Metric label="Опции в чеке" value={pct(money.avgAddonsShare)} hint="средняя доля опций в договоре" />
              <Metric label="Без отмеченной оплаты" value={`${money.withoutPayments}`} hint="сделок — отметь оплату, иначе выручка занижена" alert={money.withoutPayments > 0} />
            </div>
          )}
        </Card>

        <Card title="Кто приводит клиентов">
          {referrals.length === 0 ? (
            <EmptyState>Рекомендаций за период нет. Отмечай «Кто порекомендовал» у лидов-рекомендаций.</EmptyState>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Клиент</th>
                  <th className="py-1 text-right font-medium">Привёл</th>
                  <th className="py-1 text-right font-medium">Сделок</th>
                  <th className="py-1 text-right font-medium">Получено</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((r) => (
                  <tr key={r.referrerId}>
                    <td className="py-1">
                      <Link href={`/leads/${r.referrerId}`} className="hover:underline">
                        {r.referrer}
                      </Link>
                    </td>
                    <td className="py-1 text-right">{r.leads}</td>
                    <td className="py-1 text-right">{r.won}</td>
                    <td className="py-1 text-right">{rub(r.received)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Холодный поиск по нишам" className="lg:col-span-3">
          {niches.length === 0 ? (
            <EmptyState>Компаний с карт за период нет</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className={th}>Ниша</th>
                    <th className={`${th} text-right`}>Компаний</th>
                    <th className={`${th} text-right`}>Звонков</th>
                    <th className={th}>Ответили из тех, кому звонил</th>
                    <th className={`${th} text-right`}>Сделок</th>
                    <th className={`${th} text-right`}>Получено</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-900">
                  {niches.map((n) => (
                    <tr key={n.niche}>
                      <td className={td}>{n.niche}</td>
                      <td className={`${td} text-right`}>{n.companies}</td>
                      <td className={`${td} text-right`} title={`«Интересно» — ${n.interestedCalls}`}>
                        {n.calls}
                      </td>
                      <td className={`${td} min-w-40`}>
                        <InlineBar value={n.respondRate ?? 0} max={1} label={n.called ? pct(n.respondRate) : "—"} title={`${n.responded} ответили · звонил ${n.called}`} />
                      </td>
                      <td className={`${td} text-right`}>{n.won}</td>
                      <td className={`${td} text-right`}>{rub(n.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-zinc-500">Ниша определяется по рубрикам компании и списку ниш из «Холодного поиска»; что не совпало — в «Другое».</p>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title={`Звонки · ${totalCalls}`}>
            {totalCalls === 0 ? (
              <EmptyState>Звонков за период нет</EmptyState>
            ) : (
              <div className="flex flex-col gap-1.5">
                {(Object.keys(OUTCOME_LABEL) as (keyof typeof OUTCOME_LABEL)[]).map((k) => (
                  <div key={k} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400">{OUTCOME_LABEL[k]}</span>
                    <InlineBar value={calls[k]} max={totalCalls} label={`${calls[k]}`} title={`${OUTCOME_LABEL[k]}: ${calls[k]} (${pct(calls[k] / totalCalls)})`} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Работает ли оценка сайта">
            {opp.every((o) => o.called === 0) ? (
              <EmptyState>Нужны звонки по компаниям с проверенным сайтом</EmptyState>
            ) : (
              <table className="w-full text-sm tabular-nums">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className="py-1 font-medium">Оценка</th>
                    <th className="py-1 text-right font-medium">Звонил</th>
                    <th className="py-1 font-medium">Ответили</th>
                  </tr>
                </thead>
                <tbody>
                  {opp.map((o) => (
                    <tr key={o.level}>
                      <td className="py-1">{LEVEL_LABEL[o.level]}</td>
                      <td className="py-1 text-right">{o.called}</td>
                      <td className="py-1 pl-3">
                        <InlineBar value={o.respondRate ?? 0} max={1} label={o.called ? pct(o.respondRate) : "—"} title={`${o.responded} из ${o.called} · сделок ${o.won}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-zinc-500">Если «Горячие» отвечают не чаще «Холодных» — аргументы про сайт в звонке не цепляют.</p>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Telegram-каналы">
          {channels.length === 0 ? (
            <EmptyState>Лидов из Telegram за период нет</EmptyState>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Канал</th>
                  <th className="py-1 text-right font-medium">Лидов</th>
                  <th className="py-1 text-right font-medium">Пропущено</th>
                  <th className="py-1 text-right font-medium">Ответили</th>
                  <th className="py-1 text-right font-medium">Сделок</th>
                  <th className="py-1 text-right font-medium">Ср. оценка</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {channels.map((c) => (
                  <tr key={c.channel}>
                    <td className="py-1">{c.channel}</td>
                    <td className="py-1 text-right">{c.leads}</td>
                    <td className="py-1 text-right">{c.skipped}</td>
                    <td className="py-1 text-right">{c.responded}</td>
                    <td className="py-1 text-right">{c.won}</td>
                    <td className="py-1 text-right">{c.avgScore == null ? "—" : Math.round(c.avgScore)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-zinc-500">Каналы, где почти всё пропускаешь, стоит перевести на ключевые слова или убрать.</p>
        </Card>

        <Card title="Отправленные сообщения">
          {outreach.length === 0 ? (
            <EmptyState>Отправленных черновиков за период нет — жми «Отправил» в карточке</EmptyState>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Тип</th>
                  <th className="py-1 text-right font-medium">Отправлено</th>
                  <th className="py-1 font-medium">Ответили</th>
                  <th className="py-1 text-right font-medium">Сделок</th>
                </tr>
              </thead>
              <tbody>
                {outreach.map((o) => (
                  <tr key={o.channel}>
                    <td className="py-1">{channelLabel(o.channel)}</td>
                    <td className="py-1 text-right">{o.sent}</td>
                    <td className="py-1 pl-3">
                      <InlineBar value={o.respondRate ?? 0} max={1} label={pct(o.respondRate)} title={`${o.responded} из ${o.leads} лидов`} />
                    </td>
                    <td className="py-1 text-right">{o.won}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Качество AI" action={<Link href="/ai#tuning" className="text-xs underline">донастройка →</Link>}>
        <div className="grid gap-6 lg:grid-cols-3">
          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">Оценка → что стало с лидом (решённые лиды)</p>
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Балл</th>
                  <th className="py-1 text-right font-medium">Лидов</th>
                  <th className="py-1 font-medium">Ответили</th>
                  <th className="py-1 text-right font-medium">Пропущено</th>
                </tr>
              </thead>
              <tbody>
                {calibration.map((c) => (
                  <tr key={c.bucket}>
                    <td className="py-1">{c.bucket}</td>
                    <td className="py-1 text-right">{c.leads}</td>
                    <td className="py-1 pl-3">
                      <InlineBar value={c.respondRate ?? 0} max={1} label={c.leads ? pct(c.respondRate) : "—"} title={`${c.responded} ответили, ${c.won} сделок`} />
                    </td>
                    <td className="py-1 text-right">{pct(c.skipRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-zinc-500">Хорошая оценка: чем выше балл, тем чаще ответ и реже пропуск.</p>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">Вердикт AI → твоё решение</p>
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">AI сказал</th>
                  <th className="py-1 text-right font-medium">Взял</th>
                  <th className="py-1 text-right font-medium">Пропустил</th>
                </tr>
              </thead>
              <tbody>
                {agreement.rows.map((r) => (
                  <tr key={r.verdict}>
                    <td className="py-1">{VERDICT_LABEL[r.verdict]}</td>
                    <td className="py-1 text-right">{r.taken}</td>
                    <td className="py-1 text-right">{r.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm">
              Совпадение: <b>{pct(agreement.agreement)}</b>
              {agreement.disagreements > 0 && <span className="text-zinc-500"> · расхождений {agreement.disagreements}</span>}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">Насколько правишь черновики перед отправкой</p>
            {edits.length === 0 ? (
              <p className="text-sm text-zinc-500">Отправленных AI-черновиков пока нет</p>
            ) : (
              <table className="w-full text-sm tabular-nums">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className="py-1 font-medium">Тип</th>
                    <th className="py-1 font-medium">Изменено слов</th>
                    <th className="py-1 text-right font-medium">Без правок</th>
                  </tr>
                </thead>
                <tbody>
                  {edits.map((e) => (
                    <tr key={e.channel}>
                      <td className="py-1">{channelLabel(e.channel)}</td>
                      <td className="py-1 pl-1">
                        <InlineBar value={e.avgEdit ?? 0} max={1} label={pct(e.avgEdit)} title={`${e.sent} отправлено, переписано больше половины: ${e.rewritten}`} />
                      </td>
                      <td className="py-1 text-right">
                        {e.unchanged}/{e.sent}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-zinc-500">Много правок — повод обновить правила стиля.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value, hint, alert }: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${alert ? "text-rose-600" : ""}`}>{value}</p>
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

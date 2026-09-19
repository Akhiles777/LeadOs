import { connection } from "next/server";
import type { PortfolioCase } from "@/generated/prisma/client";
import { AI_MODEL, AI_PROVIDER_NAME, AI_WRITER_MODEL, aiBlockedReason, isAiConfigured, weeklyBudgetRub, weeklySpendRub } from "@/ai/client";
import { BRAND_CATEGORIES } from "@/ai/context";
import { drainIfPending } from "@/ai/inline";
import { autoScoreEnabled } from "@/ai/jobs";
import { saveBrandRules, savePortfolioCase } from "@/lib/ai-actions";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/leads";
import { ActionForm } from "@/components/action-form";
import Link from "next/link";
import { type StoredTuning, TUNING_KEY } from "@/ai/tasks/tuning";
import { ApplyRuleButton, TuningButton } from "@/components/ai-panels";
import { CaseControls, QueueButtons } from "@/components/ai-settings-controls";
import { Card, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { SOLUTIONS } from "@/ai/solutions";

const VERDICT_RU = { TAKE: "брать", CONSIDER: "подумать", SKIP: "пропустить" } as const;

const PURPOSE_LABEL: Record<string, string> = {
  assess: "Оценка лидов",
  offer: "Отклики и сообщения",
  pitch: "Подбор оффера холодным",
  contacts: "Поиск контактов",
  call_script: "Скрипты звонков",
  follow_up: "Follow-up",
  digest: "Дайджест",
  tuning: "Донастройка",
};

// Черновик правил из описания LeadOS — показывается в полях, пока ничего не сохранено. AI его не видит до сохранения.
const RULE_DRAFTS: Record<string, string> = {
  о_себе: "Соло-разработчик. Ищу клиентов на Kwork, в Telegram-каналах и холодными звонками малому бизнесу в своём регионе: клиники, магазины, юрфирмы.",
  стек: "Next.js + TypeScript, PostgreSQL + Prisma. CRM-системы, учёт и интернет-магазины для розницы, AI-агенты с function calling.",
  запрещённые_проекты: "ML как основная задача, HighLoad (вроде агрегатора на 100 млн SKU), проекты, где нужна команда, а не один разработчик, серые схемы.",
  стиль_отклика: "Без списков. Не пересказывать ТЗ заказчика. Упоминать только реальные проекты.",
  тон: "",
  цены: "",
};

// AI-действия и проверка сайтов — дольше стандартного лимита функции на Vercel.
export const maxDuration = 300;

export default async function AiPage() {
  await connection();
  await drainIfPending();
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const [weekSpent, blocked] = await Promise.all([weeklySpendRub(), aiBlockedReason()]);
  const budget = weeklyBudgetRub();
  const [rules, cases, jobCounts, failedJobs, usage, heartbeat, tuningRow, feedback] = await Promise.all([
    db.personalBrandRule.findMany(),
    db.portfolioCase.findMany({ orderBy: [{ active: "desc" }, { createdAt: "asc" }] }),
    db.aiJob.groupBy({ by: ["status"], _count: { _all: true } }),
    db.aiJob.findMany({ where: { status: "FAILED" }, orderBy: { finishedAt: "desc" }, take: 5 }),
    db.aiCall.groupBy({
      by: ["purpose"],
      where: { createdAt: { gte: monthAgo } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costUsd: true },
    }),
    db.workerHeartbeat.findUnique({ where: { name: "ai" } }),
    db.appSetting.findUnique({ where: { key: TUNING_KEY } }),
    db.assessmentFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 5, include: { lead: { select: { id: true, title: true } } } }),
  ]);
  const feedbackTotal = await db.assessmentFeedback.count();
  const tuning = tuningRow?.value as unknown as StoredTuning | undefined;
  const categoryLabel = (key: string) => BRAND_CATEGORIES.find((c) => c.key === key)?.label ?? key;

  const configured = isAiConfigured();
  const count = (s: string) => jobCounts.find((j) => j.status === s)?._count._all ?? 0;
  const workerOnline = heartbeat && now.getTime() - heartbeat.seenAt.getTime() < 3 * 60_000;
  const saved = (key: string) => rules.filter((r) => r.category === key).map((r) => r.content).join("\n");
  const hasRules = rules.length > 0;
  const totalCost = usage.reduce((s, u) => s + (u._sum.costUsd ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="AI" subtitle="Оценка лидов, черновики откликов и скриптов звонков, дайджест. Решение и отправка — всегда за тобой." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Состояние">
          <ul className="flex flex-col gap-1.5 text-sm">
            <li>
              <Dot ok={configured} /> {AI_PROVIDER_NAME}: {configured ? "подключён" : "не подключён — нужен ROUTERAI_API_KEY (docs/INSTRUCTIONS.md)"}
            </li>
            <li className="text-zinc-500">
              Тексты клиентам: <b>{AI_WRITER_MODEL}</b> · остальное: <b>{AI_MODEL}</b>
            </li>
            <li>
              <Dot ok={!blocked} /> За 7 дней ≈{weekSpent.toFixed(1)} ₽{budget ? ` из ${budget} ₽ бюджета` : " (бюджет не задан — AI_WEEKLY_BUDGET_RUB)"}
            </li>
            {blocked && <li className="text-amber-700 dark:text-amber-400">{blocked}. Проверка сайтов и контакты с сайтов работают и без AI.</li>}
            <li>
              <Dot ok={!!workerOnline} /> Фоновый воркер:{" "}
              {heartbeat ? `${workerOnline ? "на связи" : "молчит"}, последний раз ${formatDate(heartbeat.seenAt, true)}` : "ещё не запускался (pnpm worker:ai)"}
            </li>
            <li>
              <Dot ok={autoScoreEnabled()} /> Автооценка новых лидов: {autoScoreEnabled() ? "включена" : "выключена"}
            </li>
            <li className="text-zinc-500">
              Очередь: ждут {count("PENDING")} · в работе {count("RUNNING")} · готово {count("DONE")} · ошибок {count("FAILED")}
            </li>
          </ul>
          {failedJobs.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-xs text-rose-600">
              {failedJobs.map((j) => (
                <li key={j.id}>
                  {j.type}
                  {j.leadId ? ` · ${j.leadId}` : ""}: {j.error}
                </li>
              ))}
            </ul>
          )}
          {configured && (
            <div className="mt-4">
              <QueueButtons failed={count("FAILED")} />
            </div>
          )}
        </Card>

        <Card title={`Расход за 30 дней · ≈ ${totalCost.toFixed(0)} ₽`}>
          {usage.length === 0 ? (
            <EmptyState>Вызовов модели ещё не было</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Задача</th>
                  <th className="py-1 text-right font-medium">Вызовов</th>
                  <th className="py-1 text-right font-medium">Токены вход/выход</th>
                  <th className="py-1 text-right font-medium">Из кэша</th>
                  <th className="py-1 text-right font-medium">₽</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {usage.map((u) => {
                  const input = (u._sum.inputTokens ?? 0) + (u._sum.cacheReadTokens ?? 0);
                  return (
                    <tr key={u.purpose}>
                      <td className="py-1">{PURPOSE_LABEL[u.purpose] ?? u.purpose}</td>
                      <td className="py-1 text-right">{u._count._all}</td>
                      <td className="py-1 text-right">
                        {Math.round(input / 1000)}k / {Math.round((u._sum.outputTokens ?? 0) / 1000)}k
                      </td>
                      <td className="py-1 text-right">{input ? `${Math.round(((u._sum.cacheReadTokens ?? 0) / input) * 100)}%` : "—"}</td>
                      <td className="py-1 text-right">{(u._sum.costUsd ?? 0).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            Примерно — по тарифам модели из каталога RouterAI (или AI_PRICE_*), без стоимости веб-поиска. Точные суммы — в кабинете RouterAI.
          </p>
        </Card>

        <section id="tuning" className="scroll-mt-20 lg:col-span-2">
          <Card title="Донастройка">
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-zinc-500">
                  Поправки к оценкам: <b className="text-zinc-900 dark:text-zinc-100">{feedbackTotal}</b>. Последние 15 AI учитывает в каждой оценке. Оставить поправку — «Оценка
                  неверна?» в карточке лида.
                </p>
                <ul className="flex flex-col gap-1.5 text-xs">
                  {feedback.map((f) => (
                    <li key={f.id}>
                      <Link href={`/leads/${f.lead.id}`} className="underline">
                        {f.lead.title}
                      </Link>
                      : {f.aiVerdict ? VERDICT_RU[f.aiVerdict] : "?"} → <b>{VERDICT_RU[f.correctVerdict]}</b>. {f.note}
                    </li>
                  ))}
                </ul>
                {configured && <TuningButton />}
                <p className="text-xs text-zinc-500">
                  AI посмотрит на поправки, на то, как ты переписываешь черновики, и на статистику <Link href="/analytics" className="underline">аналитики</Link>, и
                  предложит правки правил. Сам ничего не меняет.
                </p>
              </div>

              <div className="lg:col-span-2">
                {!tuning ? (
                  <EmptyState>Предложений пока нет</EmptyState>
                ) : (
                  <div className="flex flex-col gap-4">
                    <p className="text-xs text-zinc-500">Предложения от {formatDate(new Date(tuning.createdAt), true)}</p>
                    {tuning.result.observations.length > 0 && (
                      <ul className="list-inside list-disc text-sm">
                        {tuning.result.observations.map((o, i) => (
                          <li key={i}>{o}</li>
                        ))}
                      </ul>
                    )}
                    {tuning.result.ruleChanges.map((c, i) => (
                      <div key={i} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{categoryLabel(c.category)}</span>
                          <ApplyRuleButton index={i} applied={tuning.applied.includes(i)} />
                        </div>
                        <p className="text-xs text-zinc-500">{c.why}</p>
                        <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-2 font-sans text-sm dark:bg-zinc-900">{c.newText}</pre>
                      </div>
                    ))}
                    {tuning.result.ruleChanges.length === 0 && <p className="text-sm text-zinc-500">Менять правила пока не из чего.</p>}
                    {tuning.result.caseGaps.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-zinc-500">Каких кейсов не хватает</p>
                        <ul className="list-inside list-disc text-sm">
                          {tuning.result.caseGaps.map((g, i) => (
                            <li key={i}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </section>

        <Card title="Правила — как ты пишешь и что берёшь" className="lg:col-span-2">
          {!hasRules && (
            <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">
              Правила ещё не сохранены — AI их не видит. В полях черновик из описания LeadOS: поправь и сохрани.
            </p>
          )}
          {/* key: при изменении правил извне (кнопка «Применить» в донастройке) форма пересоздаётся, иначе поля покажут старый текст и перезапишут новый */}
          <ActionForm
            key={rules.map((r) => `${r.id}:${r.content.length}`).join("|") || "empty"}
            action={saveBrandRules}
            submitLabel="Сохранить правила"
            successText="Сохранено — применяется к следующим оценкам и черновикам"
          >
            <div className="grid gap-4 md:grid-cols-2">
              {BRAND_CATEGORIES.map(({ key, label, hint }) => (
                <Field key={key} label={label}>
                  <textarea name={key} rows={5} defaultValue={hasRules ? saved(key) : RULE_DRAFTS[key]} placeholder={hint} className={inputClass} />
                </Field>
              ))}
            </div>
          </ActionForm>
        </Card>

        <Card title={`Что AI предлагает бизнесу (${SOLUTIONS.length} решений)`} className="lg:col-span-2">
          <p className="mb-4 text-sm text-zinc-500">
            Встроенный каталог: для холодной компании AI выбирает одно решение под её нишу и то, чего ей не хватает, и строит на нём звонок,
            сообщение и письмо. Цены — рыночные ориентиры; свои цены и решения впиши в правило «Мои решения и цены» — они важнее.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {SOLUTIONS.map((sol) => (
              <details key={sol.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <summary className="cursor-pointer">
                  <span className="font-medium">{sol.title}</span>
                  <span className="block text-xs text-zinc-500">
                    {sol.price} · {sol.days}
                  </span>
                </summary>
                <div className="mt-2 flex flex-col gap-2 text-xs">
                  <p>
                    <b>Боли:</b> {sol.pains.join("; ")}
                  </p>
                  <p>
                    <b>Что входит:</b> {sol.deliverables.join("; ")}
                  </p>
                  <p>
                    <b>Первый шаг:</b> {sol.firstStep}
                  </p>
                </div>
              </details>
            ))}
          </div>
        </Card>

        <Card title={`Кейсы (${cases.filter((c) => c.active).length} видны AI)`} className="lg:col-span-2">
          <p className="mb-4 text-sm text-zinc-500">
            Только реальные проекты. AI ссылается на них в откликах и скриптах звонков и не придумывает других. Чем конкретнее результат для клиента — тем сильнее сообщения.
          </p>
          <div className="flex flex-col gap-3">
            {cases.map((c) => (
              <details key={c.id} className={`rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${c.active ? "" : "opacity-60"}`}>
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.title}</span>
                  <span className="text-xs text-zinc-500">{c.niches}</span>
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <CaseForm existing={c} />
                  <CaseControls id={c.id} active={c.active} />
                </div>
              </details>
            ))}
            <details className="rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700" open={cases.length === 0}>
              <summary className="cursor-pointer text-sm font-medium">+ Добавить кейс</summary>
              <div className="mt-3">
                <CaseForm />
              </div>
            </details>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CaseForm({ existing }: { existing?: PortfolioCase }) {
  return (
    <ActionForm action={savePortfolioCase} submitLabel={existing ? "Сохранить" : "Добавить кейс"} successText="Сохранено" resetOnSuccess={!existing}>
      {existing && <input type="hidden" name="id" value={existing.id} />}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Название">
          <input name="title" required defaultValue={existing?.title} placeholder="StoreOS — учёт и онлайн-витрина для розницы" className={inputClass} />
        </Field>
        <Field label="Кому подходит (ниши)">
          <input name="niches" required defaultValue={existing?.niches} placeholder="продуктовые магазины, гастрономы, розница" className={inputClass} />
        </Field>
        <Field label="Что сделано и что это дало клиенту" className="md:col-span-2">
          <textarea
            name="summary"
            required
            rows={4}
            defaultValue={existing?.summary}
            placeholder="Складской учёт, касса и онлайн-заказы в одной системе. Владелец видит остатки с телефона, заказы с сайта…"
            className={inputClass}
          />
        </Field>
        <Field label="Стек (необязательно)">
          <input name="stack" defaultValue={existing?.stack ?? ""} placeholder="Next.js, PostgreSQL" className={inputClass} />
        </Field>
        <Field label="Ссылка (необязательно)">
          <input name="url" defaultValue={existing?.url ?? ""} className={inputClass} />
        </Field>
      </div>
    </ActionForm>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`mr-1 inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-zinc-400"}`} />;
}

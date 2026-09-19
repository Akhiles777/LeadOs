import Link from "next/link";
import { notFound } from "next/navigation";
import { addActivity, updateLead } from "@/lib/actions";
import { db } from "@/lib/db";
import {
  ACTIVITY_LABEL,
  formatBudget,
  formatDate,
  MANUAL_ACTIVITY_TYPES,
  SOURCE_LABEL,
} from "@/lib/leads";
import type { SiteCheck } from "@/lib/site-check";
import { isAiConfigured } from "@/ai/client";
import { channelsFor, DRAFT_CHANNELS, type DraftChannel } from "@/ai/tasks/drafts";
import { quickPitch, readPitch } from "@/ai/tasks/pitch";
import { AiAssessment } from "@/components/ai-assessment";
import { DraftEditor, FindContactsButton, GenerateButtons, type SendTargets } from "@/components/ai-panels";
import { ContactLinks, ContactList } from "@/components/contact-links";
import { PitchPanel } from "@/components/pitch-panel";
import { allContacts, phoneDigits } from "@/lib/contacts";
import { mapLookupLinks } from "@/lib/osm";
import { DealPanel } from "@/components/deal-panel";
import { ActionForm } from "@/components/action-form";
import { CallControls } from "@/components/call-controls";
import { SiteCheckDetails } from "@/components/site-check-details";
import { DeleteLeadButton } from "@/components/delete-lead-button";
import { LeadFields } from "@/components/lead-fields";
import { StatusSelect } from "@/components/status-select";
import { Card, EmptyState, inputClass, PageHeader, StatusBadge } from "@/components/ui";

// AI-действия в карточке (оценка, черновики, опции) идут до минуты-двух — на Vercel поднимаем лимит функции.
export const maxDuration = 300;

const channelLabels = Object.fromEntries(Object.entries(DRAFT_CHANNELS).map(([k, v]) => [k, v.label])) as Record<DraftChannel, string>;

export default async function LeadPage(props: PageProps<"/leads/[id]">) {
  const { id } = await props.params;
  const lead = await db.lead.findUnique({
    where: { id },
    include: {
      activities: { orderBy: { createdAt: "desc" } },
      deal: { include: { payments: true, addons: true } },
      offers: { orderBy: { createdAt: "desc" } },
      feedback: { orderBy: { createdAt: "desc" }, select: { id: true, correctVerdict: true, note: true, createdAt: true } },
    },
  });
  if (!lead) notFound();
  const referrers = await db.lead.findMany({ where: { status: "WON" }, orderBy: { updatedAt: "desc" }, take: 300, select: { id: true, title: true } });

  const contacts = allContacts(lead);
  const waContact = contacts.find((c) => c.kind === "whatsapp") ?? contacts.find((c) => c.kind === "phone");
  const sendTo: SendTargets = {
    whatsapp: waContact ? phoneDigits(waContact.value) : null,
    email: contacts.find((c) => c.kind === "email")?.value ?? null,
    telegram: contacts.find((c) => c.kind === "telegram")?.value ?? null,
  };
  // Свои предложения (холодные, ручные, рекомендации) — с подбором решения; на заказы Kwork/Telegram отвечаем по их задаче.
  const offerOwn = lead.source !== "KWORK" && lead.source !== "TELEGRAM";
  const aiReady = isAiConfigured();
  const address = /Адрес: (.+)/.exec(lead.rawText)?.[1] ?? null;
  const maps = mapLookupLinks(lead.title, address, lead.region);

  return (
    <>
      <PageHeader
        title={lead.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={lead.status} />
            <span>{SOURCE_LABEL[lead.source]}</span>
            <span>Бюджет: {formatBudget(lead.budgetMin, lead.budgetMax)}</span>
            <span>Создан {formatDate(lead.createdAt)}</span>

          </span>
        }
        action={
          <div className="w-48">
            <StatusSelect id={lead.id} status={lead.status} />
          </div>
        }
      />

      <div className="-mt-3 mb-6">
        <ContactLinks lead={lead} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="flex flex-col gap-6 lg:col-span-3">
          {lead.rawText && (
            <Card title="Исходный текст">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{lead.rawText}</p>
            </Card>
          )}

          <Card title="Оценка AI">
            <AiAssessment lead={lead} feedback={lead.feedback} />
          </Card>

          {(lead.source === "COLD_LOCAL" || lead.website || lead.siteCheck) && (
            <Card title="Сайт компании">
              <SiteCheckDetails leadId={lead.id} check={lead.siteCheck as unknown as SiteCheck | null} category={lead.category} />
            </Card>
          )}

          {offerOwn && lead.status !== "WON" && (
            <Card title="Что предложить">
              <PitchPanel leadId={lead.id} aiPitch={readPitch(lead.pitch)} catalogPitch={quickPitch(lead)} aiReady={aiReady} />
            </Card>
          )}

          <Card title="Черновики сообщений">
            <div className="flex flex-col gap-4">
              <GenerateButtons leadId={lead.id} channels={channelsFor(lead)} labels={channelLabels} />
              {lead.offers.length === 0 ? (
                <p className="text-sm text-zinc-500">Черновиков пока нет. AI пишет по твоим правилам и кейсам из раздела «AI» — отправляешь сам.</p>
              ) : (
                lead.offers.map((d) => (
                  <DraftEditor
                    key={d.id}
                    label={DRAFT_CHANNELS[d.channel as DraftChannel]?.label ?? d.channel}
                    channel={d.channel}
                    sendTo={lead.source === "KWORK" ? {} : sendTo}
                    draft={{
                      id: d.id,
                      text: d.text,
                      notes: d.notes,
                      model: d.model,
                      sentAt: d.sentAt ? formatDate(d.sentAt, true) : null,
                      createdAt: formatDate(d.createdAt, true),
                    }}
                  />
                ))
              )}
            </div>
          </Card>

          <Card title="Данные лида">
            <ActionForm action={updateLead.bind(null, lead.id)} submitLabel="Сохранить" successText="Сохранено">
              <LeadFields lead={lead} referrers={referrers} />
            </ActionForm>
          </Card>

          <div className="flex justify-between">
            <Link href="/leads" className="text-sm text-zinc-500 hover:underline">
              ← Ко всем лидам
            </Link>
            <DeleteLeadButton id={lead.id} />
          </div>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Контакты">
            <div className="flex flex-col gap-3">
              {lead.contactPhone && (
                <a href={`tel:${lead.contactPhone.replace(/[^\d+]/g, "")}`} className="block text-lg font-semibold tabular-nums underline">
                  {lead.contactPhone}
                </a>
              )}
              {contacts.length ? (
                <ContactList contacts={contacts} />
              ) : (
                <p className="text-sm text-zinc-500">{lead.source === "KWORK" ? "На Kwork общение идёт через площадку." : "Контактов пока нет."}</p>
              )}
              {offerOwn && (
                <>
                  {aiReady && <FindContactsButton leadId={lead.id} searchedAt={lead.contactsSearchedAt ? formatDate(lead.contactsSearchedAt, true) : null} />}
                  <p className="text-xs text-zinc-500">
                    Найти на картах:{" "}
                    <a href={maps.yandex} target="_blank" rel="noreferrer" className="underline">
                      Яндекс ↗
                    </a>{" "}
                    <a href={maps.twoGis} target="_blank" rel="noreferrer" className="underline">
                      2ГИС ↗
                    </a>{" "}
                    — закладка «→ LeadOS (карты)» допишет контакты сюда.
                  </p>
                </>
              )}
              {lead.source === "COLD_LOCAL" && <CallControls leadId={lead.id} />}
            </div>
          </Card>

          <Card title="Добавить в историю">
            <ActionForm action={addActivity.bind(null, lead.id)} submitLabel="Добавить" resetOnSuccess>
              <select name="type" defaultValue="NOTE" className={inputClass}>
                {MANUAL_ACTIVITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACTIVITY_LABEL[t]}
                  </option>
                ))}
              </select>
              <textarea name="note" rows={3} required placeholder="Что было / о чём договорились" className={inputClass} />
            </ActionForm>
          </Card>

          <Card title="История">
            {lead.activities.length === 0 ? (
              <EmptyState>Пока пусто</EmptyState>
            ) : (
              <ol className="flex flex-col gap-4 border-l border-zinc-200 pl-4 dark:border-zinc-800">
                {lead.activities.map((a) => (
                  <li key={a.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-zinc-400" />
                    <p className="text-xs text-zinc-500">
                      {ACTIVITY_LABEL[a.type]} · {formatDate(a.createdAt, true)}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{a.note}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Сделка и оплата">
            <DealPanel leadId={lead.id} deal={lead.deal} won={lead.status === "WON"} />
          </Card>
        </div>
      </div>
    </>
  );
}

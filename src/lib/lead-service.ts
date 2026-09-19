import { contactsFromFields, mergeContacts, readContacts } from "@/lib/contacts";
import { Prisma } from "@/generated/prisma/client";
import { drainQueueAfterResponse } from "@/ai/inline";
import { autoScoreEnabled, enqueue } from "@/ai/jobs";
import { db } from "@/lib/db";
import type { LeadInput } from "@/lib/lead-input";
import { normalizeSourceRef } from "@/lib/source-ref";

/** Название компании без кавычек, регистра и лишних слов — чтобы «Дентал Хаус» и «Дентал Хаус | стоматология» совпали. */
function companyKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/["«»„“”'`]/g, "")
    .split(/[|(/,]/)[0]
    .replace(/(?<!\p{L})(ооо|ип|зао|оао|сеть|компания|клиника|стоматология|магазин|салон|центр)(?!\p{L})/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Компания уже найдена автоматически (OpenStreetMap), а сейчас её карточку открыли на картах —
 * дописываем телефон и сайт в тот же лид вместо дубля.
 */
export async function findCompanyToEnrich(input: LeadInput): Promise<string | null> {
  if (input.source !== "COLD_LOCAL" || !input.contactPhone || !input.title) return null;
  const key = companyKey(input.title);
  if (key.length < 4) return null;

  const candidates = await db.lead.findMany({
    where: {
      source: "COLD_LOCAL",
      contactPhone: null,
      ...(input.region ? { region: { equals: input.region, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, title: true },
  });
  const hit = candidates.find((c) => {
    const other = companyKey(c.title);
    return other.length >= 4 && (other === key || other.includes(key) || key.includes(other));
  });
  return hit?.id ?? null;
}

/** Дописывает то, чего не хватало: телефон, сайт, нишу и ссылку на карточку. */
export async function enrichCompany(leadId: string, input: LeadInput): Promise<void> {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const fromMaps = contactsFromFields(input).map((c) => ({ ...c, source: "maps" as const, note: input.sourceRef ? "карточка на картах" : undefined }));
  const contacts = mergeContacts(readContacts(lead.contacts), fromMaps);
  await db.lead.update({
    where: { id: leadId },
    data: {
      contacts: contacts as unknown as Prisma.InputJsonArray,
      contactTg: lead.contactTg ?? input.contactTg,
      contactEmail: lead.contactEmail ?? input.contactEmail,
      contactPhone: lead.contactPhone ?? input.contactPhone,
      website: lead.website ?? input.website,
      category: lead.category ?? input.category,
      contactName: lead.contactName ?? input.contactName,
      region: lead.region ?? input.region,
      rawText: [lead.rawText, input.sourceRef ? `Карточка на картах: ${input.sourceRef}` : ""].filter(Boolean).join("\n"),
      lastActivityAt: new Date(),
    },
  });
}

export type CreateLeadResult = { id: string; created: true } | { id: string; created: false; duplicate: true };

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function findDuplicate(source: LeadInput["source"], sourceRef: string | null, excludeId?: string) {
  if (!sourceRef) return null;
  return db.lead.findFirst({
    where: { source, sourceRef, ...(excludeId && { id: { not: excludeId } }) },
    select: { id: true, title: true },
  });
}

/** Создаёт лид; если такой sourceRef в этом источнике уже есть — возвращает существующий. */
/** Ссылка на порекомендовавшего клиента должна указывать на существующий лид — иначе просто не сохраняем её. */
async function checkReferrer<T extends { referredById?: string | null }>(input: T, selfId?: string): Promise<T> {
  if (!input.referredById) return { ...input, referredById: null };
  if (input.referredById === selfId) return { ...input, referredById: null };
  const exists = await db.lead.findUnique({ where: { id: input.referredById }, select: { id: true } });
  return exists ? input : { ...input, referredById: null };
}

export async function createLeadDeduped(
  input: LeadInput,
  extra: Pick<Prisma.LeadCreateInput, "contentHash"> = {},
): Promise<CreateLeadResult> {
  const data = { ...(await checkReferrer(input)), ...extra, sourceRef: normalizeSourceRef(input.source, input.sourceRef) };

  const existing = await findDuplicate(data.source, data.sourceRef);
  if (existing) return { id: existing.id, created: false, duplicate: true };

  try {
    const lead = await db.lead.create({ data, select: { id: true } });
    if (autoScoreEnabled()) {
      await enqueue("SCORE_LEAD", lead.id).catch((e) => console.error("Не удалось поставить оценку лида", e));
      drainQueueAfterResponse();
    }
    return { id: lead.id, created: true };
  } catch (e) {
    // Гонка: два одинаковых запроса одновременно (двойной клик по кнопке расширения).
    if (isUniqueViolation(e)) {
      const dup = await findDuplicate(data.source, data.sourceRef);
      if (dup) return { id: dup.id, created: false, duplicate: true };
    }
    throw e;
  }
}

/** Обновляет лид; при конфликте sourceRef возвращает найденный дубль вместо исключения. */
export async function updateLeadChecked(id: string, input: LeadInput) {
  const data = { ...(await checkReferrer(input, id)), sourceRef: normalizeSourceRef(input.source, input.sourceRef) };
  const existing = await findDuplicate(data.source, data.sourceRef, id);
  if (existing) return { duplicate: existing } as const;

  try {
    await db.lead.update({ where: { id }, data });
    return { ok: true } as const;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const dup = await findDuplicate(data.source, data.sourceRef, id);
      if (dup) return { duplicate: dup } as const;
    }
    throw e;
  }
}

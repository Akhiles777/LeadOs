import { Prisma } from "@/generated/prisma/client";
import { drainQueueAfterResponse } from "@/ai/inline";
import { autoScoreEnabled, enqueue } from "@/ai/jobs";
import { db } from "@/lib/db";
import type { LeadInput } from "@/lib/lead-input";
import { normalizeSourceRef } from "@/lib/source-ref";

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

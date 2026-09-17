import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { buildRecords, type ColumnMapping, IMPORT_FIELDS, type ImportRecord, stageForStatus } from "@/lib/import/mapping";
import { SOURCE_ORDER, STATUS_ORDER } from "@/lib/leads";
import { dayKey } from "@/lib/time";

export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_CHUNK = 200;

const chunkSchema = z.object({
  batchId: z.string().min(1),
  offset: z.number().int().min(0).max(MAX_IMPORT_ROWS),
  rows: z.array(z.array(z.string().max(10_000)).max(100)).max(IMPORT_CHUNK),
  mapping: z.partialRecord(z.enum(Object.keys(IMPORT_FIELDS) as [string, ...string[]]), z.number().int().min(0).max(99)),
  options: z.object({
    defaultSource: z.enum(SOURCE_ORDER as [string, ...string[]]),
    defaultStatus: z.enum(STATUS_ORDER as [string, ...string[]]),
    wonArePaid: z.boolean(),
  }),
});
export type ImportChunk = z.input<typeof chunkSchema>;

export type ChunkResult = { created: number; skipped: { row: number; reason: string }[] };

async function findDuplicate(r: ImportRecord): Promise<string | null> {
  if (r.contactPhone?.startsWith("+7 ")) {
    const hit = await db.lead.findFirst({ where: { contactPhone: r.contactPhone }, select: { title: true } });
    if (hit) return `такой телефон уже есть («${hit.title}»)`;
  }
  if (r.contactEmail) {
    const hit = await db.lead.findFirst({ where: { contactEmail: { equals: r.contactEmail, mode: "insensitive" } }, select: { title: true } });
    if (hit) return `такой email уже есть («${hit.title}»)`;
  }
  if (r.createdAt) {
    const from = new Date(r.createdAt.getTime() - 36 * 3_600_000);
    const to = new Date(r.createdAt.getTime() + 36 * 3_600_000);
    const same = await db.lead.findMany({ where: { title: { equals: r.title, mode: "insensitive" }, createdAt: { gte: from, lte: to } }, select: { createdAt: true } });
    if (same.some((l) => dayKey(l.createdAt) === dayKey(r.createdAt!))) return "лид с таким названием и датой уже есть";
  }
  return null;
}

/** «Кто порекомендовал» из таблицы — ищем клиента с таким названием; не нашли — оставляем в комментарии. */
async function findReferrer(title: string | null): Promise<string | null> {
  if (!title) return null;
  const hit = await db.lead.findFirst({ where: { title: { equals: title, mode: "insensitive" } }, orderBy: { status: "asc" }, select: { id: true } });
  return hit?.id ?? null;
}

function leadData(r: ImportRecord, batchId: string, referredById: string | null): Prisma.LeadCreateInput {
  const createdAt = r.createdAt ?? new Date();
  const won = r.status === "WON";
  const payments: Prisma.PaymentCreateWithoutDealInput[] = [];
  if (won && r.paid && r.paid > 0) payments.push({ kind: "PART", title: "Оплата (импорт)", amount: r.paid, paidAt: r.closedAt ?? createdAt });
  if (won && r.tips && r.tips > 0) payments.push({ kind: "TIP", title: "Чаевые (импорт)", amount: r.tips, paidAt: r.closedAt ?? createdAt });

  return {
    source: r.source,
    title: r.title,
    rawText: r.referredByTitle && !referredById ? `${r.notes}\n\nПорекомендовал: ${r.referredByTitle}`.trim() : r.notes,
    ...(referredById && { referredBy: { connect: { id: referredById } } }),
    category: r.category,
    region: r.region,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactEmail: r.contactEmail,
    contactTg: r.contactTg,
    website: r.website,
    status: r.status,
    furthestStage: stageForStatus(r.status),
    // Бюджет у незавершённых — ориентир из таблицы; у выигранных сумма уходит в сделку.
    budgetMax: won ? null : r.amount,
    createdAt,
    lastActivityAt: r.closedAt ?? createdAt,
    importBatch: batchId,
    activities: { create: { type: "NOTE", note: `Импортировано из таблицы (строка ${r.row})`, createdAt } },
    ...(won && {
      deal: {
        create: {
          amount: r.amount,
          stage: "Сдан",
          startedAt: createdAt,
          closedAt: r.closedAt ?? createdAt,
          // Импортированные сделки — история: не просим о рекомендации и доработках задним числом.
          referralAskedAt: r.closedAt ?? createdAt,
          upsellAt: null,
          payments: { create: payments },
        },
      },
    }),
  };
}

export async function startImportBatch(fileName: string | null) {
  return db.importBatch.create({ data: { fileName: fileName?.slice(0, 200) ?? null }, select: { id: true } });
}

/** Импорт одной пачки строк. Строки разбираются заново на сервере — клиенту не доверяем. Импорт не запускает AI-оценку. */
export async function importChunk(input: ImportChunk): Promise<ChunkResult> {
  const parsed = chunkSchema.parse(input);
  const batch = await db.importBatch.findUniqueOrThrow({ where: { id: parsed.batchId } });
  const records = buildRecords(parsed.rows, parsed.mapping as ColumnMapping, parsed.options as never, parsed.offset + 2);

  const result: ChunkResult = { created: 0, skipped: [] };
  for (const r of records) {
    if (r.error) {
      result.skipped.push({ row: r.row, reason: r.error });
      continue;
    }
    const duplicate = await findDuplicate(r);
    if (duplicate) {
      result.skipped.push({ row: r.row, reason: duplicate });
      continue;
    }
    try {
      await db.lead.create({ data: leadData(r, batch.id, await findReferrer(r.referredByTitle)), select: { id: true } });
      result.created++;
    } catch (e) {
      result.skipped.push({ row: r.row, reason: e instanceof Error ? e.message.split("\n").at(-1)!.slice(0, 200) : "ошибка записи" });
    }
  }
  await db.importBatch.update({ where: { id: batch.id }, data: { created: { increment: result.created }, skipped: { increment: result.skipped.length } } });
  return result;
}

export async function undoImport(batchId: string) {
  const deleted = await db.lead.deleteMany({ where: { importBatch: batchId } });
  await db.importBatch.delete({ where: { id: batchId } }).catch(() => {});
  return deleted.count;
}

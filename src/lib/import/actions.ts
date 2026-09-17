"use server";

import { revalidatePath } from "next/cache";
import { type ChunkResult, type ImportChunk, importChunk, startImportBatch, undoImport } from "@/lib/import/service";

export async function beginImport(fileName: string | null) {
  return startImportBatch(fileName);
}

export async function sendImportChunk(chunk: ImportChunk): Promise<ChunkResult | { error: string }> {
  try {
    return await importChunk(chunk);
  } catch (e) {
    console.error(e);
    return { error: "Пачка не импортирована — проверь файл и повтори" };
  }
}

export async function finishImport() {
  for (const p of ["/", "/leads", "/pipeline", "/analytics", "/import"]) revalidatePath(p);
}

export async function rollbackImport(batchId: string) {
  const count = await undoImport(batchId);
  for (const p of ["/", "/leads", "/pipeline", "/analytics", "/import"]) revalidatePath(p);
  return count;
}

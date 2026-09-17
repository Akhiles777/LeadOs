"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import type { ChannelFilterMode } from "@/generated/prisma/enums";
import type { FormState } from "@/lib/actions";
import { db } from "@/lib/db";
import { parseChannelRef } from "@/lib/telegram";

const done = () => revalidatePath("/telegram");

function isUnique(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function addChannel(_prev: FormState, formData: FormData): Promise<FormState> {
  const ref = parseChannelRef(String(formData.get("ref") ?? ""));
  if ("error" in ref) return { error: ref.error };
  const filterMode = formData.get("filterMode") === "ALL" ? "ALL" : "KEYWORDS";

  try {
    await db.telegramChannel.create({ data: { ...ref, filterMode } });
  } catch (e) {
    if (isUnique(e)) return { error: "Этот канал уже в списке" };
    throw e;
  }
  done();
  return { ok: true };
}

export async function addDialogChannel(dialog: { peerId: string; title: string; username?: string | null }) {
  const username = dialog.username?.toLowerCase() || null;
  const existing = await db.telegramChannel.findFirst({
    where: { OR: [{ peerId: dialog.peerId }, ...(username ? [{ username }] : [])] },
  });
  if (existing) {
    await db.telegramChannel.update({ where: { id: existing.id }, data: { enabled: true, peerId: dialog.peerId, title: dialog.title } });
  } else {
    await db.telegramChannel.create({ data: { peerId: dialog.peerId, title: dialog.title, username } });
  }
  done();
}

export async function setChannelEnabled(id: string, enabled: boolean) {
  await db.telegramChannel.update({ where: { id }, data: { enabled, ...(enabled ? { lastError: null } : {}) } });
  done();
}

export async function setChannelMode(id: string, filterMode: ChannelFilterMode) {
  await db.telegramChannel.update({ where: { id }, data: { filterMode: filterMode === "ALL" ? "ALL" : "KEYWORDS" } });
  done();
}

export async function deleteChannel(id: string) {
  await db.telegramChannel.delete({ where: { id } });
  done();
}

function parseList(v: FormDataEntryValue | null): string[] {
  const items = String(v ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase().replace(/ё/g, "е"))
    .filter((s) => s.length >= 2 && s.length <= 100);
  return [...new Set(items)];
}

export async function saveKeywords(_prev: FormState, formData: FormData): Promise<FormState> {
  const include = parseList(formData.get("include"));
  const exclude = parseList(formData.get("exclude"));
  if (include.length + exclude.length > 500) return { error: "Слишком много слов (максимум 500)" };

  await db.$transaction([
    db.keywordRule.deleteMany(),
    db.keywordRule.createMany({
      data: [...include.map((value) => ({ kind: "INCLUDE" as const, value })), ...exclude.map((value) => ({ kind: "EXCLUDE" as const, value }))],
    }),
  ]);
  done();
  return { ok: true };
}

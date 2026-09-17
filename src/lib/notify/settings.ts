import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

const schema = z.object({
  chatId: z.string().nullable().default(null),
  chatName: z.string().nullable().default(null),
  daily: z.boolean().default(true),
  hotLeads: z.boolean().default(true),
  hotThreshold: z.number().int().default(75),
});
export type NotificationSettings = z.infer<typeof schema>;

const KEY = "notifications";

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  const parsed = schema.safeParse(row?.value ?? {});
  const settings = parsed.success ? parsed.data : schema.parse({});
  // TELEGRAM_CHAT_ID из окружения важнее — удобно на VPS и в Vercel без захода в интерфейс.
  if (process.env.TELEGRAM_CHAT_ID?.trim()) settings.chatId = process.env.TELEGRAM_CHAT_ID.trim();
  return settings;
}

export async function saveNotificationSettings(patch: Partial<NotificationSettings>) {
  const current = await getNotificationSettings();
  const value = { ...current, ...patch } as unknown as Prisma.InputJsonObject;
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

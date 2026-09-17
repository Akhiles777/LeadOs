"use server";

import { revalidatePath } from "next/cache";
import { buildDailyMessage } from "@/lib/notify";
import { getNotificationSettings, saveNotificationSettings } from "@/lib/notify/settings";
import { botConfigured, findStartChat, sendTelegram } from "@/lib/notify/telegram-bot";

export type SettingsResult = { ok: string } | { error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function connectTelegramChat(): Promise<SettingsResult> {
  if (!botConfigured()) return { error: "Сначала задай TELEGRAM_BOT_TOKEN и перезапусти приложение" };
  try {
    const chat = await findStartChat();
    if (!chat) return { error: "Не нашёл сообщение /start. Открой своего бота в Telegram, нажми «Старт» и повтори." };
    await saveNotificationSettings({ chatId: chat.chatId, chatName: chat.name });
    await sendTelegram(chat.chatId, "✅ LeadOS подключён — сюда будут приходить утренняя сводка и горячие лиды.");
    revalidatePath("/settings");
    return { ok: `Подключено: ${chat.name}` };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function disconnectTelegramChat() {
  await saveNotificationSettings({ chatId: null, chatName: null });
  revalidatePath("/settings");
}

export async function updateNotificationToggles(patch: { daily?: boolean; hotLeads?: boolean; hotThreshold?: number }) {
  const clean: typeof patch = {};
  if (typeof patch.daily === "boolean") clean.daily = patch.daily;
  if (typeof patch.hotLeads === "boolean") clean.hotLeads = patch.hotLeads;
  if (typeof patch.hotThreshold === "number" && Number.isFinite(patch.hotThreshold)) clean.hotThreshold = Math.max(0, Math.min(100, Math.round(patch.hotThreshold)));
  await saveNotificationSettings(clean);
  revalidatePath("/settings");
}

/** Отправляет сводку «как утром» прямо сейчас, не отмечая её отправленной — утренняя всё равно придёт. */
export async function sendDailyPreview(): Promise<SettingsResult> {
  const settings = await getNotificationSettings();
  if (!botConfigured() || !settings.chatId) return { error: "Бот не подключён" };
  try {
    const text = await buildDailyMessage();
    await sendTelegram(settings.chatId, text ?? "LeadOS: сейчас срочных дел нет — утренняя сводка придёт, когда будет о чём сообщить.");
    return { ok: "Отправлено" };
  } catch (e) {
    return { error: message(e) };
  }
}

/**
 * Уведомления себе в Telegram через своего бота (Bot API). Бот пишет только в чат, который ты сам подключил.
 */
const API = "https://api.telegram.org";
const LIMIT = 4000; // у Telegram 4096, оставляем запас на разметку

export function botConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function appLink(path: string, text: string): string {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `<a href="${escapeHtml(base + path)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

/** Режет длинный текст по строкам, чтобы не порвать HTML-теги посередине. */
export function splitMessage(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > limit ? line.slice(0, limit - 1) + "…" : line;
    if (current && current.length + piece.length + 1 > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

type TgResponse<T> = { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };

async function call<T>(method: string, body: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetcher(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse<T>;
    if (json.ok) return json.result as T;
    const retry = json.parameters?.retry_after;
    if (res.status === 429 && retry && retry <= 30 && attempt === 1) {
      await new Promise((r) => setTimeout(r, retry * 1000));
      continue;
    }
    // Токен в тексте ошибки не показываем.
    throw new Error(`Telegram: ${json.description ?? `HTTP ${res.status}`}`);
  }
  throw new Error("Telegram: не удалось отправить");
}

export async function sendTelegram(chatId: string, html: string, fetcher?: typeof fetch) {
  for (const chunk of splitMessage(html)) {
    await call("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML", disable_web_page_preview: true }, fetcher);
  }
}

/** Ищет чат, из которого боту недавно написали /start. */
export async function findStartChat(fetcher?: typeof fetch): Promise<{ chatId: string; name: string } | null> {
  type Update = { message?: { text?: string; chat: { id: number; type: string; first_name?: string; username?: string } } };
  const updates = await call<Update[]>("getUpdates", { limit: 50, allowed_updates: ["message"] }, fetcher);
  const hit = [...updates].reverse().find((u) => u.message?.chat.type === "private" && u.message.text?.startsWith("/start"));
  if (!hit?.message) return null;
  const chat = hit.message.chat;
  return { chatId: String(chat.id), name: chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)) };
}

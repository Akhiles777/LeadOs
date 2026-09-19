import { AiApiError, AiNotConfiguredError, AiResponseError } from "@/ai/client";

/** Понятное сообщение об ошибке AI для интерфейса. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiNotConfiguredError || e instanceof AiResponseError) return e.message;
  if (e instanceof AiApiError && e.status === 401) return "Ключ RouterAI не подошёл — проверь ROUTERAI_API_KEY";
  if (e instanceof AiApiError && e.status === 429) return "Лимит запросов RouterAI — попробуй через минуту";
  if (e instanceof AiApiError) return `RouterAI API: ${e.status ?? "сеть"} ${e.message}`.slice(0, 300);
  if (e instanceof Error && e.message.startsWith("Сначала")) return e.message;
  console.error(e);
  return "Не получилось — подробности в логах сервера";
}

import Anthropic from "@anthropic-ai/sdk";
import { AiNotConfiguredError, AiResponseError } from "@/ai/client";

/** Понятное сообщение об ошибке AI для интерфейса. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiNotConfiguredError || e instanceof AiResponseError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "Ключ Claude API не подошёл — проверь ANTHROPIC_API_KEY";
  if (e instanceof Anthropic.RateLimitError) return "Лимит запросов к Claude API — попробуй через минуту";
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status ?? "сеть"} ${e.message}`.slice(0, 300);
  if (e instanceof Error && e.message.startsWith("Сначала")) return e.message;
  console.error(e);
  return "Не получилось — подробности в логах сервера";
}

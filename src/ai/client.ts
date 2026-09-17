import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { db } from "@/lib/db";

/**
 * Единственная точка вызова модели. Задачи (src/ai/tasks/*) передают сюда готовый контекст и Zod-схему ответа,
 * получают проверенный объект и сами решают, что записать в БД. У модели нет доступа к БД и инструментов.
 */

export const AI_MODEL = process.env.AI_MODEL?.trim() || "claude-opus-5";

// Цены Claude Opus 5, $ за 1M токенов. Если сработала резервная модель, оценка приблизительная.
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AiPurpose = "assess" | "offer" | "call_script" | "follow_up" | "digest" | "tuning";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI не настроен: задай ANTHROPIC_API_KEY (см. docs/INSTRUCTIONS.md)");
  }
}

export class AiResponseError extends Error {}

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

type MessagesApi = Pick<Anthropic["beta"]["messages"], "parse">;
let override: MessagesApi | null = null;
let client: Anthropic | null = null;

/** Для тестов: подменить вызов модели. */
export function setMessagesApiForTests(api: MessagesApi | null) {
  override = api;
}

function messagesApi(): MessagesApi {
  if (override) return override;
  if (!isAiConfigured()) throw new AiNotConfiguredError();
  client ??= new Anthropic({ maxRetries: 3, timeout: 5 * 60_000 });
  return client.beta.messages;
}

export type StructuredRequest<S extends z.ZodType> = {
  purpose: AiPurpose;
  leadId?: string | null;
  /** Стабильная часть: правила и кейсы. Кэшируется — не подставляй сюда даты и id. */
  system: string;
  /** Второй кэшируемый блок, специфичный для задачи (например, поправки к оценкам). Меняется реже, чем данные лида. */
  systemExtra?: string;
  /** Изменчивая часть: данные конкретного лида и задание. */
  prompt: string;
  schema: S;
  effort: Effort;
  maxTokens?: number;
};

export async function generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  const api = messagesApi(); // без ключа — ошибка до вызова, в журнал вызовов не пишем
  const started = Date.now();
  const log = {
    purpose: req.purpose,
    model: AI_MODEL,
    leadId: req.leadId ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };

  try {
    const response = await api.parse({
      model: AI_MODEL,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
      system: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
        ...(req.systemExtra ? [{ type: "text" as const, text: req.systemExtra, cache_control: { type: "ephemeral" as const } }] : []),
      ],
      messages: [{ role: "user", content: req.prompt }],
    });

    const u = response.usage;
    log.model = response.model;
    log.inputTokens = u.input_tokens;
    log.outputTokens = u.output_tokens;
    log.cacheReadTokens = u.cache_read_input_tokens ?? 0;
    log.cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
    log.costUsd =
      (log.inputTokens * PRICE.input + log.outputTokens * PRICE.output + log.cacheReadTokens * PRICE.cacheRead + log.cacheCreationTokens * PRICE.cacheWrite) /
      1_000_000;

    if (response.stop_reason === "refusal") {
      throw new AiResponseError(`Модель отказалась отвечать${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`);
    }
    if (response.stop_reason === "max_tokens") throw new AiResponseError("Ответ модели обрезан по длине");
    if (response.parsed_output == null) throw new AiResponseError("Модель вернула ответ не по схеме");

    await db.aiCall.create({ data: { ...log, ok: true, durationMs: Date.now() - started } });
    return response.parsed_output as z.infer<S>;
  } catch (e) {
    const message = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
    await db.aiCall.create({ data: { ...log, ok: false, error: message.slice(0, 2000), durationMs: Date.now() - started } }).catch(() => {});
    throw e;
  }
}

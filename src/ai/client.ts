import { toJSONSchema, type z } from "zod";
import { db } from "@/lib/db";

/**
 * Единственная точка вызова модели. Задачи (src/ai/tasks/*) передают сюда готовый контекст и Zod-схему ответа,
 * получают проверенный объект и сами решают, что записать в БД. У модели нет доступа к БД и инструментов.
 */

export const AI_PROVIDER_NAME = "RouterAI";
export const ROUTERAI_BASE_URL = (process.env.ROUTERAI_BASE_URL?.trim() || "https://routerai.ru/api/v1").replace(/\/+$/, "");
export const AI_MODEL = process.env.AI_MODEL?.trim() || "openai/gpt-4o";

// У RouterAI цены зависят от выбранной модели и провайдера. Если задать тарифы в env,
// журнал покажет приблизительную стоимость в рублях за 1M токенов.
function aiPrice() {
  return {
    input: Number(process.env.AI_PRICE_INPUT_RUB_PER_1M ?? 0),
    output: Number(process.env.AI_PRICE_OUTPUT_RUB_PER_1M ?? 0),
  };
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AiPurpose = "assess" | "offer" | "call_script" | "follow_up" | "digest" | "tuning";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI не настроен: задай ROUTERAI_API_KEY (см. docs/INSTRUCTIONS.md)");
  }
}

export class AiResponseError extends Error {}

export class AiApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.ROUTERAI_API_KEY?.trim());
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  verbosity?: Effort;
  response_format: {
    type: "json_schema";
    json_schema: { name: string; strict: boolean; schema: unknown };
  };
  provider?: {
    country?: string;
    order?: string[];
    only?: string[];
    ignore?: string[];
    allow_fallbacks?: boolean;
  };
};
type ChatCompletionResponse = {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};
type ChatCompletionsApi = { create(params: ChatCompletionRequest): Promise<ChatCompletionResponse> };
let override: ChatCompletionsApi | null = null;

/** Для тестов: подменить вызов модели. */
export function setMessagesApiForTests(api: ChatCompletionsApi | null) {
  override = api;
}

function providerRouting(): ChatCompletionRequest["provider"] | undefined {
  const country = process.env.ROUTERAI_PROVIDER_COUNTRY?.trim();
  const order = process.env.ROUTERAI_PROVIDER_ORDER?.split(",").map((s) => s.trim()).filter(Boolean);
  const only = process.env.ROUTERAI_PROVIDER_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const ignore = process.env.ROUTERAI_PROVIDER_IGNORE?.split(",").map((s) => s.trim()).filter(Boolean);
  const allowFallbacks = process.env.ROUTERAI_ALLOW_FALLBACKS?.trim();
  const provider = {
    ...(country && { country }),
    ...(order?.length && { order }),
    ...(only?.length && { only }),
    ...(ignore?.length && { ignore }),
    ...(allowFallbacks && { allow_fallbacks: allowFallbacks !== "false" }),
  };
  return Object.keys(provider).length ? provider : undefined;
}

function chatCompletionsApi(): ChatCompletionsApi {
  if (override) return override;
  if (!isAiConfigured()) throw new AiNotConfiguredError();
  return {
    create: async (params) => {
      const response = await fetch(`${ROUTERAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ROUTERAI_API_KEY!.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AiApiError(`RouterAI API ${response.status}: ${body || response.statusText}`, response.status);
      }
      return (await response.json()) as ChatCompletionResponse;
    },
  };
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

function schemaName(purpose: AiPurpose): string {
  return `leados_${purpose}`;
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1));
    throw new AiResponseError("Модель вернула не JSON");
  }
}

export async function generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  const api = chatCompletionsApi(); // без ключа — ошибка до вызова, в журнал вызовов не пишем
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
    const response = await api.create({
      model: AI_MODEL,
      max_tokens: req.maxTokens ?? 6000,
      temperature: 0.2,
      verbosity: req.effort,
      provider: providerRouting(),
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName(req.purpose), strict: true, schema: toJSONSchema(req.schema, { target: "draft-7" }) },
      },
      messages: [
        {
          role: "system",
          content: [
            req.system,
            req.systemExtra,
            "Верни только валидный JSON по заданной JSON Schema. Без Markdown, пояснений и текста вокруг JSON.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        { role: "user", content: req.prompt },
      ],
    });

    const u = response.usage;
    log.model = response.model ?? AI_MODEL;
    log.inputTokens = u?.prompt_tokens ?? u?.input_tokens ?? 0;
    log.outputTokens = u?.completion_tokens ?? u?.output_tokens ?? 0;
    log.cacheReadTokens = u?.cache_read_input_tokens ?? 0;
    log.cacheCreationTokens = u?.cache_creation_input_tokens ?? 0;
    const price = aiPrice();
    log.costUsd = (log.inputTokens * price.input + log.outputTokens * price.output) / 1_000_000;

    const choice = response.choices?.[0];
    if (!choice?.message?.content) throw new AiResponseError("Модель вернула пустой ответ");
    if (choice.finish_reason === "length") throw new AiResponseError("Ответ модели обрезан по длине");

    const parsed = req.schema.parse(parseJsonContent(choice.message.content));
    await db.aiCall.create({ data: { ...log, ok: true, durationMs: Date.now() - started } });
    return parsed as z.infer<S>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.aiCall.create({ data: { ...log, ok: false, error: message.slice(0, 2000), durationMs: Date.now() - started } }).catch(() => {});
    throw e;
  }
}

import { toJSONSchema, type z } from "zod";
import { db } from "@/lib/db";

/**
 * Единственная точка вызова модели. Задачи (src/ai/tasks/*) передают сюда готовый контекст и Zod-схему ответа,
 * получают проверенный объект и сами решают, что записать в БД. У модели нет доступа к БД и инструментов.
 */

export const AI_PROVIDER_NAME = "RouterAI";
export const ROUTERAI_BASE_URL = (process.env.ROUTERAI_BASE_URL?.trim() || "https://routerai.ru/api/v1").replace(/\/+$/, "");
// Модели выбраны по цене: DeepSeek V4 Flash ≈5/10 ₽ за 1M токенов (вход/выход) — для оценки, поиска контактов, дайджеста;
// V4 Pro ≈65/129 ₽ — для текстов клиентам (пишет заметно лучше, но всё равно в ~16 раз дешевле Claude Opus).
export const AI_MODEL = process.env.AI_MODEL?.trim() || "deepseek/deepseek-v4-flash";
export const AI_WRITER_MODEL = process.env.AI_WRITER_MODEL?.trim() || "deepseek/deepseek-v4-pro";
// Модель для веб-поиска контактов: нужна поддержка плагина web.
export const AI_SEARCH_MODEL = process.env.AI_SEARCH_MODEL?.trim() || AI_MODEL;

/** Задачи, где качество текста важнее цены: их пишет AI_WRITER_MODEL. */
const WRITER_PURPOSES = new Set<AiPurpose>(["offer", "pitch", "call_script", "follow_up"]);

export function modelFor(purpose: AiPurpose, webSearch = false): string {
  if (webSearch) return AI_SEARCH_MODEL;
  return WRITER_PURPOSES.has(purpose) ? AI_WRITER_MODEL : AI_MODEL;
}

/**
 * Недельный бюджет на AI в рублях. Сверх него вызовы не делаются вовсе. Не задан — 80 ₽ (чуть ниже типичного
 * лимита ключа RouterAI 100 ₽/нед.), «0» — без ограничения.
 */
export function weeklyBudgetRub(): number {
  const raw = process.env.AI_WEEKLY_BUDGET_RUB?.trim();
  return raw ? Math.max(0, Number(raw) || 0) : 80;
}

export class AiBudgetError extends Error {}

const PAUSE_KEY = "ai_paused_until";

/** Потрачено за 7 дней по журналу вызовов (₽, примерно). */
export async function weeklySpendRub(): Promise<number> {
  const agg = await db.aiCall.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _sum: { costUsd: true } });
  return agg._sum.costUsd ?? 0;
}

/** Почему AI сейчас нельзя вызывать: пауза после «лимит ключа исчерпан» или свой недельный бюджет. null — можно. */
export async function aiBlockedReason(): Promise<string | null> {
  const pause = await db.appSetting.findUnique({ where: { key: PAUSE_KEY } });
  const until = pause ? new Date(String(pause.value)) : null;
  if (until && until > new Date()) {
    return `AI на паузе до ${until.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}: RouterAI сообщил, что лимит расходов ключа исчерпан`;
  }
  const budget = weeklyBudgetRub();
  if (budget) {
    const spent = await weeklySpendRub();
    if (spent >= budget) return `Недельный бюджет на AI исчерпан: потрачено ≈${spent.toFixed(0)} ₽ из ${budget} ₽ (AI_WEEKLY_BUDGET_RUB)`;
  }
  return null;
}

/** RouterAI ответил «лимит расходов ключа превышен» — не долбим его: пауза на 12 часов. */
async function pauseAi(hours = 12) {
  const value = new Date(Date.now() + hours * 3_600_000).toISOString();
  await db.appSetting.upsert({ where: { key: PAUSE_KEY }, create: { key: PAUSE_KEY, value }, update: { value } }).catch(() => {});
}

export async function resumeAi() {
  await db.appSetting.deleteMany({ where: { key: PAUSE_KEY } });
}

type Price = { input: number; output: number }; // ₽ за 1 токен

let priceCache: { at: number; prices: Map<string, Price> } | null = null;

/**
 * Тарифы моделей: из env (₽ за 1M токенов), иначе из каталога RouterAI (/models, ₽ за токен), кэш на 12 часов.
 * Каталог недоступен — стоимость 0, вызов от этого не страдает.
 */
async function priceFor(model: string): Promise<Price> {
  const envIn = Number(process.env.AI_PRICE_INPUT_RUB_PER_1M ?? 0);
  const envOut = Number(process.env.AI_PRICE_OUTPUT_RUB_PER_1M ?? 0);
  if (envIn || envOut) return { input: envIn / 1_000_000, output: envOut / 1_000_000 };
  if (override) return { input: 0, output: 0 };
  if (!priceCache || Date.now() - priceCache.at > 12 * 3_600_000) {
    try {
      const res = await fetch(`${ROUTERAI_BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
      const data = (await res.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
      const prices = new Map<string, Price>();
      for (const m of data.data ?? []) prices.set(m.id, { input: Number(m.pricing?.prompt ?? 0), output: Number(m.pricing?.completion ?? 0) });
      priceCache = { at: Date.now(), prices };
    } catch {
      priceCache = { at: Date.now() - 11 * 3_600_000, prices: priceCache?.prices ?? new Map() }; // повторим через час
    }
  }
  return priceCache.prices.get(model) ?? priceCache.prices.get(model.replace(/:online$/, "")) ?? { input: 0, output: 0 };
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AiPurpose = "assess" | "offer" | "pitch" | "contacts" | "call_script" | "follow_up" | "digest" | "tuning";

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
  temperature?: number;
  reasoning?: { effort: "low" | "medium" | "high" };
  plugins?: { id: "web"; max_results?: number; engine?: "native" | "exa"; search_prompt?: string }[];
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
  choices?: {
    message?: {
      content?: string | null;
      annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[];
    };
    finish_reason?: string | null;
  }[];
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
        if ((response.status === 429 || response.status === 402) && /limit|лимит|баланс|balance|insufficient/i.test(body)) {
          await pauseAi();
          throw new AiBudgetError(`RouterAI: лимит расходов исчерпан — AI на паузе 12 часов. ${body.slice(0, 200)}`);
        }
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
  /** Веб-поиск через плагин RouterAI: модель видит свежие страницы, ответ приходит со ссылками-источниками. */
  webSearch?: { maxResults?: number; searchPrompt?: string };
};

export type WebCitation = { url: string; title?: string; content?: string };

const EFFORT_ORDER = ["low", "medium", "high"] as const;

/**
 * Уровень рассуждений (low/medium/high у RouterAI). Рассуждения оплачиваются как выходные токены, поэтому
 * потолок задаётся AI_REASONING_MAX (по умолчанию low): задача не может рассуждать дольше него.
 */
function reasoningEffort(effort: Effort): "low" | "medium" | "high" {
  const wanted = effort === "low" ? 0 : effort === "medium" ? 1 : 2;
  const capName = process.env.AI_REASONING_MAX?.trim() as (typeof EFFORT_ORDER)[number] | undefined;
  const cap = capName && EFFORT_ORDER.includes(capName) ? EFFORT_ORDER.indexOf(capName) : 0;
  return EFFORT_ORDER[Math.min(wanted, cap)];
}

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
  return (await generateStructuredWithSources(req)).data;
}

/** То же, что generateStructured, но вместе с источниками веб-поиска (если он включён). */
export async function generateStructuredWithSources<S extends z.ZodType>(
  req: StructuredRequest<S>,
): Promise<{ data: z.infer<S>; citations: WebCitation[] }> {
  const api = chatCompletionsApi(); // без ключа — ошибка до вызова, в журнал вызовов не пишем
  const blocked = await aiBlockedReason();
  if (blocked) throw new AiBudgetError(blocked);
  const started = Date.now();
  const model = modelFor(req.purpose, Boolean(req.webSearch));
  const log = {
    purpose: req.purpose,
    model,
    leadId: req.leadId ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };

  try {
    const response = await api.create({
      model,
      max_tokens: req.maxTokens ?? 8000,
      // Температуру не задаём: с включёнными рассуждениями Claude принимает только значение по умолчанию,
      // а низкая температура и давала однотипные «шаблонные» тексты.
      reasoning: { effort: reasoningEffort(req.effort) },
      ...(req.webSearch && {
        plugins: [{ id: "web" as const, engine: "exa" as const, max_results: req.webSearch.maxResults ?? 6, search_prompt: req.webSearch.searchPrompt }],
      }),
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
    log.model = response.model ?? model;
    log.inputTokens = u?.prompt_tokens ?? u?.input_tokens ?? 0;
    log.outputTokens = u?.completion_tokens ?? u?.output_tokens ?? 0;
    log.cacheReadTokens = u?.cache_read_input_tokens ?? 0;
    log.cacheCreationTokens = u?.cache_creation_input_tokens ?? 0;
    const price = await priceFor(model);
    log.costUsd = log.inputTokens * price.input + log.outputTokens * price.output; // в рублях, поле названо исторически

    const choice = response.choices?.[0];
    if (!choice?.message?.content) throw new AiResponseError("Модель вернула пустой ответ");
    if (choice.finish_reason === "length") throw new AiResponseError("Ответ модели обрезан по длине");

    const parsed = req.schema.parse(parseJsonContent(choice.message.content));
    await db.aiCall.create({ data: { ...log, ok: true, durationMs: Date.now() - started } });
    const citations = (choice.message.annotations ?? [])
      .map((a) => a.url_citation)
      .filter((c): c is WebCitation => Boolean(c?.url));
    return { data: parsed as z.infer<S>, citations };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.aiCall.create({ data: { ...log, ok: false, error: message.slice(0, 2000), durationMs: Date.now() - started } }).catch(() => {});
    throw e;
  }
}

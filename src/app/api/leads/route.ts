import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { checkApiToken } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { parseLeadInput } from "@/lib/lead-input";
import { createLeadDeduped } from "@/lib/lead-service";
import { isSource } from "@/lib/leads";
import { normalizeSourceRef } from "@/lib/source-ref";

// Приём пачки создаёт много лидов; после ответа на Vercel ещё выполняется AI-оценка.
export const maxDuration = 300;

/**
 * Точка входа для внешних захватчиков лидов: Kwork-расширение/bookmarklet, Telegram-воркер, импорт 2GIS.
 *
 *   POST /api/leads   { source, title, rawText?, sourceRef?, category?, budgetMin?, budgetMax?, contact*?, region? }
 *     201 { id, url, created: true }                     — новый лид
 *     200 { id, url, created: false, duplicate: true }   — такой sourceRef уже есть, ничего не изменено
 *   GET  /api/leads?source=KWORK&sourceRef=<url>
 *     200 { exists: false } | { exists: true, id, url, status }
 *
 * Авторизация: `Authorization: Bearer $API_TOKEN`.
 */

const MAX_BODY_BYTES = 100_000;

const CORS_HEADERS = {
  // Токен передаётся заголовком, cookie не используются — открытый CORS не даёт чужим сайтам доступа.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function leadUrl(request: NextRequest, id: string) {
  const base = process.env.APP_URL?.replace(/\/+$/, "") || request.nextUrl.origin;
  return `${base}/leads/${id}`;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  if (!checkApiToken(request)) return json({ error: "unauthorized" }, 401);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_json" }, 400);

  const input = { ...(body as Record<string, unknown>) };
  delete input.followUpAt; // дату касания ставишь сам, не захватчик
  const parsed = parseLeadInput(input);
  if ("error" in parsed) return json({ error: "validation", message: parsed.error, field: parsed.field }, 422);

  const result = await createLeadDeduped(parsed.data);
  if (result.created) {
    revalidatePath("/");
    revalidatePath("/leads");
    revalidatePath("/pipeline");
  }
  return json({ ...result, url: leadUrl(request, result.id) }, result.created ? 201 : 200);
}

export async function GET(request: NextRequest) {
  if (!checkApiToken(request)) return json({ error: "unauthorized" }, 401);

  const source = request.nextUrl.searchParams.get("source");
  const sourceRef = request.nextUrl.searchParams.get("sourceRef");
  if (!isSource(source) || !sourceRef) return json({ error: "validation", message: "Нужны source и sourceRef" }, 422);

  const lead = await db.lead.findFirst({
    where: { source, sourceRef: normalizeSourceRef(source, sourceRef) },
    select: { id: true, status: true },
  });
  return json(lead ? { exists: true, id: lead.id, status: lead.status, url: leadUrl(request, lead.id) } : { exists: false });
}

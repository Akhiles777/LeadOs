import { checkApiToken } from "@/lib/api-auth";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function apiError(e: unknown) {
  if (e instanceof ApiError) return Response.json({ error: e.code, message: e.message }, { status: e.status });
  console.error(e);
  return Response.json({ error: "internal" }, { status: 500 });
}

export function requireToken(request: Request) {
  if (!checkApiToken(request)) throw new ApiError(401, "unauthorized");
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new ApiError(413, "payload_too_large");
  const text = await request.text();
  if (text.length > maxBytes) throw new ApiError(413, "payload_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

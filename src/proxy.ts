import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/api-auth";

/**
 * Basic Auth на всё приложение: LeadOS однопользовательский и живёт на публичном VPS,
 * а server actions доступны прямым POST-запросом. Если BASIC_AUTH_USER/PASSWORD не заданы
 * (локальная разработка) — пропускаем.
 */
export function proxy(request: NextRequest) {
  // API авторизуется собственным Bearer-токеном (src/lib/api-auth.ts) — расширение не умеет Basic Auth.
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !password) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("BASIC_AUTH_USER / BASIC_AUTH_PASSWORD не заданы", { status: 500 });
    }
    return NextResponse.next();
  }

  // X-Real-IP ставит сама платформа (Vercel) или nginx; первый адрес X-Forwarded-For присылает клиент и может подделать,
  // поэтому из цепочки берём последний — его добавил ближайший прокси.
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
  if (isLockedOut(ip)) {
    return new NextResponse("Слишком много неверных попыток входа. Подожди 15 минут.", { status: 429, headers: { "Retry-After": "900" } });
  }

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    } catch {
      decoded = "";
    }
    const sep = decoded.indexOf(":");
    if (sep !== -1 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
      failures.delete(ip);
      return NextResponse.next();
    }
    recordFailure(ip);
  }

  return new NextResponse("Требуется авторизация", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="LeadOS", charset="UTF-8"' },
  });
}

/*
 * Защита от подбора пароля: после 10 неверных попыток с одного IP за 15 минут — пауза 15 минут.
 * Память процесса: на VPS работает полностью, на Vercel — в пределах одного экземпляра функции,
 * поэтому там главная защита — длинный пароль.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; first: number }>();

function recordFailure(ip: string) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.first > WINDOW_MS) failures.set(ip, { count: 1, first: now });
  else entry.count++;
  if (failures.size > 10_000) failures.clear();
}

function isLockedOut(ip: string) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

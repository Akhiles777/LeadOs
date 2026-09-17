/**
 * Адрес базы из окружения. Кроме DATABASE_URL понимает имена, которые создают интеграции Vercel
 * (Prisma Postgres, Neon, Supabase): POSTGRES_URL, PRISMA_DATABASE_URL и их варианты с префиксом проекта,
 * например leados_POSTGRES_URL. Иначе после подключения базы в панели приложение падало бы «без причины».
 */
const POOLED = ["DATABASE_URL", "POSTGRES_PRISMA_URL", "PRISMA_DATABASE_URL", "POSTGRES_URL", "DATABASE_POSTGRES_URL"];
const DIRECT = ["DIRECT_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NO_SSL"];

const usable = (value: string | undefined) => (value && /^postgres(ql)?:\/\//i.test(value.trim()) ? value.trim() : null);

function pick(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const name of names) {
    const direct = usable(env[name]);
    if (direct) return direct;
  }
  // Переменные с префиксом проекта: leados_POSTGRES_URL, myapp_PRISMA_DATABASE_URL…
  const suffixes = names.map((n) => `_${n}`);
  for (const key of Object.keys(env).sort()) {
    if (suffixes.some((s) => key.endsWith(s))) {
      const value = usable(env[key]);
      if (value) return value;
    }
  }
  return null;
}

/** Адрес для приложения (пулинговый, если он есть). */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return pick(POOLED, env);
}

/** Адрес для миграций: прямое подключение, если оно указано отдельно. */
export function resolveDirectUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return pick(DIRECT, env) ?? resolveDatabaseUrl(env);
}

/**
 * Проверка окружения при запуске сервера: в логах сразу видно, чего не хватает, а не через час в виде странной ошибки.
 * Подробный список с подсказками — на странице «Настройки».
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const prod = process.env.NODE_ENV === "production";
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL не задан — приложение не сможет работать с базой");
  if (prod && (!process.env.BASIC_AUTH_USER || !process.env.BASIC_AUTH_PASSWORD)) problems.push("BASIC_AUTH_USER/BASIC_AUTH_PASSWORD не заданы — интерфейс будет отвечать 500");
  if (prod && (process.env.BASIC_AUTH_PASSWORD?.length ?? 0) < 12) problems.push("BASIC_AUTH_PASSWORD короче 12 символов — легко подобрать");
  if (prod && !process.env.APP_URL) problems.push("APP_URL не задан — в уведомлениях не будет ссылок");
  if (process.env.VERCEL && !process.env.CRON_SECRET) problems.push("CRON_SECRET не задан — ежедневный cron Vercel не сможет запуститься");
  for (const p of problems) console.warn(`[LeadOS] ${p}`);
}

import { safeEqual } from "@/lib/api-auth";

/** Vercel Cron присылает Authorization: Bearer $CRON_SECRET. Без секрета маршруты закрыты. */
export function checkCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get("authorization") ?? "";
  return safeEqual(header, `Bearer ${secret}`);
}

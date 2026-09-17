import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { checkWebsite } from "@/lib/site-check";

/** Проверка сайта и запись результата — без обновления страниц, чтобы вызывать и из воркера, и из действий интерфейса. */
export async function checkLeadWebsite(leadId: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { website: true } });
  const result = await checkWebsite(lead.website);
  await db.lead.update({ where: { id: leadId }, data: { siteCheck: result as unknown as Prisma.InputJsonObject } });
  return result;
}

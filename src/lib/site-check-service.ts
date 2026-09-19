import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { allContacts, fieldsFromContacts, mergeContacts, readContacts } from "@/lib/contacts";
import { checkWebsite } from "@/lib/site-check";

/**
 * Проверка сайта и запись результата — без обновления страниц, чтобы вызывать и из воркера, и из действий интерфейса.
 * Найденные на сайте телефоны, мессенджеры и почта добавляются к контактам лида, ничего не затирая.
 */
export async function checkLeadWebsite(leadId: string) {
  const lead = await db.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { website: true, contacts: true, contactPhone: true, contactTg: true, contactEmail: true },
  });
  const result = await checkWebsite(lead.website);
  const contacts = mergeContacts(readContacts(lead.contacts), result.contacts ?? []);
  await db.lead.update({
    where: { id: leadId },
    data: {
      siteCheck: result as unknown as Prisma.InputJsonObject,
      contacts: contacts as unknown as Prisma.InputJsonArray,
      ...fieldsFromContacts(lead, allContacts({ ...lead, contacts })),
    },
  });
  return result;
}

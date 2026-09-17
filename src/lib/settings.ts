import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export const DEFAULT_NICHES = [
  "стоматология",
  "медицинский центр",
  "салон красоты",
  "барбершоп",
  "автосервис",
  "ветеринарная клиника",
  "фитнес-клуб",
  "юридические услуги",
  "продуктовый магазин",
  "магазин строительных материалов",
  "кафе",
  "детский центр",
];

const prospectingSchema = z.object({
  region: z.string().default(""),
  niches: z.array(z.string()).default(DEFAULT_NICHES),
});
export type ProspectingSettings = z.infer<typeof prospectingSchema>;

const KEY = "prospecting";

export async function getProspectingSettings(): Promise<ProspectingSettings> {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  const parsed = prospectingSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : prospectingSchema.parse({});
}

export async function saveProspectingSettings(value: ProspectingSettings) {
  const json = value as unknown as Prisma.InputJsonObject;
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } });
}

export function mapSearchLinks(query: string) {
  const q = encodeURIComponent(query.trim());
  return {
    yandex: `https://yandex.ru/maps/?text=${q}`,
    twoGis: `https://2gis.ru/search/${q}`,
  };
}

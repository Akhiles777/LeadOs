// Демо-данные для проверки воронки и дашборда: pnpm db:seed
// Удаляет ВСЕ лиды перед заполнением — не запускай на боевой базе.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type { LeadStatus, Source } from "../src/generated/prisma/enums";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day);
const STAGES: LeadStatus[] = ["NEW", "QUALIFIED", "CONTACTED", "RESPONDED", "NEGOTIATING", "WON"];

type Seed = [title: string, source: Source, status: LeadStatus, furthest: LeadStatus, createdDaysAgo: number, silentDays: number, amount?: number];

const leads: Seed[] = [
  ["CRM для стоматологической клиники", "COLD_LOCAL", "WON", "WON", 40, 3, 180_000],
  ["Интернет-магазин для гастронома", "REFERRAL", "WON", "WON", 60, 12, 240_000],
  ["Лендинг для юрфирмы", "KWORK", "WON", "WON", 25, 8, 35_000],
  ["Бот записи для барбершопа", "TELEGRAM", "NEGOTIATING", "NEGOTIATING", 14, 7],
  ["Учёт склада для HoReCa", "REFERRAL", "NEGOTIATING", "NEGOTIATING", 20, 2],
  ["Парсер цен конкурентов", "KWORK", "CONTACTED", "CONTACTED", 9, 8],
  ["Сайт-визитка автосервиса", "COLD_LOCAL", "CONTACTED", "CONTACTED", 6, 1],
  ["Доработка Next.js магазина", "TELEGRAM", "RESPONDED", "RESPONDED", 5, 2],
  ["ML-рекомендации для банка", "KWORK", "SKIPPED", "QUALIFIED", 12, 11],
  ["Агрегатор на 100М SKU", "TELEGRAM", "SKIPPED", "NEW", 10, 10],
  ["Мобильное приложение за 5000 ₽", "KWORK", "LOST", "CONTACTED", 30, 20],
  ["CRM для фитнес-клуба", "COLD_LOCAL", "LOST", "RESPONDED", 35, 15],
  ["Telegram Mini App для кофейни", "TELEGRAM", "QUALIFIED", "QUALIFIED", 3, 1],
  ["Сайт для ветклиники", "COLD_LOCAL", "NEW", "NEW", 1, 1],
  ["Интеграция 1С и сайта", "KWORK", "NEW", "NEW", 0, 0],
];

async function main() {
  const existing = await db.lead.count();
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) throw new Error("Демо-данные нельзя заливать в production");
  if (existing > 0 && !process.argv.includes("--force")) {
    throw new Error(`В базе уже ${existing} лидов. Сид удаляет ВСЕ лиды — если это точно нужно: pnpm db:seed -- --force`);
  }
  await db.lead.deleteMany();
  for (const [title, source, status, furthest, created, silent, amount] of leads) {
    await db.lead.create({
      data: {
        title,
        source,
        status,
        furthestStage: STAGES.indexOf(furthest),
        rawText: `Демо: ${title}`,
        budgetMin: amount ? Math.round(amount * 0.8) : 30_000,
        budgetMax: amount ?? 80_000,
        createdAt: ago(created),
        lastActivityAt: ago(silent),
        activities: { create: { type: "NOTE", note: "Демо-лид из seed", createdAt: ago(created) } },
        ...(status === "WON" && { deal: { create: { amount, stage: "Сдан", startedAt: ago(created - 5), closedAt: ago(silent) } } }),
      },
    });
  }
  console.log(`Создано лидов: ${leads.length}`);
}

main().finally(() => db.$disconnect());

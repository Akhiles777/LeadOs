import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  // На Vercel каждый экземпляр функции держит свой пул — маленький пул и пулинговый URL базы (Neon/Supabase),
  // иначе быстро кончаются подключения. На VPS один процесс — можно больше.
  const max = Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 3 : 10);
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createClient();

// В dev переиспользуем клиент между перезагрузками модулей; в production модуль грузится один раз.
globalForPrisma.prisma = db;

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { createLeadDeduped } from "@/lib/lead-service";
import { formatDate, MAX_RAW_TEXT } from "@/lib/leads";
import { contentHash, decide, extractBudget, extractContact, type KeywordRules, postLink, postTitle } from "@/lib/telegram";

export const TELEGRAM_WORKER = "telegram";
const REPOST_WINDOW_DAYS = 30;

export async function getKeywordRules(): Promise<KeywordRules> {
  const rules = await db.keywordRule.findMany({ orderBy: { value: "asc" } });
  return {
    include: rules.filter((r) => r.kind === "INCLUDE").map((r) => r.value),
    exclude: rules.filter((r) => r.kind === "EXCLUDE").map((r) => r.value),
  };
}

/** Обновляет пульс воркера, сливая новые поля info с сохранёнными (например, список диалогов). */
export async function touchWorker(info: Record<string, unknown> = {}) {
  const current = await db.workerHeartbeat.findUnique({ where: { name: TELEGRAM_WORKER } });
  const merged = { ...((current?.info as Record<string, unknown> | null) ?? {}), ...info };
  await db.workerHeartbeat.upsert({
    where: { name: TELEGRAM_WORKER },
    create: { name: TELEGRAM_WORKER, info: merged as Prisma.InputJsonObject },
    update: { seenAt: new Date(), info: merged as Prisma.InputJsonObject },
  });
}

export const dialogSchema = z.object({
  peerId: z.string().regex(/^-?\d+$/),
  title: z.string().max(300),
  username: z.string().max(64).nullable().optional(),
});
export type TelegramDialog = z.infer<typeof dialogSchema>;

export const ingestSchema = z.object({
  resolved: z
    .object({ peerId: z.string().regex(/^-?\d+$/), title: z.string().max(300), username: z.string().max(64).nullable().optional() })
    .optional(),
  error: z.string().max(1000).optional(),
  posts: z
    .array(
      z.object({
        id: z.number().int().positive(),
        date: z.string().datetime({ offset: true }).optional(),
        text: z.string(),
        // Автор сообщения — есть в группах-чатах; в каналах пишет сам канал.
        author: z
          .object({ username: z.string().max(64).nullable().optional(), name: z.string().max(200).nullable().optional() })
          .optional(),
      }),
    )
    .max(500)
    .default([]),
});
export type IngestPayload = z.infer<typeof ingestSchema>;

export type IngestResult = {
  created: number;
  duplicates: number;
  filtered: { too_short: number; excluded: number; no_keywords: number };
  lastMessageId: number;
};

export async function ingestPosts(channelId: string, payload: IngestPayload): Promise<IngestResult> {
  let channel = await db.telegramChannel.findUnique({ where: { id: channelId } });
  if (!channel) throw new ApiError(404, "channel_not_found");

  if (payload.resolved) {
    const { peerId, title, username } = payload.resolved;
    try {
      channel = await db.telegramChannel.update({
        where: { id: channelId },
        data: { peerId, title, ...(username ? { username: username.toLowerCase() } : {}) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        await db.telegramChannel.update({
          where: { id: channelId },
          data: { enabled: false, lastError: "Этот канал уже добавлен другой записью — эта отключена", lastCheckedAt: new Date() },
        });
        throw new ApiError(409, "duplicate_channel");
      }
      throw e;
    }
  }

  const result: IngestResult = {
    created: 0,
    duplicates: 0,
    filtered: { too_short: 0, excluded: 0, no_keywords: 0 },
    lastMessageId: channel.lastMessageId,
  };

  if (payload.error) {
    await db.telegramChannel.update({ where: { id: channelId }, data: { lastError: payload.error, lastCheckedAt: new Date() } });
    return result;
  }

  const rules = await getKeywordRules();
  // Повторная отправка той же пачки (воркер упал между запросами) не создаёт дублей и не портит счётчики.
  const posts = payload.posts.filter((p) => p.id > channel.lastMessageId).sort((a, b) => a.id - b.id);
  const repostSince = new Date(Date.now() - REPOST_WINDOW_DAYS * 86_400_000);

  for (const post of posts) {
    result.lastMessageId = Math.max(result.lastMessageId, post.id);
    const decision = decide(post.text, rules, channel.filterMode);
    if (!decision.pass) {
      result.filtered[decision.reason]++;
      continue;
    }

    const hash = contentHash(post.text);
    const repost = await db.lead.findFirst({
      where: { contentHash: hash, source: "TELEGRAM", createdAt: { gte: repostSince } },
      select: { id: true },
    });
    if (repost) {
      result.duplicates++;
      continue;
    }

    const budget = extractBudget(post.text);
    const footer = [
      `Канал: ${channel.title ?? "—"}${channel.username ? ` (@${channel.username})` : ""}`,
      post.date ? `Опубликовано: ${formatDate(new Date(post.date), true)}` : "",
      decision.matched.length ? `Совпало: ${decision.matched.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const body = post.text.trim().slice(0, MAX_RAW_TEXT - footer.length - 10);

    const created = await createLeadDeduped(
      {
        source: "TELEGRAM",
        sourceRef: postLink(post, channel),
        title: postTitle(post.text),
        rawText: `${body}\n\n—\n${footer}`,
        category: null,
        budgetMin: budget.min,
        budgetMax: budget.max,
        contactName: post.author?.name?.trim() || null,
        contactPhone: null,
        contactTg: post.author?.username ? `@${post.author.username}` : extractContact(post.text, channel.username),
        contactEmail: null,
        website: null,
        referredById: null,
        region: null,
        followUpAt: null,
      },
      { contentHash: hash },
    );
    if (created.created) result.created++;
    else result.duplicates++;
  }

  await db.telegramChannel.update({
    where: { id: channelId },
    data: {
      lastMessageId: result.lastMessageId,
      postsSeen: { increment: posts.length },
      leadsCreated: { increment: result.created },
      lastCheckedAt: new Date(),
      lastError: null,
    },
  });

  if (result.created) {
    revalidatePath("/");
    revalidatePath("/leads");
    revalidatePath("/pipeline");
  }
  revalidatePath("/telegram");
  return result;
}

import { apiError, requireToken } from "@/lib/api";
import { db } from "@/lib/db";
import { touchWorker } from "@/lib/telegram-ingest";

/**
 * GET /api/telegram/channels?version=… — воркер забирает список включённых каналов в начале каждого цикла.
 * Заодно это его пульс: время последнего запроса видно на странице /telegram.
 */
export async function GET(request: Request) {
  try {
    requireToken(request);
    const version = new URL(request.url).searchParams.get("version");
    await touchWorker(version ? { version } : {});

    const channels = await db.telegramChannel.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, peerId: true, lastMessageId: true },
    });
    return Response.json({ channels });
  } catch (e) {
    return apiError(e);
  }
}

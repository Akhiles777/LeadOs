import { revalidatePath } from "next/cache";
import { apiError, ApiError, readJson, requireToken } from "@/lib/api";
import { ingestPosts, ingestSchema } from "@/lib/telegram-ingest";

// Приём пачки создаёт много лидов; после ответа на Vercel ещё выполняется AI-оценка.
export const maxDuration = 300;

/**
 * POST /api/telegram/channels/:id/ingest — пачка новых постов канала (или ошибка чтения).
 * LeadOS сам фильтрует, дедуплицирует, создаёт лиды и сдвигает lastMessageId.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/telegram/channels/[id]/ingest">) {
  try {
    requireToken(request);
    const { id } = await ctx.params;
    const parsed = ingestSchema.safeParse(await readJson(request, 5_000_000));
    if (!parsed.success) throw new ApiError(422, "validation", parsed.error.issues[0]?.message);

    const result = await ingestPosts(id, parsed.data);
    return Response.json(result);
  } catch (e) {
    if (e instanceof ApiError && e.code === "duplicate_channel") revalidatePath("/telegram");
    return apiError(e);
  }
}

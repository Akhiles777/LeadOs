import { revalidatePath } from "next/cache";
import { z } from "zod";
import { apiError, ApiError, readJson, requireToken } from "@/lib/api";
import { dialogSchema, touchWorker } from "@/lib/telegram-ingest";

/** POST /api/telegram/dialogs — каналы, в которых состоит аккаунт; нужны для выбора на странице /telegram. */
export async function POST(request: Request) {
  try {
    requireToken(request);
    const parsed = z.object({ dialogs: z.array(dialogSchema).max(2000) }).safeParse(await readJson(request, 1_000_000));
    if (!parsed.success) throw new ApiError(422, "validation", parsed.error.issues[0]?.message);

    await touchWorker({ dialogs: parsed.data.dialogs, dialogsAt: new Date().toISOString() });
    revalidatePath("/telegram");
    return Response.json({ ok: true, count: parsed.data.dialogs.length });
  } catch (e) {
    return apiError(e);
  }
}

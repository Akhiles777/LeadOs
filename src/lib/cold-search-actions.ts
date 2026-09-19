"use server";

import { revalidatePath } from "next/cache";
import { drainQueueAfterResponse } from "@/ai/inline";
import { MAX_PER_SEARCH, searchNiche, type SearchResult } from "@/lib/cold-search";
import { getProspectingSettings } from "@/lib/settings";

export type SearchState = { result?: SearchResult; error?: string };

/** Автоматический поиск компаний ниши в городе из настроек. */
/** offers — скольким первым компаниям AI сразу пишет тексты (≈1 ₽ за компанию на DeepSeek V4 Pro). */
export async function runNicheSearch(niche: string, radiusKm: number, limit: number, offers = 0): Promise<SearchState> {
  try {
    const settings = await getProspectingSettings();
    const result = await searchNiche({
      niche,
      city: settings.region,
      radiusKm: Math.min(Math.max(Math.round(radiusKm) || 10, 1), 50),
      limit: Math.min(Math.max(Math.round(limit) || 20, 1), MAX_PER_SEARCH),
      withOffers: Math.min(Math.max(Math.round(offers) || 0, 0), MAX_PER_SEARCH),
    });
    revalidatePath("/prospecting");
    revalidatePath("/leads");
    revalidatePath("/");
    drainQueueAfterResponse();
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Поиск не удался" };
  }
}

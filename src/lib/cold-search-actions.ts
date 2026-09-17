"use server";

import { revalidatePath } from "next/cache";
import { drainQueueAfterResponse } from "@/ai/inline";
import { MAX_PER_SEARCH, searchNiche, type SearchResult } from "@/lib/cold-search";
import { getProspectingSettings } from "@/lib/settings";

export type SearchState = { result?: SearchResult; error?: string };

/** Автоматический поиск компаний ниши в городе из настроек. */
export async function runNicheSearch(niche: string, radiusKm: number, limit: number): Promise<SearchState> {
  try {
    const settings = await getProspectingSettings();
    const result = await searchNiche({
      niche,
      city: settings.region,
      radiusKm: Math.min(Math.max(Math.round(radiusKm) || 10, 1), 50),
      limit: Math.min(Math.max(Math.round(limit) || 20, 1), MAX_PER_SEARCH),
      withOffers: 10,
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

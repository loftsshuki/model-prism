import { NextRequest, NextResponse } from "next/server";
import { fetchModelCatalog, SNAPSHOT_MODELS, SNAPSHOT_CHECKED_AT, configuredModelIds } from "@/lib/model-catalog";
import type { ModelInfo } from "@/lib/types";

let cache: { models: ModelInfo[]; checkedAt: string; time: number } | null = null;
let refreshing: Promise<ModelInfo[]> | null = null;
export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const fresh = cache && Date.now() - cache.time < (refresh ? 10000 : 3600000);
  let warning: string | undefined;
  if (!fresh) {
    try {
      refreshing ??= fetchModelCatalog();
      const models = await refreshing;
      cache = { models, checkedAt: models[0]?.verifiedAt ?? new Date().toISOString(), time: Date.now() };
    } catch {
      warning = "Could not refresh model availability. Check the catalog before starting a new run.";
    } finally { refreshing = null; }
  }
  const models = cache?.models ?? SNAPSHOT_MODELS;
  const priority = configuredModelIds();
  const sorted = [...models].sort((a, b) => {
    const ai = priority.indexOf(a.id), bi = priority.indexOf(b.id);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name);
  });
  return NextResponse.json({ models: sorted, total: sorted.length, checkedAt: cache?.checkedAt ?? SNAPSHOT_CHECKED_AT,
    source: cache ? "live" : "snapshot", stale: !!warning || !cache, warning,
    missingConfigured: priority.filter((id) => !models.some((m) => m.id === id)),
  });
}

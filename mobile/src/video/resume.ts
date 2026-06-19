import { getJson, withAccountScope } from "@/lib/api";
import type { ContinueWatchingItem } from "@/lib/streamarena";

// Read the saved resume position for a source identity from continue-watching. Returns
// 0 when signed out, on miss, or on any error — the player just starts from the top.
// Only positions past a small floor count, so a stray 1-2s write never yanks playback.
export async function loadResumeSeconds(
  identity: string,
  scope: string | null,
  signal?: AbortSignal,
): Promise<number> {
  if (!scope) return 0;
  try {
    const data = await getJson<{ entries: ContinueWatchingItem[] }>(
      withAccountScope("/api/user/continue-watching", scope),
      // Short timeout: a stuck continue-watching read must give up (start from the top)
      // rather than fire a stale resume seek up to the default 45s later.
      { signal, timeoutMs: 8000 },
    );
    const entry = (data.entries ?? []).find((e) => e.sourceIdentity === identity);
    const seconds = Number(entry?.resumeSeconds);
    return Number.isFinite(seconds) && seconds > 5 ? seconds : 0;
  } catch {
    return 0;
  }
}

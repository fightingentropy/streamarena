import type { SourceSummary } from "@/lib/streamarena";

export type SourceTab = "hls" | "torrents";

type SourceKind = Pick<SourceSummary, "sourceHash" | "isTorrent">;

export function sourceTabForActiveSource(
  sources: readonly SourceKind[] | null | undefined,
  activeSourceHash?: string,
): SourceTab {
  const normalizedActiveHash = activeSourceHash?.trim().toLowerCase();
  const activeSource = (sources ?? []).find(
    (source) =>
      source.sourceHash.trim().toLowerCase() === normalizedActiveHash,
  );

  return activeSource?.isTorrent ? "torrents" : "hls";
}

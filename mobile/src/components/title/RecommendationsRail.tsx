import { useMemo } from "react";
import { useAccountScope } from "@/lib/auth";
import { normalizeSearchTitle, useRecommendations, type MediaType } from "@/lib/streamarena";
import { PosterRail, PosterRailSkeleton } from "@/components/title/PosterRail";
import { EmptyState } from "@/components/ui/States";

export function RecommendationsRail({ id, mediaType }: { id: string; mediaType: MediaType }) {
  const scope = useAccountScope();
  const { data, error, loading, refetch } = useRecommendations(id, mediaType, scope);
  const items = useMemo(() => data.results.map(normalizeSearchTitle), [data.results]);
  if (loading && !items.length) return <PosterRailSkeleton />;
  if (error && !items.length) return <EmptyState title="Related titles couldn’t load" actionLabel="Retry recommendations" onAction={refetch} />;
  return <PosterRail title="More Like This" items={items} imageBase={data.imageBase} />;
}

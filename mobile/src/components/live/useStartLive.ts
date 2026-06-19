import { useCallback } from "react";
import { useRouter } from "expo-router";
import { liveWatchHref } from "@/lib/nav";
import { type LivePlayRequest, stageLivePlayRequest } from "@/video/live";

// Stage a live request and open the player in live mode. The request travels via the
// module handoff (not URL params); only title/subtitle ride the route for display.
export function useStartLive() {
  const router = useRouter();
  return useCallback(
    (req: LivePlayRequest) => {
      stageLivePlayRequest(req);
      const params: Record<string, string> = { title: req.title };
      if (req.subtitle) params.subtitle = req.subtitle;
      router.push(liveWatchHref(req.id, params));
    },
    [router],
  );
}

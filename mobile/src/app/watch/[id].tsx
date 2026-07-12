import { type ComponentProps, type RefObject, useEffect, useMemo, useRef } from "react";
import { StatusBar, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import Video, {
  type OnBufferData,
  type OnLoadData,
  type OnProgressData,
  type OnVideoErrorData,
  SelectedTrackType,
  type VideoRef,
} from "react-native-video";
import { VlcVideo, type VlcVideoRef } from "@/video/VlcVideo";
import { PlayerGestureLayer } from "@/components/player/PlayerGestureLayer";
import { VideoControls } from "@/components/player/VideoControls";
import { useAccountScopeOrNull } from "@/lib/auth";
import { watchHref } from "@/lib/nav";
import type { MediaType } from "@/lib/streamarena";
import { takeLivePlayRequest } from "@/video/live";
import { computeNextEpisode, watchParamsFor } from "@/video/next-episode";
import { clearSeek, registerSeek, usePlayerStore } from "@/video/state";
import { buildTextTracks } from "@/video/tracks";
import type { PlayRequest } from "@/video/types";

// Best-effort orientation control; never let a missing/!linked module crash the screen.
async function allowLandscape() {
  try {
    await ScreenOrientation.unlockAsync();
  } catch {}
}
async function lockPortrait() {
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch {}
}

export default function WatchScreen() {
  const params = useLocalSearchParams<{
    id: string;
    mediaType?: string;
    title?: string;
    year?: string;
    seasonNumber?: string;
    episodeNumber?: string;
    poster?: string;
    episodeCount?: string;
    seasonCount?: string;
    live?: string;
    subtitle?: string;
    sourceHash?: string;
  }>();
  const router = useRouter();
  const scope = useAccountScopeOrNull();
  const videoRef = useRef<VideoRef | VlcVideoRef | null>(null);
  const isLive = params.live === "1";

  const request = useMemo<PlayRequest>(() => {
    const mediaType: MediaType = params.mediaType === "tv" ? "tv" : "movie";
    return {
      tmdbId: String(params.id ?? ""),
      mediaType,
      title: params.title,
      year: params.year,
      seasonNumber: params.seasonNumber ? Number(params.seasonNumber) : undefined,
      episodeNumber: params.episodeNumber ? Number(params.episodeNumber) : undefined,
      poster: params.poster,
    };
    // Re-open only when the underlying target changes.
  }, [params.id, params.mediaType, params.seasonNumber, params.episodeNumber, params.title, params.year, params.poster]);

  const source = usePlayerStore((s) => s.source);
  const paused = usePlayerStore((s) => s.paused);
  const volume = usePlayerStore((s) => s.volume);
  const status = usePlayerStore((s) => s.status);
  const resolved = usePlayerStore((s) => s.resolved);
  const selectedSubtitle = usePlayerStore((s) => s.selectedSubtitle);
  const textTracks = useMemo(() => buildTextTracks(resolved), [resolved]);

  // Next-episode target (TV only). Carry season/episode counts so the rolled-into
  // screen can compute its own "next" — episodeCount only when we stay in the season.
  const nextRequest = useMemo(
    () =>
      computeNextEpisode(
        request,
        params.episodeCount ? Number(params.episodeCount) : undefined,
        params.seasonCount ? Number(params.seasonCount) : undefined,
      ),
    [request, params.episodeCount, params.seasonCount],
  );
  const goNext = useMemo(() => {
    if (!nextRequest) return undefined;
    return () => {
      const next = watchParamsFor(nextRequest);
      if (params.seasonCount) next.seasonCount = String(params.seasonCount);
      if (params.episodeCount && nextRequest.seasonNumber === request.seasonNumber) {
        next.episodeCount = String(params.episodeCount);
      }
      router.replace(watchHref(request.tmdbId, next));
    };
  }, [nextRequest, params.seasonCount, params.episodeCount, request.seasonNumber, request.tmdbId, router]);

  // Autoplay the next episode when one finishes — once per finish (the effect can
  // re-run while status stays "ended" if goNext's identity changes).
  const advanced = useRef(false);
  useEffect(() => {
    advanced.current = false;
  }, [request]);
  useEffect(() => {
    if (status === "ended" && goNext && !advanced.current) {
      advanced.current = true;
      goNext();
    }
  }, [status, goNext]);
  // rn-video types `language` as a strict ISO639_1 union; our codes are runtime strings,
  // so cast the mapped array to the prop's own type.
  const videoTextTracks = useMemo(
    () =>
      textTracks.map((t) => ({ title: t.title, language: t.language, type: t.type, uri: t.uri })) as ComponentProps<
        typeof Video
      >["textTracks"],
    [textTracks],
  );

  useEffect(() => {
    const seekFn = (seconds: number) =>
      (videoRef.current as { seek: (s: number) => void } | null)?.seek(seconds);
    registerSeek(seekFn);
    void allowLandscape();
    if (isLive) {
      const liveReq = takeLivePlayRequest();
      if (liveReq) void usePlayerStore.getState().openLive(liveReq);
      else usePlayerStore.setState({ status: "error", error: "This live channel is unavailable." });
    } else {
      void usePlayerStore.getState().open(request, scope, { sourceHash: params.sourceHash });
    }
    return () => {
      clearSeek(seekFn);
      usePlayerStore.getState().close();
      void lockPortrait();
    };
  }, [request, scope, isLive, params.sourceHash]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const subtitle = isLive
    ? params.subtitle
    : request.mediaType === "tv" && request.seasonNumber != null && request.episodeNumber != null
      ? `S${request.seasonNumber} · E${request.episodeNumber}`
      : request.year || undefined;

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <StatusBar hidden />
      <PlayerGestureLayer>
        {source ? (
          source.engine === "vlc" ? (
            <VlcVideo
              ref={videoRef as RefObject<VlcVideoRef>}
              uri={source.uri}
              paused={paused}
              volume={volume}
              onLoad={(dur) => usePlayerStore.getState().onLoad(dur)}
              onProgress={(cur, dur) => usePlayerStore.getState().setProgress(cur, dur)}
              onBuffer={(b) => usePlayerStore.getState().onBuffer(b)}
              onEnd={(info) => usePlayerStore.getState().onEnd(info)}
              onError={(msg) => usePlayerStore.getState().onError(msg)}
            />
          ) : (
            <Video
              ref={videoRef as RefObject<VideoRef>}
              source={{ uri: source.uri }}
              style={StyleSheet.absoluteFill}
              paused={paused}
              volume={volume}
              resizeMode="contain"
              progressUpdateInterval={1000}
              ignoreSilentSwitch="ignore"
              textTracks={videoTextTracks}
              selectedTextTrack={
                selectedSubtitle == null
                  ? { type: SelectedTrackType.DISABLED }
                  : { type: SelectedTrackType.INDEX, value: selectedSubtitle }
              }
              onLoad={(d: OnLoadData) => usePlayerStore.getState().onLoad(d.duration)}
              onProgress={(p: OnProgressData) =>
                usePlayerStore.getState().setProgress(p.currentTime, p.seekableDuration || p.playableDuration || 0)
              }
              onBuffer={(b: OnBufferData) => usePlayerStore.getState().onBuffer(b.isBuffering)}
              onEnd={() => usePlayerStore.getState().onEnd()}
              onError={(e: OnVideoErrorData) =>
                usePlayerStore.getState().onError(e?.error?.errorString || "This source couldn't be played.")
              }
            />
          )
        ) : null}
        <VideoControls
          title={request.title}
          subtitle={subtitle}
          live={isLive}
          textTracks={textTracks}
          onNext={isLive ? undefined : goNext}
          onClose={close}
        />
      </PlayerGestureLayer>
    </View>
  );
}

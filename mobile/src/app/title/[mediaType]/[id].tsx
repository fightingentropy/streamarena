import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { GlassHeader } from "@/components/nav/GlassHeader";
import { PosterImage } from "@/components/PosterImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Scrim } from "@/components/ui/Scrim";
import { Skeleton } from "@/components/ui/Skeleton";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmptyState } from "@/components/ui/States";
import { ActionRow } from "@/components/title/ActionRow";
import { CastRail } from "@/components/title/CastRail";
import { DownloadButton } from "@/components/title/DownloadButton";
import { GenreChips } from "@/components/title/GenreChips";
import { MetaRow } from "@/components/title/MetaRow";
import { MyListButton } from "@/components/title/MyListButton";
import { SeasonPicker } from "@/components/title/SeasonPicker";
import { EpisodeRow } from "@/components/title/EpisodeRow";
import { formatYear } from "@/lib/format";
import { watchHref } from "@/lib/nav";
import { type Episode, type MediaType, tmdbImage, useSeason, useTitleDetails } from "@/lib/streamarena";
import { resolveOfflineMeta } from "@/video/download";
import { progressIdentity } from "@/video/identity";
import type { PlayRequest } from "@/video/types";
import { buildMyListItem } from "@/store/mylist";
import { colors } from "@/theme";

const HERO_HEIGHT = 440;

function BackButton() {
  const router = useRouter();
  return (
    <PressableScale
      onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      accessibilityLabel="Back"
      hitSlop={8}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: "rgba(0,0,0,0.45)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ChevronLeft size={24} color="#fff" />
    </PressableScale>
  );
}

export default function TitleDetailScreen() {
  const params = useLocalSearchParams<{ mediaType: string; id: string }>();
  const id = String(params.id ?? "");
  const mediaType: MediaType = params.mediaType === "tv" ? "tv" : "movie";
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { data: details, loading, error } = useTitleDetails(id, mediaType);

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // TV: track the selected season; default to the first real season once loaded.
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const realSeasons = useMemo(
    () => (details?.seasons ?? []).filter((s) => typeof s.season_number === "number" && s.season_number > 0),
    [details],
  );
  useEffect(() => {
    if (mediaType === "tv" && seasonNumber == null && realSeasons.length) {
      setSeasonNumber(realSeasons[0].season_number);
    }
  }, [mediaType, seasonNumber, realSeasons]);

  const { data: season, loading: seasonLoading, error: seasonError } = useSeason(
    id,
    seasonNumber ?? 1,
    mediaType === "tv" && seasonNumber != null,
  );

  const title = details?.title || details?.name || "";
  const year = formatYear(details?.release_date) || formatYear(details?.first_air_date);
  const backdrop =
    tmdbImage(details?.backdrop_path, "w1280") || tmdbImage(details?.poster_path, "w780");
  const runtimeMinutes = mediaType === "tv" ? details?.episode_run_time?.[0] : details?.runtime;
  const genres = (details?.genres ?? []).map((g) => g.name);

  const myItem = useMemo(
    () => buildMyListItem({ tmdbId: id, mediaType, title, year, posterPath: details?.poster_path }),
    [id, mediaType, title, year, details?.poster_path],
  );

  function play(seasonNo?: number, episodeNo?: number) {
    const extra: Record<string, string> = { mediaType, title, year };
    const poster = tmdbImage(details?.poster_path, "w342");
    if (poster) extra.poster = poster;
    if (seasonNo != null) extra.seasonNumber = String(seasonNo);
    if (episodeNo != null) extra.episodeNumber = String(episodeNo);
    // Bounds for next-episode autoplay: this season's episode count + total seasons.
    if (mediaType === "tv") {
      if (season?.episodes?.length) extra.episodeCount = String(season.episodes.length);
      if (details?.number_of_seasons) extra.seasonCount = String(details.number_of_seasons);
    }
    router.push(watchHref(id, extra));
  }

  // Download metadata builders. Poster/backdrop are absolute TMDB URLs fetched as sidecars.
  const dlPosterUrl = tmdbImage(details?.poster_path, "w342") ?? undefined;
  const dlBackdropUrl = tmdbImage(details?.backdrop_path, "w780") ?? undefined;
  const movieReq = useMemo<PlayRequest>(() => ({ tmdbId: id, mediaType, title, year }), [id, mediaType, title, year]);
  const getMovieMeta = useCallback(
    () =>
      resolveOfflineMeta(movieReq, {
        title,
        year,
        posterUrl: dlPosterUrl,
        backdropUrl: dlBackdropUrl,
        runtimeSeconds: runtimeMinutes ? runtimeMinutes * 60 : undefined,
      }),
    [movieReq, title, year, dlPosterUrl, dlBackdropUrl, runtimeMinutes],
  );
  const getEpisodeMeta = useCallback(
    (ep: Episode) =>
      resolveOfflineMeta(
        { tmdbId: id, mediaType: "tv", title, year, seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber },
        {
          title,
          year,
          episodeTitle: ep.name,
          posterUrl: dlPosterUrl,
          backdropUrl: ep.stillUrl || dlBackdropUrl,
          runtimeSeconds: ep.runtime ? ep.runtime * 60 : undefined,
        },
      ),
    [id, title, year, dlPosterUrl, dlBackdropUrl],
  );

  if (loading && !details) {
    return <DetailSkeleton />;
  }

  if (!details || error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <BackButton />
        </View>
        <EmptyState title="Couldn't load this title" subtitle={error ?? "Please try again."} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET + insets.bottom }}
      >
        {/* Backdrop hero */}
        <View style={{ height: HERO_HEIGHT }}>
          <PosterImage uri={backdrop} style={StyleSheet.absoluteFill} contentFit="cover" />
          <Scrim
            stops={["transparent", "transparent", colors.scrimBottom, colors.background]}
            locations={[0, 0.45, 0.9, 1]}
          />
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 14, paddingHorizontal: 16 }}>
            <Text style={{ color: colors.white, fontSize: 28, fontWeight: "800", letterSpacing: 0.2 }}>{title}</Text>
            <View style={{ marginTop: 10 }}>
              <MetaRow
                year={year}
                runtimeMinutes={runtimeMinutes}
                rating={details.vote_average}
                seasons={mediaType === "tv" ? details.number_of_seasons : undefined}
              />
            </View>
          </View>
        </View>

        {/* Actions */}
        <View style={{ marginTop: 6 }}>
          <ActionRow onPlay={() => play(mediaType === "tv" ? (seasonNumber ?? 1) : undefined, mediaType === "tv" ? 1 : undefined)}>
            <MyListButton item={myItem} />
            {mediaType === "movie" ? (
              <DownloadButton assetId={progressIdentity(movieReq)} getMeta={getMovieMeta} />
            ) : null}
          </ActionRow>
        </View>

        {/* Overview */}
        {details.tagline ? (
          <Text style={{ color: colors.muted, fontStyle: "italic", fontSize: 13, paddingHorizontal: 16, marginTop: 20 }}>
            {details.tagline}
          </Text>
        ) : null}
        {details.overview ? (
          <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 21, paddingHorizontal: 16, marginTop: details.tagline ? 8 : 20 }}>
            {details.overview}
          </Text>
        ) : null}

        {/* Genres */}
        {genres.length ? (
          <View style={{ paddingHorizontal: 16, marginTop: 18 }}>
            <GenreChips genres={genres} />
          </View>
        ) : null}

        {/* TV: seasons + episodes */}
        {mediaType === "tv" && realSeasons.length ? (
          <View style={{ marginTop: 26 }}>
            <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700", paddingHorizontal: 16, marginBottom: 12 }}>
              Episodes
            </Text>
            <SeasonPicker
              seasons={realSeasons}
              selected={seasonNumber ?? realSeasons[0].season_number}
              onSelect={setSeasonNumber}
            />
            <View style={{ marginTop: 8 }}>
              {seasonLoading && !season ? (
                <View style={{ paddingHorizontal: 16, gap: 16, paddingVertical: 8 }}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} width={undefined} height={74} radius={8} />
                  ))}
                </View>
              ) : seasonError ? (
                <Text style={{ color: colors.muted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 }}>
                  Couldn’t load episodes for this season.
                </Text>
              ) : (season?.episodes?.length ?? 0) === 0 ? (
                <Text style={{ color: colors.muted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 }}>
                  No episodes available for this season yet.
                </Text>
              ) : (
                season?.episodes.map((ep) => (
                  <EpisodeRow
                    key={`${ep.seasonNumber}-${ep.episodeNumber}`}
                    episode={ep}
                    imageBase={season?.imageBase}
                    onPress={() => play(ep.seasonNumber, ep.episodeNumber)}
                    right={
                      <DownloadButton
                        variant="icon"
                        assetId={progressIdentity({
                          tmdbId: id,
                          mediaType: "tv",
                          seasonNumber: ep.seasonNumber,
                          episodeNumber: ep.episodeNumber,
                        })}
                        getMeta={() => getEpisodeMeta(ep)}
                      />
                    }
                  />
                ))
              )}
            </View>
          </View>
        ) : null}

        {/* Cast */}
        <View style={{ marginTop: 26 }}>
          <CastRail cast={details.credits?.cast} />
        </View>
      </Animated.ScrollView>

      <GlassHeader scrollY={scrollY} title={title} left={<BackButton />} fadeStart={HERO_HEIGHT - 200} fadeEnd={HERO_HEIGHT - 90} />
    </View>
  );
}

function DetailSkeleton() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Skeleton width={undefined} height={HERO_HEIGHT} radius={0} />
      <View style={{ paddingHorizontal: 16, marginTop: 16, gap: 12 }}>
        <Skeleton width={undefined} height={48} radius={8} />
        <Skeleton width={180} height={14} radius={4} />
        <Skeleton width={260} height={14} radius={4} />
        <Skeleton width={220} height={14} radius={4} />
      </View>
      <View style={{ position: "absolute", top: insets.top + 6, left: 16 }}>
        <BackButton />
      </View>
    </View>
  );
}

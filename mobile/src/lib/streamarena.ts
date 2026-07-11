import {
  getJson,
  invalidateUserDataCache,
  mutateJson,
  readCachedApiData,
  useApiData,
  withAccountScope,
} from "@/lib/api";

// Typed wrappers + TS types for the streamarena backend. Shapes verified against
// the Rust handlers (src/routes.rs, src/home_bootstrap.rs, src/resolver.rs):
//   • /api/tmdb/search   → camelCase normalized entries
//   • /api/tmdb/details  → RAW TMDB snake_case
//   • /api/tmdb/tv/season→ camelCase episodes
//   • /api/home/bootstrap→ named rails of snake_case TMDB titles
//   • /api/user/*        → reads wrapped as { entries: [...] }; My List PUT is replace-all

// ─────────────────────────── Core normalized title ───────────────────────────

export type MediaType = "movie" | "tv";

// A snake_case TMDB title as returned inside home-bootstrap rails and search-adjacent
// payloads. Fields are optional because specialized rails trim some of them.
export type TmdbTitle = {
  id: number | string;
  media_type?: MediaType | string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
};

// camelCase title as returned by /api/tmdb/search.
export type SearchTitle = {
  id: string;
  mediaType: MediaType;
  title: string;
  name: string;
  releaseDate: string;
  firstAirDate: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  voteAverage: number;
};

// The normalized shape every poster/card/hero consumes.
export type Title = {
  id: string;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  voteAverage: number;
  year: string;
};

function yearOf(date?: string | null): string {
  if (!date) return "";
  const m = /^(\d{4})/.exec(date);
  return m ? m[1] : "";
}

function nonEmpty(value?: string | null): string {
  return typeof value === "string" ? value : "";
}

export function normalizeTmdbTitle(e: TmdbTitle, fallbackType: MediaType = "movie"): Title {
  const mediaType: MediaType = e.media_type === "tv" ? "tv" : e.media_type === "movie" ? "movie" : fallbackType;
  return {
    id: String(e.id),
    mediaType,
    title: nonEmpty(e.title) || nonEmpty(e.name),
    posterPath: e.poster_path ?? null,
    backdropPath: e.backdrop_path ?? null,
    overview: nonEmpty(e.overview),
    voteAverage: typeof e.vote_average === "number" ? e.vote_average : 0,
    year: yearOf(e.release_date) || yearOf(e.first_air_date),
  };
}

export function normalizeSearchTitle(e: SearchTitle): Title {
  return {
    id: String(e.id),
    mediaType: e.mediaType === "tv" ? "tv" : "movie",
    title: nonEmpty(e.title) || nonEmpty(e.name),
    posterPath: e.posterPath ?? null,
    backdropPath: e.backdropPath ?? null,
    overview: nonEmpty(e.overview),
    voteAverage: typeof e.voteAverage === "number" ? e.voteAverage : 0,
    year: yearOf(e.releaseDate) || yearOf(e.firstAirDate),
  };
}

// ─────────────────────────── Images ───────────────────────────

const DEFAULT_IMAGE_BASE = "https://image.tmdb.org/t/p";

export function tmdbImage(
  path: string | null | undefined,
  size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original" = "w342",
  imageBase?: string,
): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${imageBase || DEFAULT_IMAGE_BASE}/${size}${path}`;
}

// ─────────────────────────── Home / browse ───────────────────────────

export type Genre = { id: number; name: string };
export type Rail = { results?: TmdbTitle[] };

export type HomeBootstrap = {
  imageBase?: string;
  genres?: Genre[];
  popular?: Rail;
  bingeworthy?: Rail;
  crowdPleasers?: Rail;
  topSeries?: Rail;
  criticallyAcclaimed?: Rail;
  trending?: Rail;
  nowPlaying?: Rail;
  topRated?: Rail;
  library?: unknown;
  _meta?: { status?: string };
};

// Rail render order + display titles + the media-type fallback for entries that
// omit media_type. (Keys must match the bootstrap payload.)
export const HOME_RAILS: { key: keyof HomeBootstrap; label: string; fallback: MediaType }[] = [
  { key: "trending", label: "Trending Now", fallback: "movie" },
  { key: "popular", label: "Popular Movies", fallback: "movie" },
  { key: "topSeries", label: "Popular Series", fallback: "tv" },
  { key: "bingeworthy", label: "Bingeworthy", fallback: "tv" },
  { key: "nowPlaying", label: "Now Playing", fallback: "movie" },
  { key: "crowdPleasers", label: "Crowd-Pleasers", fallback: "movie" },
  { key: "criticallyAcclaimed", label: "Critically Acclaimed", fallback: "movie" },
  { key: "topRated", label: "Top Rated", fallback: "movie" },
];

const EMPTY_HOME: HomeBootstrap = {};

export function useHomeBootstrap(scope?: string | null) {
  return useApiData<HomeBootstrap>(withAccountScope("/api/home/bootstrap", scope), EMPTY_HOME, {
    keepPreviousData: true,
  });
}

export function homeHero(home: HomeBootstrap): Title | null {
  const pick = home.trending?.results?.[0] || home.popular?.results?.[0] || home.topSeries?.results?.[0];
  return pick ? normalizeTmdbTitle(pick, "movie") : null;
}

// ─────────────────────────── Search ───────────────────────────

export type SearchResponse = { query: string; results: SearchTitle[]; imageBase: string };

export function searchTitles(query: string, limit = 40, signal?: AbortSignal): Promise<SearchResponse> {
  return getJson<SearchResponse>(
    `/api/tmdb/search?query=${encodeURIComponent(query)}&limit=${limit}`,
    { timeoutMs: 12_000, signal },
  );
}

// ─────────────────────────── Title details (raw TMDB) ───────────────────────────

export type TmdbGenre = { id: number; name: string };
export type CastMember = {
  id: number;
  name: string;
  character?: string;
  profile_path?: string | null;
  order?: number;
};
export type TmdbSeasonSummary = {
  season_number: number;
  episode_count?: number;
  name?: string;
  poster_path?: string | null;
  air_date?: string;
  overview?: string;
};
export type TitleDetails = {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  tagline?: string;
  certification?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  genres?: TmdbGenre[];
  seasons?: TmdbSeasonSummary[];
  credits?: { cast?: CastMember[]; crew?: CastMember[] };
  videos?: { results?: { key: string; site: string; type: string; name: string }[] };
};

export function useTitleDetails(tmdbId: string | number, mediaType: MediaType, enabled = true) {
  return useApiData<TitleDetails | null>(
    `/api/tmdb/details?tmdbId=${tmdbId}&mediaType=${mediaType}`,
    null,
    { enabled: enabled && !!tmdbId },
  );
}

// ─────────────────────────── Season / episodes ───────────────────────────

export type Episode = {
  episodeNumber: number;
  seasonNumber: number;
  stillPath: string;
  stillUrl: string;
  name: string;
  overview: string;
  airDate: string;
  runtime: number;
};
export type SeasonResponse = {
  tmdbId: string;
  seasonNumber: number;
  episodes: Episode[];
  imageBase: string;
};

export function useSeason(tmdbId: string | number, seasonNumber: number, enabled = true) {
  return useApiData<SeasonResponse | null>(
    `/api/tmdb/tv/season?tmdbId=${tmdbId}&seasonNumber=${seasonNumber}`,
    null,
    { enabled: enabled && !!tmdbId },
  );
}

// ─────────────────────────── Sources / resolve / play ───────────────────────────

export type SourceSummary = {
  sourceHash: string;
  infoHash?: string;
  provider: string;
  primary?: string;
  filename?: string;
  qualityLabel?: string;
  container?: string;
  isTorrent?: boolean;
  seeders?: number;
  size?: string;
  releaseGroup?: string;
  score?: number;
};
export type SourcesResponse = { sources: SourceSummary[]; healthState?: string };

export type AudioTrack = {
  streamIndex: number;
  language: string;
  title?: string;
  codec?: string;
  channels?: number;
  isDefault?: boolean;
  label?: string;
};
export type SubtitleTrack = {
  streamIndex: number;
  language: string;
  title?: string;
  codec?: string;
  isDefault?: boolean;
  isTextBased?: boolean;
  isExternal?: boolean;
  label?: string;
  vttUrl?: string;
};
export type ResolvedSource = {
  playableUrl: string;
  fallbackUrls?: string[];
  filename?: string;
  sourceHash: string;
  selectedFile?: string;
  selectedFilePath?: string;
  resolverProvider?: string;
  sourceInput?: string;
  tracks?: { audioTracks?: AudioTrack[]; subtitleTracks?: SubtitleTrack[] };
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex?: number;
  preferences?: { audioLang?: string; subtitleLang?: string; quality?: string };
  sessionKey?: string;
  session?: { sessionKey?: string };
};

export type ResolveParams = {
  tmdbId: string | number;
  mediaType: MediaType;
  title?: string;
  year?: string | number;
  seasonNumber?: number;
  episodeNumber?: number;
  audioLang?: string;
  subtitleLang?: string;
  quality?: string;
  sourceHash?: string;
  refreshResolve?: boolean;
  limit?: number;
};

function qs(obj: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  return params.toString();
}

function resolveQuery(p: ResolveParams): string {
  return qs({
    tmdbId: p.tmdbId,
    mediaType: p.mediaType,
    title: p.title,
    year: p.year,
    seasonNumber: p.seasonNumber,
    episodeNumber: p.episodeNumber,
    audioLang: p.audioLang,
    subtitleLang: p.subtitleLang,
    quality: p.quality,
    sourceHash: p.sourceHash,
    refreshResolve: p.refreshResolve ? 1 : undefined,
    limit: p.limit,
  });
}

export function getSources(p: ResolveParams, signal?: AbortSignal): Promise<SourcesResponse> {
  return getJson<SourcesResponse>(`/api/resolve/sources?${resolveQuery(p)}`, { timeoutMs: 60_000, signal });
}

export function resolveTitle(p: ResolveParams, signal?: AbortSignal): Promise<ResolvedSource> {
  const endpoint = p.mediaType === "tv" ? "/api/resolve/tv" : "/api/resolve/movie";
  return getJson<ResolvedSource>(`${endpoint}?${resolveQuery(p)}`, { timeoutMs: 60_000, signal });
}

export function sessionKeyOf(resolved: ResolvedSource): string | undefined {
  return resolved.sessionKey || resolved.session?.sessionKey;
}

// Build the backend HLS proxy URL. URLSearchParams encodes `playableUrl` exactly
// once; toAbsoluteApiUrl later only prepends the origin (never re-encodes).
export function buildHlsMasterUrl(playableUrl: string, audioStreamIndex?: number): string {
  const params = new URLSearchParams({ input: playableUrl });
  if (audioStreamIndex != null && audioStreamIndex >= 0) params.set("audioStream", String(audioStreamIndex));
  return `/api/hls/master.m3u8?${params.toString()}`;
}

export function buildSubtitleUrl(input: string, streamIndex: number): string {
  return `/api/subtitles.vtt?${new URLSearchParams({ input, streamIndex: String(streamIndex) }).toString()}`;
}

// Build the offline-export URL. The backend muxes a complete `+faststart` MP4 for the
// given source `input` (a resolved `sourceInput`/`playableUrl`) with the chosen audio
// language baked in, served with Range support. URLSearchParams encodes `input`
// exactly once; toAbsoluteApiUrl later only prepends the origin (never re-encodes).
export function buildExportUrl(input: string, audioStreamIndex?: number): string {
  const params = new URLSearchParams({ input });
  if (audioStreamIndex != null && audioStreamIndex >= 0) params.set("audioStream", String(audioStreamIndex));
  return `/api/download/export.mp4?${params.toString()}`;
}

// ─────────────────────────── User data ───────────────────────────

export type WatchProgressEntry = { sourceIdentity: string; resumeSeconds: number; updatedAt?: number };

export type ContinueWatchingItem = {
  sourceIdentity: string;
  title?: string;
  episode?: string;
  tmdbId?: string;
  mediaType?: string;
  seriesId?: string;
  year?: string;
  sourceHash?: string;
  sessionKey?: string;
  resolverProvider?: string;
  filename?: string;
  src?: string;
  thumb?: string;
  sourceInput?: string;
  episodeIndex?: number;
  resumeSeconds?: number;
};

export type MyListItem = {
  itemIdentity: string;
  title?: string;
  episode?: string;
  tmdbId?: string;
  mediaType?: string;
  seriesId?: string;
  year?: string;
  libraryType?: string;
  libraryId?: string;
  src?: string;
  thumb?: string;
  librarySrc?: string;
  episodeIndex?: number;
  addedAt?: number;
};

export type UserPreferences = Record<string, string>;

type EntriesEnvelope<T> = { entries: T[] };
const EMPTY_ENTRIES: EntriesEnvelope<never> = { entries: [] };
const EMPTY_PREFS: UserPreferences = {};

export function useContinueWatching(scope?: string | null) {
  const { data, loading, error, refetch } = useApiData<EntriesEnvelope<ContinueWatchingItem>>(
    withAccountScope("/api/user/continue-watching", scope),
    EMPTY_ENTRIES,
    { enabled: !!scope, keepPreviousData: true },
  );
  return { items: data.entries ?? [], loading, error, refetch };
}

export function useMyList(scope?: string | null) {
  const { data, loading, error } = useApiData<EntriesEnvelope<MyListItem>>(
    withAccountScope("/api/user/my-list", scope),
    EMPTY_ENTRIES,
    { enabled: !!scope, keepPreviousData: true },
  );
  return { items: data.entries ?? [], loading, error };
}

export function usePreferences(scope?: string | null) {
  return useApiData<UserPreferences>(withAccountScope("/api/user/preferences", scope), EMPTY_PREFS, {
    enabled: !!scope,
  });
}

// Mutations (PUT/POST), each invalidating the affected read caches.
export async function putWatchProgress(sourceIdentity: string, resumeSeconds: number, scope?: string): Promise<void> {
  await mutateJson("/api/user/watch-progress", "PUT", { sourceIdentity, resumeSeconds });
  invalidateUserDataCache(scope);
}

export async function putContinueWatching(item: ContinueWatchingItem, scope?: string): Promise<void> {
  await mutateJson("/api/user/continue-watching", "PUT", item);
  invalidateUserDataCache(scope);
}

export async function deleteContinueWatching(sourceIdentity: string, seriesId?: string, scope?: string): Promise<void> {
  await mutateJson("/api/user/continue-watching", "DELETE", { sourceIdentity, seriesId });
  invalidateUserDataCache(scope);
}

// My List is replace-all: send the full desired list.
export async function putMyList(entries: MyListItem[], scope?: string): Promise<void> {
  await mutateJson("/api/user/my-list", "PUT", { entries });
  invalidateUserDataCache(scope);
}

export async function putPreferences(partial: UserPreferences, scope?: string): Promise<void> {
  await mutateJson("/api/user/preferences", "PUT", partial);
  invalidateUserDataCache(scope);
}

// Playback preference option sets — values match the backend normalizers
// (normalize_preferred_audio_lang / _stream_quality / subtitle_preference in src/utils.rs).
export const AUDIO_LANG_OPTIONS = [
  { value: "auto", label: "Auto (original)" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
] as const;

export const SUBTITLE_LANG_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
] as const;

export const QUALITY_OPTIONS = [
  { value: "auto", label: "Auto (best available)" },
  { value: "2160p", label: "4K · 2160p" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
] as const;

export type PlaybackPrefs = { audioLang?: string; subtitleLang?: string; quality?: string };

// The playback-relevant subset of the user's synced preferences, normalized so a
// default/unknown value collapses to undefined (= "let the server decide", the prior
// behavior). Read synchronously from the API cache so the player can apply it at open()
// without a render-cycle race.
export function getCachedPreferences(scope?: string | null): PlaybackPrefs {
  const prefs = readCachedApiData<UserPreferences>(withAccountScope("/api/user/preferences", scope)) ?? {};
  const meaningful = (v: string | undefined, defaults: string[]) => {
    const t = (v ?? "").trim().toLowerCase();
    return t && !defaults.includes(t) ? t : undefined;
  };
  return {
    audioLang: meaningful(prefs.audioLang, ["", "auto"]),
    subtitleLang: meaningful(prefs.subtitleLang, ["", "auto"]),
    quality: meaningful(prefs.quality, ["", "auto"]),
  };
}

export type SessionProgressEvent = {
  positionSeconds: number;
  sourceHash?: string;
  eventType?: "success" | "playback_error" | "decode_failure" | "invalid" | string;
  healthState?: string;
  lastError?: string;
};

export async function postSessionProgress(
  key: { tmdbId: string | number; mediaType: MediaType; sessionKey?: string },
  event: SessionProgressEvent,
): Promise<void> {
  const query = qs({ tmdbId: key.tmdbId, mediaType: key.mediaType, sessionKey: key.sessionKey });
  await mutateJson(`/api/session/progress?${query}`, "POST", event).catch(() => {});
}

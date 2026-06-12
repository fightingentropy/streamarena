import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { bindHorizontalRailScroll } from "../lib/horizontal-rail-scroll.js";
import {
  addCurrentReturnToParam,
  buildWatchUrl,
  saveWatchParams,
  slugifyTitle,
} from "../lib/watch-params.js";

const SPORT_CONFIGS = Object.freeze({
  football: Object.freeze({
    apiUrl: "/api/football/matches",
    sportName: "Football",
    streamResolver: "sports",
    slugFallback: "football",
  }),
  basketball: Object.freeze({
    apiUrl: "/api/basketball/matches",
    sportName: "Basketball",
    streamResolver: "sports",
    slugFallback: "basketball",
  }),
  tennis: Object.freeze({
    apiUrl: "/api/tennis/matches",
    sportName: "Tennis",
    streamResolver: "sports",
    slugFallback: "tennis",
  }),
  hockey: Object.freeze({
    apiUrl: "/api/hockey/matches",
    sportName: "Hockey",
    streamResolver: "sports",
    slugFallback: "hockey",
  }),
  baseball: Object.freeze({
    apiUrl: "/api/baseball/matches",
    sportName: "Baseball",
    streamResolver: "sports",
    slugFallback: "baseball",
  }),
  "american-football": Object.freeze({
    apiUrl: "/api/american-football/matches",
    sportName: "American Football",
    streamResolver: "sports",
    slugFallback: "american-football",
  }),
  cricket: Object.freeze({
    apiUrl: "/api/cricket/matches",
    sportName: "Cricket",
    streamResolver: "sports",
    slugFallback: "cricket",
  }),
});

const SPORT_TABS = Object.freeze(
  Object.entries(SPORT_CONFIGS).map(([id, config]) =>
    Object.freeze({ id, label: config.sportName }),
  ),
);

const SPORTS_SCHEDULE_SOURCES = Object.freeze(["streamed", "matchstream", "ntvs"]);
const SPORTS_SOURCE_LABELS = Object.freeze({
  streamed: "Streamed",
  matchstream: "MatchStream",
  ntvs: "NTVS",
});

function normalizeSport(value) {
  const sport = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SPORT_CONFIGS, sport) ? sport : "football";
}

function readInitialSport(options = {}) {
  const optionSport = normalizeSport(options.initialSport);
  if (optionSport !== "football") return optionSport;
  try {
    return normalizeSport(new URLSearchParams(window.location.search).get("sport"));
  } catch {
    return "football";
  }
}

function updateSportsUrl(sport) {
  try {
    const url = new URL(window.location.href);
    if (!url.pathname.endsWith(".html")) {
      url.pathname = "/sports";
    }
    if (sport === "football") {
      url.searchParams.delete("sport");
    } else {
      url.searchParams.set("sport", sport);
    }
    url.searchParams.delete("source");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // History updates are progressive enhancement; tab switching still works without them.
  }
}

function buildSportsApiUrl(apiUrl, source) {
  const query = new URLSearchParams();
  if (source && source !== "auto") {
    query.set("source", source);
  }
  const suffix = query.toString();
  return suffix ? `${apiUrl}?${suffix}` : apiUrl;
}

function sportsSourceLabel(source) {
  return SPORTS_SOURCE_LABELS[source] || "Sports";
}

function sportsScheduleSourcesForSport(sport) {
  return sport === "football"
    ? SPORTS_SCHEDULE_SOURCES
    : SPORTS_SCHEDULE_SOURCES.filter((source) => source !== "ntvs");
}

function normalizeProviderId(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "streamed" || provider === "matchstream" || provider === "ntvs"
    ? provider
    : "";
}

function isProviderLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "streamed" ||
    normalized === "matchstream" ||
    normalized === "ntvs" ||
    normalized === "auto"
  );
}

function formatDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const valueFor = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

function matchDateKey(match) {
  return formatDateKey(match.startTimestamp) || match.sourceMatchDate;
}

function formatTabWeekday(dateKey) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(
    new Date(`${dateKey}T12:00:00`),
  );
}

function formatTabDate(dateKey) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(new Date(`${dateKey}T12:00:00`));
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function normalizeMatches(payload, sportName, sourceHint = "") {
  const matches = Array.isArray(payload?.matches) ? payload.matches : [];
  const payloadProvider =
    normalizeProviderId(payload?.sourceProvider) || normalizeProviderId(sourceHint);
  return matches
    .filter((match) => Number.isFinite(Number(match?.startTimestamp)))
    .map((match) => {
      const startTimestamp = Number(match.startTimestamp);
      const endsAtTimestamp = Number(match.endsAtTimestamp || 0);
      const matchProvider =
        normalizeProviderId(match?.provider) || payloadProvider || normalizeProviderId(sourceHint);
      return {
        id: String(match.id || `${match.title}-${startTimestamp}`),
        title: String(match.title || `${sportName} match`).trim(),
        league: String(match.league || sportName).trim(),
        sport: String(match.sport || sportName).trim(),
        team1: String(match.team1 || "").trim(),
        team2: String(match.team2 || "").trim(),
        provider: matchProvider,
        providers: matchProvider ? [matchProvider] : [],
        sourceMatchDate: String(match.sourceMatchDate || "").trim(),
        startTimestamp,
        endsAtTimestamp,
        linkCount: Number(match.linkCount || 0),
        channelCount: Number(match.channelCount || 0),
        streams: Array.isArray(match.streams)
          ? match.streams
              .map((stream, index) => ({
                id: normalizeStreamId(stream, index, matchProvider),
                label: String(stream?.label || `Stream ${index + 1}`).trim(),
                source: String(stream?.source || "").trim(),
                provider:
                  normalizeProviderId(stream?.provider) ||
                  matchProvider ||
                  normalizeProviderId(sourceHint),
                playbackType: String(stream?.playbackType || "").trim().toLowerCase(),
                quality: String(stream?.quality || "").trim(),
              }))
              .filter((stream) => stream.source)
          : [],
      };
    })
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
}

function normalizeStreamId(stream, index, provider) {
  const raw = String(stream?.id || `stream-${index + 1}`).trim();
  const normalizedProvider = normalizeProviderId(stream?.provider) || provider;
  if (!normalizedProvider || raw.toLowerCase().startsWith(`${normalizedProvider}-`)) {
    return raw;
  }
  return `${normalizedProvider}-${raw}`;
}

function sportsMatchMergeKey(match) {
  const titleKey = slugifyTitle(
    match.title || [match.team1, match.team2].filter(Boolean).join(" vs "),
  );
  return `${match.sport.toLowerCase()}:${matchDateKey(match)}:${titleKey}`;
}

function sportsStreamPreferenceScore(stream = {}) {
  const source = String(stream?.source || "").trim().toLowerCase();
  const label = String(stream?.label || "").trim().toLowerCase();
  const provider = normalizeProviderId(stream?.provider) || "";
  if (source.includes("/watch/")) {
    return 0;
  }
  if (label.includes("admin") || source.includes("/admin/") || source.includes("/api/stream/admin/")) {
    return provider === "ntvs" ? 1 : 2;
  }
  if (provider === "ntvs") {
    return 3;
  }
  if (provider === "streamed") {
    if (label.includes("delta") || source.includes("/api/stream/delta/")) {
      return 6;
    }
    return 4;
  }
  if (provider === "matchstream") {
    return 5;
  }
  return 7;
}

function sortSportsStreams(streams = []) {
  return [...streams]
    .map((stream, index) => ({ stream, index, score: sportsStreamPreferenceScore(stream) }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.stream);
}

function pickPreferredSportsStream(streams = []) {
  const sorted = sortSportsStreams(streams);
  return sorted[0] || null;
}

function mergeSportsMatches(providerMatches) {
  const merged = new Map();
  providerMatches.flat().forEach((match) => {
    const key = sportsMatchMergeKey(match);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...match,
        providers: Array.from(new Set(match.providers || [])).filter(Boolean),
        streams: sortSportsStreams(match.streams),
      });
      return;
    }

    const providers = new Set([...(existing.providers || []), ...(match.providers || [])]);
    const seenSources = new Set(existing.streams.map((stream) => stream.source));
    const streams = [...existing.streams];
    match.streams.forEach((stream) => {
      if (!stream.source || seenSources.has(stream.source)) return;
      seenSources.add(stream.source);
      streams.push(stream);
    });
    existing.providers = Array.from(providers).filter(Boolean);
    existing.streams = sortSportsStreams(streams);
    existing.linkCount = existing.streams.length;
    existing.channelCount = Math.max(existing.channelCount || 0, match.channelCount || 0);
    existing.endsAtTimestamp = Math.max(existing.endsAtTimestamp, match.endsAtTimestamp);
    existing.startTimestamp = Math.min(existing.startTimestamp, match.startTimestamp);
    existing.provider = existing.providers.length > 1 ? "auto" : existing.providers[0] || "";
  });
  return Array.from(merged.values()).sort((a, b) => a.startTimestamp - b.startTimestamp);
}

function isLive(match, now) {
  return match.startTimestamp <= now && now < match.endsAtTimestamp;
}

function isUpcoming(match, now) {
  return match.endsAtTimestamp > now;
}

function sportsIconPath(sportName) {
  const isBasketball = String(sportName || "").toLowerCase() === "basketball";
  return isBasketball
    ? "M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 2.1c.9 0 1.75.17 2.54.49a13.7 13.7 0 0 0-1.5 3.28 14.6 14.6 0 0 1-3.77-.9A7.5 7.5 0 0 1 12 4.5Zm-4.28 4.4a16.7 16.7 0 0 0 4.9 1.34 15.7 15.7 0 0 0-.2 3.52 16.1 16.1 0 0 0-6.94 2.62A7.46 7.46 0 0 1 7.72 8.9Zm-.92 9.16a13.9 13.9 0 0 1 5.94-2.25 13.6 13.6 0 0 0 1.77 3.68A7.47 7.47 0 0 1 6.8 18.06Zm9.55.1a11.6 11.6 0 0 1-1.56-2.58 16 16 0 0 1 3.76.66 7.54 7.54 0 0 1-2.2 1.92Zm3.35-3.8a18.3 18.3 0 0 0-5.5-.9 13.2 13.2 0 0 1 .21-3.05 16 16 0 0 0 4.27-.4 7.45 7.45 0 0 1 1.02 4.35Zm-2.36-6.18a13.3 13.3 0 0 1-2.32.2c.33-.83.75-1.62 1.26-2.36.38.28.73.6 1.06.96Z"
    : "M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 4.1 3.1 2.25-1.18 3.65h-3.84L8.9 8.75 12 6.5Zm-5.68 5.35 2.98 2.18-.9 3.24a7 7 0 0 1-3.1-4.92l1.02-.5Zm3.22 6.76.86-3.08h3.2l.86 3.08a7.05 7.05 0 0 1-4.92 0Zm6.06-1.34-.9-3.24 2.98-2.18 1.02.5a7 7 0 0 1-3.1 4.92Z";
}

function getSportsPlayerEpisodeLabel(match) {
  const league = String(match?.league || "").trim();
  const provider = normalizeProviderId(match?.provider);
  const sourceNames = new Set([
    "auto",
    "streamed",
    "matchstream",
    "ntvs",
    provider,
    ...((Array.isArray(match?.providers) ? match.providers : [])
      .map(normalizeProviderId)
      .filter(Boolean)),
  ]);
  return sourceNames.has(league.toLowerCase()) ? "" : league;
}

function getMatchDisplayLeague(match) {
  const league = String(match?.league || "").trim();
  return league && !isProviderLabel(league) ? league : "";
}

function buildSportsPlayerUrl(match, config) {
  const streams = sortSportsStreams(Array.isArray(match.streams) ? match.streams : []);
  const defaultStream = pickPreferredSportsStream(streams);
  if (!defaultStream?.source) {
    return "";
  }

  const slug = slugifyTitle(match.title || match.id || config.slugFallback);
  const episodeLabel = getSportsPlayerEpisodeLabel(match);
  const params = new URLSearchParams({
    title: match.title || config.sportName,
    src: defaultStream.source,
    live: "1",
    liveEmbed: "1",
    liveResolver: config.streamResolver,
    liveStreamId: defaultStream.id || "stream-1",
    liveStreams: JSON.stringify(streams),
  });
  if (episodeLabel) {
    params.set("episode", episodeLabel);
  }
  addCurrentReturnToParam(params);
  saveWatchParams(slug, params.toString());
  return buildWatchUrl(params);
}

function openSportsPlayer(match, config) {
  const playerUrl = buildSportsPlayerUrl(match, config);
  if (playerUrl) {
    window.location.href = playerUrl;
  }
}

function liveProgressPercent(match, now) {
  const span = match.endsAtTimestamp - match.startTimestamp;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(100, ((now - match.startTimestamp) / span) * 100));
}

// The strict `style-src-attr 'none'` CSP blocks inline element styles, so the
// live progress width is expressed as a 5%-stepped utility class
// (.sports-card-progress-fill.is-w-* in sports.css) rather than style={{ width }}.
function liveProgressWidthClass(match, now) {
  return `is-w-${Math.round(liveProgressPercent(match, now) / 5) * 5}`;
}

function renderCard(match, nowAccessor, config, railTitle) {
  const leagueLabel = getMatchDisplayLeague(match);
  // League rails already carry the league name in the rail title; only mixed
  // rails ("Live now" / "Upcoming") need it repeated on the card itself.
  const cardLeague = leagueLabel && leagueLabel !== railTitle ? leagueLabel : "";
  const streamsLabel = `${match.linkCount} ${match.linkCount === 1 ? "stream" : "streams"}`;
  const live = () => isLive(match, nowAccessor());
  const playable = () => live() && match.streams.length > 0;

  return <>
    <article class={`sports-card sport-${config.slugFallback}${live() ? " is-live" : ""}`}>
      <button
        class="sports-card-hit"
        type="button"
        disabled={!playable()}
        onClick={() => {
          if (playable()) openSportsPlayer(match, config);
        }}
        aria-label={playable() ? `Play ${match.title} in Netflix` : match.title}
        title={
          playable()
            ? "Play in Netflix"
            : live()
              ? "No stream available yet"
              : "Available when live"
        }
      >
        <span class="sports-card-art">
          <span class="sports-card-watermark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d={sportsIconPath(config.sportName)} /></svg>
          </span>
          <span class="sports-card-shade" aria-hidden="true"></span>
          {live()
            ? ""
            : <><span class="sports-card-kick">{formatTime(match.startTimestamp)}</span></>}
          <span class="sports-card-badges">
            {live()
              ? <>
                <span class="sports-badge is-live">
                  <span class="sports-badge-dot" aria-hidden="true"></span>Live
                </span>
              </>
              : ""}
            {match.linkCount
              ? <><span class="sports-badge is-links">{streamsLabel}</span></>
              : ""}
          </span>
          <span class="sports-card-name">{match.title}</span>
          <span class="sports-card-play" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z" /></svg>
          </span>
          {live()
            ? <>
              <span class="sports-card-progress">
                <span
                  class={`sports-card-progress-fill ${liveProgressWidthClass(match, nowAccessor())}`}
                ></span>
              </span>
            </>
            : ""}
        </span>
        {cardLeague
          ? <><span class="sports-card-meta">{cardLeague}</span></>
          : ""}
      </button>
    </article>
  </>;
}

function renderRail(group, nowAccessor, config, bindRail) {
  return <>
    <section class={`sports-rail${group.live ? " is-live-rail" : ""}`}>
      <h2 class="sports-rail-title">
        {group.live ? <><span class="sports-rail-dot" aria-hidden="true"></span></> : ""}
        <span>{group.title}</span>
        <span class="sports-rail-count">{group.matches.length}</span>
      </h2>
      <div class="sports-rail-track" ref={bindRail}>
        {group.matches.map((match) => renderCard(match, nowAccessor, config, group.title))}
      </div>
    </section>
  </>;
}

export default function SportsScheduleView(options = {}) {
  const [selectedSport, setSelectedSport] = createSignal(readInitialSport(options));
  const [matches, setMatches] = createSignal([]);
  const [selectedDate, setSelectedDate] = createSignal("");
  const [filterMode, setFilterMode] = createSignal("all");
  const [status, setStatus] = createSignal("loading");
  const [errorText, setErrorText] = createSignal("");
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const config = createMemo(() => SPORT_CONFIGS[selectedSport()] || SPORT_CONFIGS.football);
  let intervalId;
  let loadSequence = 0;

  const dates = createMemo(() => {
    const uniqueDates = new Set();
    matches().forEach((match) => uniqueDates.add(matchDateKey(match)));
    return Array.from(uniqueDates).sort();
  });

  const selectedMatches = createMemo(() => {
    const date = selectedDate();
    return matches().filter((match) => matchDateKey(match) === date);
  });

  const selectedStats = createMemo(() => {
    const currentNow = now();
    const items = selectedMatches().filter((match) => isUpcoming(match, currentNow));
    const liveCount = items.filter((match) => isLive(match, currentNow)).length;
    return { all: items.length, live: liveCount };
  });

  // Group the day's matches into a "Live now" rail plus one rail per league.
  // The `equals` guard keeps the rail structure stable so per-second `now()`
  // ticks update live badges/progress at the leaf without rebuilding (and
  // resetting the scroll of) every rail each second.
  const railModel = createMemo(
    () => {
      const currentNow = now();
      const items = selectedMatches()
        .filter((match) => isUpcoming(match, currentNow))
        .filter((match) => filterMode() !== "live" || isLive(match, currentNow));
      const liveItems = [];
      const byLeague = new Map();
      items.forEach((match) => {
        if (isLive(match, currentNow)) {
          liveItems.push(match);
          return;
        }
        const realLeague = getMatchDisplayLeague(match);
        const label =
          realLeague && realLeague.toLowerCase() !== config().sportName.toLowerCase()
            ? realLeague
            : "Upcoming";
        if (!byLeague.has(label)) byLeague.set(label, []);
        byLeague.get(label).push(match);
      });
      const groups = [];
      if (liveItems.length) {
        groups.push({ id: "live", title: "Live now", live: true, matches: liveItems });
      }
      byLeague.forEach((leagueMatches, title) => {
        groups.push({ id: `league:${title}`, title, live: false, matches: leagueMatches });
      });
      const key = groups
        .map((group) => `${group.id}#${group.matches.map((match) => match.id).join(",")}`)
        .join("|");
      return { key, groups };
    },
    undefined,
    { equals: (left, right) => left.key === right.key },
  );

  const railCleanups = [];
  const bindRail = (element) => {
    if (element) railCleanups.push(bindHorizontalRailScroll(element));
  };

  async function loadMatches() {
    const requestId = ++loadSequence;
    const activeSport = selectedSport();
    const activeConfig = config();
    setStatus("loading");
    setErrorText("");
    try {
      const sourceResults = await Promise.allSettled(
        sportsScheduleSourcesForSport(activeSport).map(async (source) => {
          const payload = await fetchSportsSchedule(activeConfig, source);
          return {
            source,
            payload,
            matches: normalizeMatches(payload, activeConfig.sportName, source),
          };
        }),
      );
      const fulfilled = sourceResults
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      if (!fulfilled.length) {
        const rejected = sourceResults.find((result) => result.status === "rejected");
        throw rejected?.reason || new Error(`${activeConfig.sportName} schedule failed.`);
      }
      const nextMatches = mergeSportsMatches(fulfilled.map((result) => result.matches));
      const nextFetchedAt = Math.max(
        ...fulfilled.map((result) => Number(result.payload?.fetchedAt || Date.now())),
      );

      if (requestId !== loadSequence) return;
      setMatches(nextMatches);
      setFetchedAt(nextFetchedAt);

      const nextDates = Array.from(
        new Set(nextMatches.map((match) => matchDateKey(match))),
      ).sort();
      const today = formatDateKey(Date.now());
      setSelectedDate((current) => {
        if (current && nextDates.includes(current)) return current;
        return nextDates.includes(today) ? today : nextDates[0] || "";
      });
      setStatus("ready");
    } catch (error) {
      if (requestId !== loadSequence) return;
      setErrorText(
        error?.message || `Could not load ${activeConfig.sportName.toLowerCase()} matches.`,
      );
      setStatus("error");
    }
  }

  async function fetchSportsSchedule(activeConfig, source) {
    const response = await fetch(buildSportsApiUrl(activeConfig.apiUrl, source), {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error ||
          `${sportsSourceLabel(source)} ${activeConfig.sportName} schedule failed (${response.status})`,
      );
    }
    return payload;
  }

  function switchSport(sport) {
    const nextSport = normalizeSport(sport);
    if (selectedSport() === nextSport) return;
    setSelectedSport(nextSport);
    setMatches([]);
    setSelectedDate("");
    setFilterMode("all");
    setFetchedAt(0);
    updateSportsUrl(nextSport);
    void loadMatches();
  }

  onMount(() => {
    updateSportsUrl(selectedSport());
    void loadMatches();
    intervalId = window.setInterval(() => setNow(Date.now()), 1000);
  });

  onCleanup(() => {
    if (intervalId) window.clearInterval(intervalId);
    railCleanups.forEach((cleanup) => cleanup());
    railCleanups.length = 0;
  });

  return <>
    <main class="sports-main">
      <header class="sports-hero">
        <p class="sports-hero-eyebrow">Live Sports</p>
        <h1 class="sports-hero-title">{config().sportName}</h1>
        <p class="sports-hero-meta">
          <span class="sports-hero-live">
            <span class="sports-hero-dot" aria-hidden="true"></span>
            {selectedStats().live} live now
          </span>
          <span class="sports-hero-sep" aria-hidden="true">•</span>
          <span>{selectedStats().all} scheduled</span>
        </p>
      </header>

      <nav class="sports-genres" aria-label="Sports">
        {SPORT_TABS.map((sport) => <>
          <button
            type="button"
            class={`sports-genre${selectedSport() === sport.id ? " is-active" : ""}`}
            aria-pressed={(selectedSport() === sport.id ? "true" : "false")}
            onClick={() => switchSport(sport.id)}
          >{sport.label}</button>
        </>)}
      </nav>

      <div class="sports-controls">
        <div class="sports-dates" role="tablist" aria-label="Schedule date">
          {dates().map((dateKey) => <>
            <button
              type="button"
              role="tab"
              aria-selected={(selectedDate() === dateKey ? "true" : "false")}
              class={`sports-date${selectedDate() === dateKey ? " is-active" : ""}`}
              onClick={() => setSelectedDate(dateKey)}
            >
              <span class="sports-date-day">{formatTabWeekday(dateKey)}</span>
              <span class="sports-date-num">{formatTabDate(dateKey)}</span>
            </button>
          </>)}
        </div>
        <div class="sports-filter" aria-label="Filter matches">
          <button
            type="button"
            class={(filterMode() === "all" ? "is-active" : "")}
            onClick={() => setFilterMode("all")}
          >All</button>
          <button
            type="button"
            class={(filterMode() === "live" ? "is-active" : "")}
            onClick={() => setFilterMode("live")}
          >
            Live
            {selectedStats().live
              ? <><span class="sports-filter-count">{selectedStats().live}</span></>
              : ""}
          </button>
        </div>
      </div>

      {status() === "loading"
        ? <><div class="sports-state">Loading {config().sportName.toLowerCase()} matches…</div></>
        : status() === "error"
          ? <>
            <div class="sports-state is-error">
              <p>{errorText()}</p>
              <button type="button" class="sports-retry" onClick={loadMatches}>Try again</button>
            </div>
          </>
          : railModel().groups.length === 0
            ? <>
              <div class="sports-state">
                {filterMode() === "live"
                  ? `No ${config().sportName.toLowerCase()} matches are live right now.`
                  : `No ${config().sportName.toLowerCase()} matches scheduled for this day.`}
              </div>
            </>
            : <>
              <div class="sports-rails">
                {railModel().groups.map((group) => renderRail(group, now, config(), bindRail))}
              </div>
            </>}

      <footer class="sports-foot">
        <span class="sports-foot-stamp">
          {fetchedAt() ? `Updated ${formatTime(fetchedAt())}` : ""}
        </span>
        <button type="button" class="sports-refresh" onClick={loadMatches}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12a8 8 0 0 1 13.66-5.66M20 5v4h-4M20 12a8 8 0 0 1-13.66 5.66M4 19v-4h4" />
          </svg>
          Refresh
        </button>
      </footer>
    </main>
  </>;
}

import html from "solid-js/html";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
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

const SPORTS_SCHEDULE_SOURCES = Object.freeze(["streamed", "matchstream"]);
const SPORTS_SOURCE_LABELS = Object.freeze({
  streamed: "Streamed",
  matchstream: "MatchStream",
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

function normalizeProviderId(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "streamed" || provider === "matchstream" ? provider : "";
}

function isProviderLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "streamed" || normalized === "matchstream" || normalized === "auto";
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
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

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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

function mergeSportsMatches(providerMatches) {
  const merged = new Map();
  providerMatches.flat().forEach((match) => {
    const key = sportsMatchMergeKey(match);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...match,
        providers: Array.from(new Set(match.providers || [])).filter(Boolean),
        streams: [...match.streams],
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
    existing.streams = streams;
    existing.linkCount = streams.length;
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

function sportsIcon(sportName) {
  const isBasketball = String(sportName || "").toLowerCase() === "basketball";
  const iconPath = isBasketball
    ? "M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 2.1c.9 0 1.75.17 2.54.49a13.7 13.7 0 0 0-1.5 3.28 14.6 14.6 0 0 1-3.77-.9A7.5 7.5 0 0 1 12 4.5Zm-4.28 4.4a16.7 16.7 0 0 0 4.9 1.34 15.7 15.7 0 0 0-.2 3.52 16.1 16.1 0 0 0-6.94 2.62A7.46 7.46 0 0 1 7.72 8.9Zm-.92 9.16a13.9 13.9 0 0 1 5.94-2.25 13.6 13.6 0 0 0 1.77 3.68A7.47 7.47 0 0 1 6.8 18.06Zm9.55.1a11.6 11.6 0 0 1-1.56-2.58 16 16 0 0 1 3.76.66 7.54 7.54 0 0 1-2.2 1.92Zm3.35-3.8a18.3 18.3 0 0 0-5.5-.9 13.2 13.2 0 0 1 .21-3.05 16 16 0 0 0 4.27-.4 7.45 7.45 0 0 1 1.02 4.35Zm-2.36-6.18a13.3 13.3 0 0 1-2.32.2c.33-.83.75-1.62 1.26-2.36.38.28.73.6 1.06.96Z"
    : "M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 4.1 3.1 2.25-1.18 3.65h-3.84L8.9 8.75 12 6.5Zm-5.68 5.35 2.98 2.18-.9 3.24a7 7 0 0 1-3.1-4.92l1.02-.5Zm3.22 6.76.86-3.08h3.2l.86 3.08a7.05 7.05 0 0 1-4.92 0Zm6.06-1.34-.9-3.24 2.98-2.18 1.02.5a7 7 0 0 1-3.1 4.92Z";
  return html`
    <span class="sports-ball-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d=${iconPath} />
      </svg>
    </span>
  `;
}

function getSportsPlayerEpisodeLabel(match) {
  const league = String(match?.league || "").trim();
  const provider = normalizeProviderId(match?.provider);
  const sourceNames = new Set([
    "auto",
    "streamed",
    "matchstream",
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
  const streams = Array.isArray(match.streams) ? match.streams : [];
  const defaultStream = streams[0] || null;
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

function renderPlayButton(match, now, config) {
  const live = isLive(match, now);
  const disabledIcon = html`
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" /></svg>
  `;

  if (!match.streams.length) {
    return html`<span class="sports-play-button is-disabled" aria-label="No source page">
      ${disabledIcon}
    </span>`;
  }
  if (!live) {
    return html`<span class="sports-play-button is-disabled" aria-label="Match is not live" title="Available when live">
      ${disabledIcon}
    </span>`;
  }
  return html`
    <button
      class="sports-play-button"
      type="button"
      onClick=${() => openSportsPlayer(match, config)}
      aria-label=${`Play ${match.title} in Netflix`}
      title="Play in Netflix"
    >
      ${disabledIcon}
    </button>
  `;
}

function renderMatchRow(match, now, config) {
  const live = isLive(match, now);
  const linksLabel = `${match.linkCount} ${match.linkCount === 1 ? "link" : "links"}`;
  const leagueLabel = getMatchDisplayLeague(match);

  return html`
    <article class=${`sports-match-row${live ? " is-live" : ""}`}>
      <div class="sports-match-main">
        ${sportsIcon(config.sportName)}
        <div class="sports-match-copy">
          <h3>${match.title}</h3>
          <p>
            <span class="sports-sport">${match.sport}</span>
            ${leagueLabel
              ? html`<span aria-hidden="true">•</span><span>${leagueLabel}</span>`
              : ""}
            <span aria-hidden="true">•</span>
            <span>${linksLabel}</span>
            ${live ? html`<span class="sports-live-pill">Live</span>` : ""}
          </p>
        </div>
      </div>
      <div class="sports-time-pill">${formatTime(match.startTimestamp)}</div>
      ${renderPlayButton(match, now, config)}
    </article>
  `;
}

export default function SportsScheduleView(options = {}) {
  const [selectedSport, setSelectedSport] = createSignal(readInitialSport(options));
  const [matches, setMatches] = createSignal([]);
  const [selectedDate, setSelectedDate] = createSignal("");
  const [filterMode, setFilterMode] = createSignal("all");
  const [groupMode, setGroupMode] = createSignal("match");
  const [status, setStatus] = createSignal("loading");
  const [errorText, setErrorText] = createSignal("");
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const timeZone = getLocalTimeZone();
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

  const visibleMatches = createMemo(() => {
    const currentNow = now();
    return selectedMatches()
      .filter((match) => isUpcoming(match, currentNow))
      .filter((match) => filterMode() !== "live" || isLive(match, currentNow));
  });

  const selectedStats = createMemo(() => {
    const currentNow = now();
    const items = selectedMatches().filter((match) => isUpcoming(match, currentNow));
    const liveCount = items.filter((match) => isLive(match, currentNow)).length;
    return { all: items.length, live: liveCount };
  });

  async function loadMatches() {
    const requestId = ++loadSequence;
    const activeConfig = config();
    setStatus("loading");
    setErrorText("");
    try {
      const sourceResults = await Promise.allSettled(
        SPORTS_SCHEDULE_SOURCES.map(async (source) => {
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
    setGroupMode("match");
    setFetchedAt(0);
    updateSportsUrl(nextSport);
    void loadMatches();
  }

  function moveSelectedDate(delta) {
    const allDates = dates();
    const currentIndex = allDates.indexOf(selectedDate());
    if (currentIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(allDates.length - 1, currentIndex + delta));
    setSelectedDate(allDates[nextIndex]);
  }

  function renderDateTab(dateKey) {
    const active = selectedDate() === dateKey;
    return html`
      <button
        class=${`sports-date-tab${active ? " is-active" : ""}`}
        type="button"
        onClick=${() => setSelectedDate(dateKey)}
      >
        <span>${formatTabWeekday(dateKey)}</span>
        <strong>${formatTabDate(dateKey)}</strong>
      </button>
    `;
  }

  function renderGroupedMatches() {
    const activeConfig = config();
    const items = visibleMatches();
    if (!items.length) {
      return html`
        <div class="sports-empty-state">
          ${filterMode() === "live"
            ? `No ${activeConfig.sportName.toLowerCase()} matches are live for this date.`
            : `No upcoming ${activeConfig.sportName.toLowerCase()} matches for this date.`}
        </div>
      `;
    }

    if (groupMode() !== "league") {
      return items.map((match) => renderMatchRow(match, now(), activeConfig));
    }

    const groups = new Map();
    items.forEach((match) => {
      const key = match.league || activeConfig.sportName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(match);
    });
    return Array.from(groups.entries()).map(([league, leagueMatches]) => html`
      <section class="sports-league-group">
        <h3>${league}</h3>
        ${leagueMatches.map((match) => renderMatchRow(match, now(), activeConfig))}
      </section>
    `);
  }

  onMount(() => {
    updateSportsUrl(selectedSport());
    void loadMatches();
    intervalId = window.setInterval(() => setNow(Date.now()), 1000);
  });

  onCleanup(() => {
    if (intervalId) window.clearInterval(intervalId);
  });

  return html`
    <main class="sports-main">
      <nav class="sports-switcher" aria-label="Sports">
        ${SPORT_TABS.map((sport) => html`
          <button
            type="button"
            class=${() => (selectedSport() === sport.id ? "is-active" : "")}
            aria-pressed=${() => (selectedSport() === sport.id ? "true" : "false")}
            onClick=${() => switchSport(sport.id)}
          >${sport.label}</button>
        `)}
      </nav>
      <section class="sports-board" aria-label=${() => `${config().sportName} schedule`}>
        <div class="sports-date-strip">
          <button
            class="sports-date-arrow"
            type="button"
            aria-label="Previous date"
            disabled=${() => dates().indexOf(selectedDate()) <= 0}
            onClick=${() => moveSelectedDate(-1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div class="sports-date-tabs">
            ${() => dates().map(renderDateTab)}
          </div>
          <button
            class="sports-date-arrow"
            type="button"
            aria-label="Next date"
            disabled=${() => dates().indexOf(selectedDate()) >= dates().length - 1}
            onClick=${() => moveSelectedDate(1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>

        <div class="sports-toolbar">
          <div class="sports-toolbar-left">
            <h2>Event</h2>
            <span class="sports-count-pill">All: ${() => selectedStats().all}</span>
            <span class="sports-count-pill">Live: <strong>${() => selectedStats().live}</strong></span>
            <span class="sports-clock-pill">
              ${() => `${formatClock(now())} • ${timeZone}`}
            </span>
            <div class="sports-segmented" aria-label="Schedule filter">
              <button
                type="button"
                class=${() => (filterMode() === "all" ? "is-active" : "")}
                onClick=${() => setFilterMode("all")}
              >All</button>
              <button
                type="button"
                class=${() => (filterMode() === "live" ? "is-active" : "")}
                onClick=${() => setFilterMode("live")}
              >Live</button>
            </div>
            <select
              class="sports-group-select"
              aria-label="Group matches"
              value=${() => groupMode()}
              onInput=${(event) => setGroupMode(event.currentTarget.value)}
            >
              <option value="match">By match</option>
              <option value="league">By league</option>
            </select>
          </div>
          <div class="sports-toolbar-right">
            <span>Time</span>
            <span>Play</span>
          </div>
        </div>

        ${() =>
          status() === "loading"
            ? html`<div class="sports-loading-state">Fetching ${config().sportName.toLowerCase()} matches...</div>`
            : status() === "error"
              ? html`
                <div class="sports-error-state">
                  <p>${errorText()}</p>
                  <button type="button" onClick=${loadMatches}>Retry</button>
                </div>
              `
              : html`<div class="sports-match-list">${renderGroupedMatches()}</div>`}

        <div class="sports-source-row">
          <span>
            ${() => {
              if (!fetchedAt()) return "";
              return `Updated ${formatTime(fetchedAt())}`;
            }}
          </span>
          <button type="button" onClick=${loadMatches}>Refresh</button>
        </div>
      </section>
    </main>
  `;
}

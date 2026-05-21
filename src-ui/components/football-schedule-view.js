import html from "solid-js/html";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { saveWatchParams, slugifyTitle } from "../lib/watch-params.js";

const FOOTBALL_API_URL = "/api/football/matches";

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
  return match.sourceMatchDate || formatDateKey(match.startTimestamp);
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

function normalizeMatches(payload) {
  const matches = Array.isArray(payload?.matches) ? payload.matches : [];
  return matches
    .filter((match) => Number.isFinite(Number(match?.startTimestamp)))
    .map((match) => {
      const startTimestamp = Number(match.startTimestamp);
      const endsAtTimestamp = Number(match.endsAtTimestamp || 0);
      return {
        id: String(match.id || `${match.title}-${startTimestamp}`),
        title: String(match.title || "Football match").trim(),
        league: String(match.league || "Football").trim(),
        sport: String(match.sport || "Football").trim(),
        sourceMatchDate: String(match.sourceMatchDate || "").trim(),
        startTimestamp,
        endsAtTimestamp,
        linkCount: Number(match.linkCount || 0),
        channelCount: Number(match.channelCount || 0),
        streams: Array.isArray(match.streams)
          ? match.streams
              .map((stream, index) => ({
                id: String(stream?.id || `stream-${index + 1}`).trim(),
                label: String(stream?.label || `Stream ${index + 1}`).trim(),
                source: String(stream?.source || "").trim(),
                quality: String(stream?.quality || "").trim(),
              }))
              .filter((stream) => stream.source)
          : [],
      };
    })
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
}

function isLive(match, now) {
  return match.startTimestamp <= now && now < match.endsAtTimestamp;
}

function isUpcoming(match, now) {
  return match.endsAtTimestamp > now;
}

function footballIcon() {
  return html`
    <span class="football-ball-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 4.1 3.1 2.25-1.18 3.65h-3.84L8.9 8.75 12 6.5Zm-5.68 5.35 2.98 2.18-.9 3.24a7 7 0 0 1-3.1-4.92l1.02-.5Zm3.22 6.76.86-3.08h3.2l.86 3.08a7.05 7.05 0 0 1-4.92 0Zm6.06-1.34-.9-3.24 2.98-2.18 1.02.5a7 7 0 0 1-3.1 4.92Z" />
      </svg>
    </span>
  `;
}

function buildFootballPlayerUrl(match) {
  const streams = Array.isArray(match.streams) ? match.streams : [];
  const defaultStream = streams[0] || null;
  if (!defaultStream?.source) {
    return "";
  }

  const slug = slugifyTitle(match.title || match.id || "football");
  const params = new URLSearchParams({
    title: match.title || "Football",
    episode: match.league || "Live",
    src: defaultStream.source,
    live: "1",
    liveEmbed: "1",
    liveStreamId: defaultStream.id || "stream-1",
    liveStreams: JSON.stringify(streams),
  });
  saveWatchParams(slug, params.toString());
  return `/watch/${slug}`;
}

function openFootballPlayer(match) {
  const playerUrl = buildFootballPlayerUrl(match);
  if (playerUrl) {
    window.location.href = playerUrl;
  }
}

function renderPlayButton(match, now) {
  const live = isLive(match, now);
  const disabledIcon = html`
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" /></svg>
  `;

  if (!match.streams.length) {
    return html`<span class="football-play-button is-disabled" aria-label="No source page">
      ${disabledIcon}
    </span>`;
  }
  if (!live) {
    return html`<span class="football-play-button is-disabled" aria-label="Match is not live" title="Available when live">
      ${disabledIcon}
    </span>`;
  }
  return html`
    <button
      class="football-play-button"
      type="button"
      onClick=${() => openFootballPlayer(match)}
      aria-label=${`Play ${match.title} in Netflix`}
      title="Play in Netflix"
    >
      ${disabledIcon}
    </button>
  `;
}

function renderMatchRow(match, now) {
  const live = isLive(match, now);
  const linksLabel = `${match.linkCount} ${match.linkCount === 1 ? "link" : "links"}`;

  return html`
    <article class=${`football-match-row${live ? " is-live" : ""}`}>
      <div class="football-match-main">
        ${footballIcon()}
        <div class="football-match-copy">
          <h3>${match.title}</h3>
          <p>
            <span class="football-sport">${match.sport}</span>
            <span aria-hidden="true">•</span>
            <span>${match.league}</span>
            <span aria-hidden="true">•</span>
            <span>${linksLabel}</span>
            ${live ? html`<span class="football-live-pill">Live</span>` : ""}
          </p>
        </div>
      </div>
      <div class="football-time-pill">${formatTime(match.startTimestamp)}</div>
      ${renderPlayButton(match, now)}
    </article>
  `;
}

export default function FootballScheduleView() {
  const [matches, setMatches] = createSignal([]);
  const [selectedDate, setSelectedDate] = createSignal("");
  const [filterMode, setFilterMode] = createSignal("all");
  const [groupMode, setGroupMode] = createSignal("match");
  const [status, setStatus] = createSignal("loading");
  const [errorText, setErrorText] = createSignal("");
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const timeZone = getLocalTimeZone();
  let intervalId;

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
    setStatus("loading");
    setErrorText("");
    try {
      const response = await fetch(FOOTBALL_API_URL, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `Football schedule failed (${response.status})`);
      }
      const nextMatches = normalizeMatches(payload);
      setMatches(nextMatches);
      setFetchedAt(Number(payload?.fetchedAt || Date.now()));

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
      setErrorText(error?.message || "Could not load football matches.");
      setStatus("error");
    }
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
        class=${`football-date-tab${active ? " is-active" : ""}`}
        type="button"
        onClick=${() => setSelectedDate(dateKey)}
      >
        <span>${formatTabWeekday(dateKey)}</span>
        <strong>${formatTabDate(dateKey)}</strong>
      </button>
    `;
  }

  function renderGroupedMatches() {
    const items = visibleMatches();
    if (!items.length) {
      return html`
        <div class="football-empty-state">
          ${filterMode() === "live"
            ? "No football matches are live for this date."
            : "No upcoming football matches for this date."}
        </div>
      `;
    }

    if (groupMode() !== "league") {
      return items.map((match) => renderMatchRow(match, now()));
    }

    const groups = new Map();
    items.forEach((match) => {
      const key = match.league || "Football";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(match);
    });
    return Array.from(groups.entries()).map(([league, leagueMatches]) => html`
      <section class="football-league-group">
        <h3>${league}</h3>
        ${leagueMatches.map((match) => renderMatchRow(match, now()))}
      </section>
    `);
  }

  onMount(() => {
    void loadMatches();
    intervalId = window.setInterval(() => setNow(Date.now()), 1000);
  });

  onCleanup(() => {
    if (intervalId) window.clearInterval(intervalId);
  });

  return html`
    <main class="football-main">
      <section class="football-board" aria-label="Football schedule">
        <div class="football-date-strip">
          <button
            class="football-date-arrow"
            type="button"
            aria-label="Previous date"
            disabled=${() => dates().indexOf(selectedDate()) <= 0}
            onClick=${() => moveSelectedDate(-1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div class="football-date-tabs">
            ${() => dates().map(renderDateTab)}
          </div>
          <button
            class="football-date-arrow"
            type="button"
            aria-label="Next date"
            disabled=${() => dates().indexOf(selectedDate()) >= dates().length - 1}
            onClick=${() => moveSelectedDate(1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>

        <div class="football-toolbar">
          <div class="football-toolbar-left">
            <h2>Event</h2>
            <span class="football-count-pill">All: ${() => selectedStats().all}</span>
            <span class="football-count-pill">Live: <strong>${() => selectedStats().live}</strong></span>
            <span class="football-clock-pill">
              ${() => `${formatClock(now())} • ${timeZone}`}
            </span>
            <div class="football-segmented" aria-label="Schedule filter">
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
              class="football-group-select"
              aria-label="Group matches"
              value=${() => groupMode()}
              onInput=${(event) => setGroupMode(event.currentTarget.value)}
            >
              <option value="match">By match</option>
              <option value="league">By league</option>
            </select>
          </div>
          <div class="football-toolbar-right">
            <span>Time</span>
            <span>Play</span>
          </div>
        </div>

        ${() =>
          status() === "loading"
            ? html`<div class="football-loading-state">Fetching football matches...</div>`
            : status() === "error"
              ? html`
                <div class="football-error-state">
                  <p>${errorText()}</p>
                  <button type="button" onClick=${loadMatches}>Retry</button>
                </div>
              `
              : html`<div class="football-match-list">${renderGroupedMatches()}</div>`}

        <div class="football-source-row">
          <span>Fetched from super.league.st</span>
          <span>${() => (fetchedAt() ? `Updated ${formatTime(fetchedAt())}` : "")}</span>
          <button type="button" onClick=${loadMatches}>Refresh</button>
        </div>
      </section>
    </main>
  `;
}

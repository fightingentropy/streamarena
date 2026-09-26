import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { readSearchSnapshot, searchStateKey, writeSearchSnapshot } from "../lib/search-state.js";
import { handleArtworkImageError } from "../lib/offline-artwork.js";
import "../../discovery.css";

function recentKey() {
  const id = window.__currentUser?.id;
  return id ? `streamarena-recent-searches:${id}` : "";
}

function readRecent() {
  try {
    const values = JSON.parse(localStorage.getItem(recentKey()) || "[]");
    return Array.isArray(values) ? values.filter((q) => typeof q === "string").slice(0, 8) : [];
  } catch { return []; }
}

export default function SearchExperience(props) {
  const mediaType = () => props.state.mediaType;
  const genre = () => props.state.genre;
  const year = () => props.state.year;
  const personId = () => props.state.personId;
  const stateKey = createMemo(() => searchStateKey(props.state));
  const [person, setPerson] = createSignal(null);
  const [people, setPeople] = createSignal([]);
  const [genres, setGenres] = createSignal([]);
  const [results, setResults] = createSignal([]);
  const [imageBase, setImageBase] = createSignal("https://image.tmdb.org/t/p");
  const [recent, setRecent] = createSignal(readRecent());
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [page, setPage] = createSignal(1);
  const [hasMore, setHasMore] = createSignal(false);
  let controller;
  let version = 0;
  let failedPage = 1;
  let gridRef;
  let genreSelectRef;
  let loadedState = null;
  let selectedKey = "";
  let restoreFrame;

  function captureSearch() {
    if (!props.active || !loadedState || searchStateKey(loadedState) !== searchStateKey(props.state)) return;
    writeSearchSnapshot(loadedState, { results: results(), people: people(), person: person(), genres: genres(), imageBase: imageBase(), page: page(), hasMore: hasMore(), scrollY: window.scrollY, selectedKey }, window.__currentUser?.id);
  }
  props.onCaptureReady(captureSearch);
  window.addEventListener("pagehide", captureSearch);

  function remember() {
    const query = String(props.state.query || "").trim();
    if (query.length < 2 || !recentKey()) return;
    const next = [query, ...readRecent().filter((q) => q.toLowerCase() !== query.toLowerCase())].slice(0, 8);
    setRecent(next);
    try { localStorage.setItem(recentKey(), JSON.stringify(next)); } catch { /* optional */ }
  }

  async function load(nextPage = 1) {
    controller?.abort();
    const request = ++version;
    const requestedState = { ...props.state };
    const pending = new AbortController();
    controller = pending;
    setError("");
    setLoading(true);
    failedPage = nextPage;
    const params = new URLSearchParams({ query: props.state.query || "", mediaType: mediaType(), page: String(nextPage) });
    if (genre()) params.set("genre", genre());
    if (year()) params.set("year", year());
    if (personId()) params.set("personId", personId());
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; pending.abort(); }, 22_000);
    try {
      const response = await fetch(`/api/tmdb/search?${params}`, { signal: pending.signal });
      if (!response.ok) throw new Error("Search unavailable");
      const payload = await response.json();
      if (request !== version || !props.active) return;
      const previous = nextPage === 1 ? [] : results();
      const seen = new Set(previous.map((item) => `${item.mediaType}:${item.id}`));
      setResults([...previous, ...(payload.results || []).filter((item) => {
        const key = `${item.mediaType}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })]);
      setPeople(payload.people || []);
      setPerson(payload.person || null);
      // The catalogue is shared across requests. Replacing option nodes resets
      // the browser's selected value even when the genre signal is unchanged.
      if (!genres().length) setGenres(payload.genres || []);
      setImageBase(payload.imageBase || "https://image.tmdb.org/t/p");
      loadedState = requestedState;
      setPage(nextPage);
      setHasMore(Boolean(payload.hasMore));
    } catch (failure) {
      if (request !== version || !props.active || (pending.signal.aborted && !timedOut)) return;
      setError(navigator.onLine === false ? "You’re offline. Reconnect and try again." : "Search couldn’t load. Please try again.");
    } finally {
      clearTimeout(timeout);
      if (request === version) setLoading(false);
    }
  }

  createEffect(on(() => [genre(), genres()], () => queueMicrotask(() => {
    if (genreSelectRef) genreSelectRef.value = genre();
  })));

  createEffect(on(() => [props.active, stateKey()], () => {
    controller?.abort();
    version += 1;
    setLoading(false);
    setResults([]);
    setPeople([]);
    setPerson(null);
    setError("");
    setHasMore(false);
    setPage(1);
    loadedState = null;
    selectedKey = "";
    cancelAnimationFrame(restoreFrame);
    if (!props.active) return;
    setRecent(readRecent());
    const cached = readSearchSnapshot(props.state, window.__currentUser?.id);
    if (cached) {
      setResults(cached.results);
      setPeople(cached.people || []);
      setPerson(cached.person || null);
      if (!genres().length) setGenres(cached.genres);
      setImageBase(cached.imageBase || "https://image.tmdb.org/t/p");
      setPage(cached.page);
      setHasMore(Boolean(cached.hasMore));
      loadedState = { ...props.state };
      selectedKey = cached.selectedKey || "";
      restoreFrame = requestAnimationFrame(() => {
        window.scrollTo({ top: Math.max(0, Number(cached.scrollY) || 0), behavior: "auto" });
        if (props.restoreFocus) Array.from(gridRef?.querySelectorAll(".search-result-card") || []).find((card) => card.dataset.searchKey === selectedKey)?.focus({ preventScroll: true });
      });
      return;
    }
    if (year() && !/^\d{4}$/.test(year())) return;
    if ((props.state.query || "").trim().length === 1) return;
    setLoading(true);
    const timer = window.setTimeout(() => void load(), 280);
    onCleanup(() => clearTimeout(timer));
  }));
  onCleanup(() => {
    version += 1;
    controller?.abort();
    cancelAnimationFrame(restoreFrame);
    window.removeEventListener("pagehide", captureSearch);
    props.onCaptureReady(null);
  });

  const status = () => {
    if (error()) return error();
    if (loading()) return page() > 1 && results().length ? "Loading more titles…" : "Finding titles…";
    if (year() && !/^\d{4}$/.test(year())) return "Enter a four-digit year, or leave it blank.";
    if ((props.state.query || "").trim().length === 1) return "Type at least two characters to search.";
    if (person()) return `Films and series with ${person().name}`;
    if (results().length) return props.state.query ? `Results for “${props.state.query}”` : "Explore movies and series";
    return hasMore() ? "No matching titles on this page. Load more to keep looking." : "No titles match this search. Try another name or adjust the filters.";
  };

  return (
    <section id="searchExperience" class="search-experience" hidden={!props.active}>
      <h1 class="discovery-heading">Search</h1>
      <div class="discovery-filters" aria-label="Filter titles">
        <label><span>Type</span><select aria-label="Title type" value={mediaType()} onChange={(e) => props.onChange({ mediaType: e.currentTarget.value })}>
          <option value="all">All titles</option><option value="movie">Movies</option><option value="tv">Series</option>
        </select></label>
        <label><span>Genre</span><select ref={(element) => (genreSelectRef = element)} aria-label="Genre" value={genre()} onChange={(e) => props.onChange({ genre: e.currentTarget.value })}>
          <option value="">All genres</option><For each={genres()}>{(g) => <option value={g.id}>{g.name}</option>}</For>
        </select></label>
        <label><span>Year</span><input aria-label="Release year" type="text" inputmode="numeric" maxlength="4" placeholder="Any year" value={year()} onInput={(e) => props.onChange({ year: e.currentTarget.value })} /></label>
        <Show when={genre() || year() || mediaType() !== "all" || personId()}>
          <button class="discovery-text-button" onClick={() => { props.onChange({ mediaType: "all", genre: "", year: "", personId: "" }); }}>Clear filters</button>
        </Show>
      </div>
      <Show when={!props.state.query && recent().length > 0}>
        <div class="discovery-people" aria-label="Recent searches"><span>Recent</span>
          <For each={recent()}>{(query) => <button class="discovery-pill" onClick={() => props.onChange({ query, personId: "" })}>{query}</button>}</For>
          <button class="discovery-text-button" onClick={() => { setRecent([]); try { localStorage.removeItem(recentKey()); } catch { /* optional */ } }}>Clear recent</button>
        </div>
      </Show>
      <Show when={people().length > 0}>
        <div class="discovery-people" aria-label="People">
          <For each={people()}>{(p) => <button class="discovery-person" aria-pressed={String(person()?.id) === String(p.id)} onClick={() => { remember(); props.onChange({ personId: String(p.id) }); }}>
            <strong>{p.name}</strong><span>{p.department || "Filmography"}</span>
          </button>}</For>
        </div>
      </Show>
      <div class="discovery-status">
        <p id="searchStatus" class={`search-status${error() ? " is-error" : ""}`} role="status" aria-live="polite">{status()}</p>
        <Show when={error()}><button class="discovery-pill" onClick={() => void load(failedPage)}>Retry search</button></Show>
      </div>
      <div id="searchResultsGrid" class="search-results-grid" ref={(element) => (gridRef = element)} aria-busy={loading()}>
        <For each={results()}>{(item) => <button class="search-result-card" data-search-key={`${item.mediaType}:${item.id}`} aria-label={`Details for ${item.title || item.name}`} aria-haspopup="dialog" onClick={(event) => { remember(); selectedKey = `${item.mediaType}:${item.id}`; captureSearch(); props.onOpen(item, imageBase(), event.currentTarget); }} onContextMenu={(event) => props.onContext(event, item, imageBase())}>
          <img src={item.posterPath || item.backdropPath ? `${imageBase()}/w500${item.posterPath || item.backdropPath}` : "/assets/images/thumbnail.jpg"} alt={item.title || item.name} loading="lazy" onError={handleArtworkImageError} />
          <p class="search-result-card-title">{item.title || item.name}</p>
          <span class="discovery-card-meta">{item.mediaType === "tv" ? "Series" : "Movie"}{(item.releaseDate || item.firstAirDate) ? ` · ${(item.releaseDate || item.firstAirDate).slice(0, 4)}` : ""}</span>
        </button>}</For>
      </div>
      <Show when={hasMore() && !error()}><button class="discovery-load-more discovery-pill" disabled={loading()} onClick={() => void load(page() + 1)}>{loading() ? "Loading…" : "Load more"}</button></Show>
    </section>
  );
}

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
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
  const [mediaType, setMediaType] = createSignal("all");
  const [genre, setGenre] = createSignal("");
  const [year, setYear] = createSignal("");
  const [personId, setPersonId] = createSignal("");
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

  function remember() {
    const query = String(props.query || "").trim();
    if (query.length < 2 || !recentKey()) return;
    const next = [query, ...readRecent().filter((q) => q.toLowerCase() !== query.toLowerCase())].slice(0, 8);
    setRecent(next);
    try { localStorage.setItem(recentKey(), JSON.stringify(next)); } catch { /* optional */ }
  }

  async function load(nextPage = 1) {
    controller?.abort();
    const request = ++version;
    const pending = new AbortController();
    controller = pending;
    setError("");
    setLoading(true);
    failedPage = nextPage;
    const params = new URLSearchParams({ query: props.query || "", mediaType: mediaType(), page: String(nextPage) });
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
      setGenres(payload.genres || []);
      setImageBase(payload.imageBase || "https://image.tmdb.org/t/p");
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

  createEffect(on(() => props.query, () => setPersonId("")));
  createEffect(on(() => [props.active, props.query, mediaType(), genre(), year(), personId()], () => {
    controller?.abort();
    version += 1;
    setLoading(false);
    setResults([]);
    setPeople([]);
    setPerson(null);
    setError("");
    setHasMore(false);
    if (!props.active) return;
    setRecent(readRecent());
    if (year() && !/^\d{4}$/.test(year())) return;
    if ((props.query || "").trim().length === 1) return;
    setLoading(true);
    const timer = window.setTimeout(() => void load(), 280);
    onCleanup(() => clearTimeout(timer));
  }));
  onCleanup(() => { version += 1; controller?.abort(); });

  const status = () => {
    if (error()) return error();
    if (loading()) return page() > 1 && results().length ? "Loading more titles…" : "Finding titles…";
    if (year() && !/^\d{4}$/.test(year())) return "Enter a four-digit year, or leave it blank.";
    if ((props.query || "").trim().length === 1) return "Type at least two characters to search.";
    if (person()) return `Films and series with ${person().name}`;
    if (results().length) return props.query ? `Results for “${props.query}”` : "Explore movies and series";
    return hasMore() ? "No matching titles on this page. Load more to keep looking." : "No titles match this search. Try another name or adjust the filters.";
  };

  return (
    <section id="searchExperience" class="search-experience" hidden={!props.active}>
      <div class="discovery-filters" aria-label="Filter titles">
        <label><span>Type</span><select aria-label="Title type" value={mediaType()} onChange={(e) => setMediaType(e.currentTarget.value)}>
          <option value="all">All titles</option><option value="movie">Movies</option><option value="tv">Series</option>
        </select></label>
        <label><span>Genre</span><select aria-label="Genre" value={genre()} onChange={(e) => setGenre(e.currentTarget.value)}>
          <option value="">All genres</option><For each={genres()}>{(g) => <option value={g.id}>{g.name}</option>}</For>
        </select></label>
        <label><span>Year</span><input aria-label="Release year" type="text" inputmode="numeric" maxlength="4" placeholder="Any year" value={year()} onInput={(e) => setYear(e.currentTarget.value.replace(/\D/g, "").slice(0, 4))} /></label>
        <Show when={genre() || year() || mediaType() !== "all" || personId()}>
          <button class="discovery-text-button" onClick={() => { setMediaType("all"); setGenre(""); setYear(""); setPersonId(""); }}>Clear filters</button>
        </Show>
      </div>
      <Show when={!props.query && recent().length > 0}>
        <div class="discovery-people" aria-label="Recent searches"><span>Recent</span>
          <For each={recent()}>{(query) => <button class="discovery-pill" onClick={() => props.onQuery(query)}>{query}</button>}</For>
          <button class="discovery-text-button" onClick={() => { setRecent([]); try { localStorage.removeItem(recentKey()); } catch { /* optional */ } }}>Clear recent</button>
        </div>
      </Show>
      <Show when={people().length > 0}>
        <div class="discovery-people" aria-label="People">
          <For each={people()}>{(p) => <button class="discovery-person" aria-pressed={String(person()?.id) === String(p.id)} onClick={() => { remember(); setPersonId(String(p.id)); }}>
            <strong>{p.name}</strong><span>{p.department || "Filmography"}</span>
          </button>}</For>
        </div>
      </Show>
      <div class="discovery-status">
        <p id="searchStatus" class={`search-status${error() ? " is-error" : ""}`} role="status" aria-live="polite">{status()}</p>
        <Show when={error()}><button class="discovery-pill" onClick={() => void load(failedPage)}>Retry search</button></Show>
      </div>
      <div id="searchResultsGrid" class="search-results-grid" aria-busy={loading()}>
        <For each={results()}>{(item) => <button class="search-result-card" aria-label={`Play ${item.title || item.name}`} onClick={() => { remember(); props.onPlay(item, imageBase()); }} onContextMenu={(event) => props.onContext(event, item, imageBase())}>
          <img src={item.backdropPath || item.posterPath ? `${imageBase()}/w780${item.backdropPath || item.posterPath}` : "/assets/images/thumbnail.jpg"} alt={item.title || item.name} loading="lazy" onError={handleArtworkImageError} />
          <p class="search-result-card-title">{item.title || item.name}</p>
          <span class="discovery-card-meta">{item.mediaType === "tv" ? "Series" : "Movie"}{(item.releaseDate || item.firstAirDate) ? ` · ${(item.releaseDate || item.firstAirDate).slice(0, 4)}` : ""}</span>
        </button>}</For>
      </div>
      <Show when={hasMore() && !error()}><button class="discovery-load-more discovery-pill" disabled={loading()} onClick={() => void load(page() + 1)}>{loading() ? "Loading…" : "Load more"}</button></Show>
    </section>
  );
}

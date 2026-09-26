import { createMemo, For, Show } from "solid-js";
import { buildTmdbArtworkSrcSet, handleArtworkImageError } from "../lib/offline-artwork.js";

export default function MyListView(props) {
  const filtered = createMemo(() => {
    const entries = props.entries.filter((entry) => props.type === "all" ||
      (entry.mediaType === "tv" || entry.seriesId ? "tv" : "movie") === props.type);
    return entries.sort((left, right) => {
      if (props.sort === "title") return left.title.localeCompare(right.title, undefined, { sensitivity: "base", numeric: true });
      if (props.sort === "year") return (Number(right.year) || 0) - (Number(left.year) || 0) || left.title.localeCompare(right.title);
      return Number(right.addedAt || 0) - Number(left.addedAt || 0);
    });
  });
  const count = () => `${filtered().length} ${filtered().length === 1 ? "title" : "titles"}`;

  return <section id="myListView" class="my-list-view" hidden={!props.active} aria-labelledby="myListHeading">
    <header class="my-list-header">
      <div><h1 id="myListHeading" tabindex="-1">My List</h1><p>Your next watch, all in one place.</p></div>
      <label class="my-list-sort"><span>Sort by</span><select aria-label="Sort My List" value={props.sort} onChange={(event) => props.onFilter(props.type, event.currentTarget.value)}>
        <option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="year">Release year</option>
      </select></label>
    </header>
    <div class="my-list-toolbar">
      <div class="my-list-filters" role="group" aria-label="Filter My List">
        <For each={[["all", "All titles"], ["movie", "Movies"], ["tv", "Series"]]}>{([type, label]) =>
          <button type="button" aria-pressed={props.type === type} onClick={() => props.onFilter(type, props.sort)}>{label}</button>
        }</For>
      </div>
      <p class="my-list-count" role="status">{props.loading ? "Loading your list…" : count()}</p>
    </div>
    <Show when={props.error}>
      <div class="my-list-load-error" role="status"><p>{props.entries.length ? "Your list couldn’t sync. Showing your saved titles from this device." : "Your list couldn’t load. Please try again."}</p><button type="button" onClick={props.onRetry}>Retry My List</button></div>
    </Show>
    <div class="my-list-grid" aria-busy={props.loading}>
      <For each={filtered()}>{(entry) => <article class="saved-title">
        <button type="button" class="saved-title-open" aria-label={`Details for ${entry.title}`} aria-haspopup="dialog" onClick={(event) => props.onOpen(entry, event.currentTarget)}>
          <div class="saved-title-art"><img src={entry.thumb} srcset={buildTmdbArtworkSrcSet(entry.thumb, [185, 342, 500])} sizes="(max-width: 600px) 45vw, (max-width: 1100px) 23vw, 15vw" alt="" loading="lazy" decoding="async" onError={handleArtworkImageError} /></div>
          <strong>{entry.title}</strong>
        </button>
        <div class="saved-title-footer"><span>{[entry.mediaType === "tv" || entry.seriesId ? "Series" : "Movie", entry.year].filter(Boolean).join(" · ")}</span>
          <button type="button" class="saved-title-remove" disabled={props.saving} aria-label={`Remove ${entry.title} from My List`} onClick={(event) => props.onRemove(entry, event.currentTarget)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
          </button>
        </div>
      </article>}</For>
    </div>
    <Show when={!filtered().length && !props.loading && !props.error}>
      <div class="my-list-empty">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 8h20v33L24 34 14 41zM19 19h10M24 14v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
        <h2>{props.entries.length ? `No ${props.type === "tv" ? "series" : "movies"} saved yet` : "Make room for your next favorite"}</h2>
        <p>Use the + button on a title to save it for later.</p>
        <button type="button" onClick={props.onBrowse}>Explore titles</button>
      </div>
    </Show>
  </section>;
}

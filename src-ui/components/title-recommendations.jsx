import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { handleArtworkImageError } from "../lib/offline-artwork.js";

export default function TitleRecommendations(props) {
  const [items, setItems] = createSignal([]);
  const [imageBase, setImageBase] = createSignal("https://image.tmdb.org/t/p");
  const [error, setError] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  let controller;
  let version = 0;

  async function load() {
    controller?.abort();
    const request = ++version;
    if (!props.visible || !props.title.tmdbId) return;
    const pending = new AbortController();
    controller = pending;
    setError(false);
    setLoading(true);
    const timeout = setTimeout(() => pending.abort(), 22_000);
    try {
      const params = new URLSearchParams({ tmdbId: props.title.tmdbId, mediaType: props.title.mediaType || "movie" });
      const response = await fetch(`/api/tmdb/recommendations?${params}`, { signal: pending.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Recommendations unavailable");
      const payload = await response.json();
      if (request !== version || !props.visible) return;
      setItems((payload.results || []).slice(0, 12));
      setImageBase(payload.imageBase || "https://image.tmdb.org/t/p");
    } catch {
      if (request === version && props.visible) setError(true);
    } finally {
      clearTimeout(timeout);
      if (request === version) setLoading(false);
    }
  }

  createEffect(on(() => [props.visible, props.title.tmdbId, props.title.mediaType], () => {
    version += 1;
    controller?.abort();
    setItems([]);
    setError(false);
    setLoading(false);
    void load();
  }));
  onCleanup(() => { version += 1; controller?.abort(); });

  return <Show when={props.title.tmdbId && (items().length || error() || loading())}>
    <section id="detailsMoreSection" class="details-more">
      <h4>More Like This</h4>
      <Show when={loading()}><p class="search-status" role="status">Finding related titles…</p></Show>
      <Show when={error()}><div class="discovery-status"><p class="search-status" role="status">Related titles couldn’t load.</p><button class="discovery-pill" onClick={() => void load()}>Retry recommendations</button></div></Show>
      <div id="detailsMoreGrid" class="details-grid">
        <For each={items()}>{(item) => <button class="details-item" aria-label={`Open ${item.title || item.name}`} onClick={(event) => props.onOpen(item, imageBase(), event.currentTarget)}>
          <img src={item.backdropPath || item.posterPath ? `${imageBase()}/w780${item.backdropPath || item.posterPath}` : "/assets/images/thumbnail.jpg"} alt={`${item.title || item.name} artwork`} loading="lazy" onError={handleArtworkImageError} />
          <p>{item.title || item.name}</p>
        </button>}</For>
      </div>
    </section>
  </Show>;
}

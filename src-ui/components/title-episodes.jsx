import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { buildTmdbArtworkSrcSet, handleArtworkImageError } from "../lib/offline-artwork.js";

export default function TitleEpisodes(props) {
  const [season, setSeason] = createSignal(0);
  const [episodes, setEpisodes] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const cache = new Map();
  let controller;
  let version = 0;
  let userSelectedSeason = false;
  const enabled = () => props.visible && props.title.mediaType === "tv";
  const identity = () => `${props.title.tmdbId || ""}:${props.title.seriesId || ""}`;
  const seasons = createMemo(() => {
    if (props.title.localEpisodes?.length) {
      return [...new Set(props.title.localEpisodes.map((episode) => episode.seasonNumber || 1))]
        .sort((a, b) => a - b).map((number) => ({ season_number: number, name: `Season ${number}` }));
    }
    return (props.title.seasons || []).filter((item) => item.season_number > 0 && item.episode_count > 0)
      .sort((a, b) => a.season_number - b.season_number);
  });

  createEffect(on(() => [enabled(), identity(), seasons(), props.resume?.seasonNumber], (current, previous) => {
    userSelectedSeason = Boolean(userSelectedSeason && previous?.[0] && current[1] === previous[1]);
    const preferred = userSelectedSeason ? season() : Number(props.resume?.seasonNumber || props.title.seasonNumber || 1);
    setSeason(enabled() ? (seasons().find((item) => item.season_number === preferred) || seasons()[0])?.season_number || 0 : 0);
  }));

  async function load() {
    controller?.abort();
    const request = ++version;
    setEpisodes([]);
    setLoading(false);
    setError(false);
    if (!enabled() || !season()) return;
    if (props.title.localEpisodes?.length) {
      setEpisodes(props.title.localEpisodes.filter((episode) => (episode.seasonNumber || 1) === season()));
      return;
    }
    const key = `${identity()}:${season()}`;
    const saved = cache.get(key);
    if (saved && Date.now() - saved.at < 300_000) {
      setEpisodes(saved.episodes);
      return;
    }
    const pending = new AbortController();
    controller = pending;
    setLoading(true);
    const timer = setTimeout(() => pending.abort(), 22_000);
    try {
      const params = new URLSearchParams({ tmdbId: props.title.tmdbId, seasonNumber: String(season()) });
      const response = await fetch(`/api/tmdb/tv/season?${params}`, { signal: pending.signal });
      if (!response.ok) throw new Error("Episodes unavailable");
      const payload = await response.json();
      if (request !== version || !enabled()) return;
      const items = (payload.episodes || []).filter((episode) => episode.episodeNumber > 0)
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
      cache.set(key, { at: Date.now(), episodes: items });
      if (cache.size > 12) cache.delete(cache.keys().next().value);
      setEpisodes(items);
    } catch {
      if (request === version && enabled()) setError(true);
    } finally {
      clearTimeout(timer);
      if (request === version) setLoading(false);
    }
  }

  createEffect(on(() => [enabled(), identity(), season(), props.title.localEpisodes], () => void load()));
  onCleanup(() => { version += 1; controller?.abort(); });

  const isUpcoming = (episode) => /^\d{4}-\d{2}-\d{2}$/.test(episode.airDate || "") && episode.airDate > new Date().toISOString().slice(0, 10);
  const isResumeEpisode = (episode) => props.resume &&
    Number(props.resume.seasonNumber) === Number(episode.seasonNumber) &&
    Number(props.resume.episodeNumber) === Number(episode.episodeNumber);
  const episodeTitle = (episode) => episode.name || episode.title || `Episode ${episode.episodeNumber}`;
  const episodeImage = (episode) => episode.stillUrl || episode.thumb || props.title.thumb;
  const availability = (episode) => `Available ${new Date(`${episode.airDate}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

  return <Show when={enabled() && (props.title.tmdbId || props.title.localEpisodes?.length)}>
    <section class="details-episodes" aria-labelledby="detailsEpisodesHeading">
      <div class="details-episodes-heading">
        <h4 id="detailsEpisodesHeading">Episodes</h4>
        <Show when={seasons().length}>
          <label class="details-season-picker">
            <select aria-label="Season" value={season()} onChange={(event) => { userSelectedSeason = true; setSeason(Number(event.currentTarget.value)); }}>
              <For each={seasons()}>{(item) => <option value={item.season_number}>{item.name || `Season ${item.season_number}`}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
      <Show when={loading() || props.metadataLoading}>
        <p class="search-status" role="status">Loading episodes…</p>
      </Show>
      <Show when={error()}>
        <div class="discovery-status"><p class="search-status" role="status">Episodes couldn’t load.</p><button class="discovery-pill" onClick={() => void load()}>Retry episodes</button></div>
      </Show>
      <Show when={!loading() && !error() && !props.metadataLoading && !episodes().length}>
        <p class="search-status" role="status">Episode information isn’t available yet.</p>
      </Show>
      <div class="details-episode-list" aria-busy={loading()}>
        <For each={episodes()}>{(episode) => <button
          class={`details-episode${isResumeEpisode(episode) ? " is-current" : ""}`}
          disabled={isUpcoming(episode)}
          aria-label={`${isUpcoming(episode) ? "Upcoming" : isResumeEpisode(episode) ? "Resume" : "Play"} season ${episode.seasonNumber}, episode ${episode.episodeNumber}: ${episodeTitle(episode)}`}
          onClick={() => props.onPlay(episode)}
        >
          <span class="details-episode-number" aria-hidden="true">{episode.episodeNumber}</span>
          <span class="details-episode-art">
            <img src={episodeImage(episode)} srcset={buildTmdbArtworkSrcSet(episodeImage(episode), [185, 300, 780])} sizes="(max-width: 760px) 92px, 150px" alt="" width="300" height="169" loading="lazy" decoding="async" onError={handleArtworkImageError} />
            <span class="details-episode-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7Z" /></svg></span>
          </span>
          <span class="details-episode-copy">
            <span class="details-episode-title"><strong><span class="details-episode-mobile-number">{episode.episodeNumber}. </span>{episodeTitle(episode)}</strong><Show when={episode.runtime > 0}><span>{episode.runtime}m</span></Show></span>
            <Show when={episode.overview || episode.description}><span class="details-episode-description">{episode.overview || episode.description}</span></Show>
            <Show when={isResumeEpisode(episode)}>
              <span class="details-episode-status">Continue watching · {props.resume.resumeSeconds < 60 ? "Just started" : `${Math.floor(props.resume.resumeSeconds / 60)} min watched`}</span>
              <Show when={episode.runtime > 0}><progress class="details-episode-progress" aria-label={`Progress for episode ${episode.episodeNumber}`} max="100" value={Math.min(100, props.resume.resumeSeconds / (episode.runtime * 60) * 100)} /></Show>
            </Show>
            <Show when={isUpcoming(episode)}><span class="details-episode-status">{availability(episode)}</span></Show>
          </span>
        </button>}</For>
      </div>
    </section>
  </Show>;
}

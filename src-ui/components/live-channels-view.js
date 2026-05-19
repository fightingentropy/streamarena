import html from "solid-js/html";

import { LIVE_CHANNELS } from "../lib/live-channels.js";
import { saveWatchParams, slugifyTitle } from "../lib/watch-params.js";

function slugify(value) {
  return String(value || "live")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizePlaybackSource(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/")) {
    return raw;
  }
  return raw.startsWith("assets/") ? `/${raw}` : raw;
}

function normalizeStreamOption(option, index = 0) {
  const source = normalizePlaybackSource(option?.source);
  if (!source) {
    return null;
  }
  const id =
    slugify(option?.id || option?.label || option?.quality || `stream-${index + 1}`) ||
    `stream-${index + 1}`;
  return {
    id,
    label: String(option?.label || option?.quality || `Stream ${index + 1}`).trim(),
    source,
    quality: String(option?.quality || "").trim(),
  };
}

function getChannelStreamOptions(channel) {
  const explicitStreams = Array.isArray(channel?.streams)
    ? channel.streams.map(normalizeStreamOption).filter(Boolean)
    : [];
  if (explicitStreams.length) {
    return explicitStreams;
  }
  const source = normalizePlaybackSource(channel?.source);
  if (!source) {
    return [];
  }
  return [
    {
      id: "default",
      label: "Default",
      source,
      quality: String(channel?.quality || "").trim(),
    },
  ];
}

function buildPlayerUrl(channel) {
  const streams = getChannelStreamOptions(channel);
  const defaultStream =
    streams.find((stream) => stream.id === channel?.defaultStreamId) ||
    streams[0] ||
    null;
  const source = normalizePlaybackSource(defaultStream?.source || channel?.source);
  const title = String(channel?.title || "Live").trim() || "Live";
  const params = new URLSearchParams({ title });

  if (source) {
    params.set("src", source);
  }
  if (streams.length > 0) {
    params.set("live", "1");
    params.set("liveStreamId", defaultStream?.id || streams[0].id);
    params.set("liveStreams", JSON.stringify(streams));
  }
  if (channel?.artwork) {
    params.set("thumb", channel.artwork);
  }
  params.set("episode", "Live");

  const slug = slugifyTitle(title);
  saveWatchParams(slug, params.toString());
  return `/watch/${slug}`;
}

function openLiveChannel(channel) {
  window.location.href = buildPlayerUrl(channel);
}

function renderChannelCard(channel) {
  return html`
    <button
      class="live-channel-card"
      type="button"
      onClick=${() => openLiveChannel(channel)}
      aria-label=${`Play ${channel.title}`}
    >
      <img src=${channel.artwork} alt=${`${channel.title} artwork`} loading="lazy" />
      <span class="live-channel-play" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
      </span>
      <span class="live-channel-body">
        <span class="live-channel-title">${channel.title}</span>
        <span class="live-channel-meta">
          <span>Live</span>
          <span>${channel.region}</span>
          <span>${channel.genre}</span>
          <span>${channel.quality}</span>
        </span>
      </span>
    </button>
  `;
}

export default function LiveChannelsView() {
  return html`
    <main class="live-main">
      <section class="live-channel-section">
        <h2>Live Channels</h2>
        <div class="live-channel-grid">
          ${LIVE_CHANNELS.map((channel) => renderChannelCard(channel))}
        </div>
      </section>
    </main>
  `;
}

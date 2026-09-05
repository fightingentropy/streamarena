import assert from "node:assert/strict";
import {
  SOURCE_MENU_HLS_TAB,
  SOURCE_MENU_TORRENTS_TAB,
  buildSourceMenuView,
} from "../src-ui/player/source-menu-tabs.js";
import {
  getSourceDisplayHint,
  promoteSelectedSourceWithinCacheTier,
  sortSourcesBySeeders,
} from "../src-ui/player/sources.js";
import {
  createRealDebridSourceRefreshController,
  shouldRefreshRealDebridCachedSources,
} from "../src-ui/player/real-debrid-cache-refresh.js";

const hlsSource = {
  sourceHash: "a".repeat(40),
  primary: "Meridian",
  container: "hls",
};
const torrentSource = {
  sourceHash: "b".repeat(40),
  primary: "Movie.1080p.mp4",
  container: "mp4",
};
const sources = [hlsSource, torrentSource];

const disabledView = buildSourceMenuView({ sources, torrentsEnabled: false });
assert.equal(disabledView.showTabs, false);
assert.deepEqual(disabledView.sources, sources);

const initialLoadingView = buildSourceMenuView({
  sources: [],
  torrentsEnabled: true,
});
assert.equal(
  initialLoadingView.activeTab,
  "",
  "an empty initial render must not invent a torrents tab before HLS discovery",
);

const explicitlyRequestedEmptyTorrentView = buildSourceMenuView({
  sources: [],
  requestedTab: SOURCE_MENU_TORRENTS_TAB,
  torrentsEnabled: true,
});
assert.equal(
  explicitlyRequestedEmptyTorrentView.activeTab,
  SOURCE_MENU_TORRENTS_TAB,
  "an explicit user tab choice must survive an empty refresh",
);

const selectedTorrentView = buildSourceMenuView({
  sources,
  selectedSourceHash: torrentSource.sourceHash,
  torrentsEnabled: true,
});
assert.equal(selectedTorrentView.activeTab, SOURCE_MENU_TORRENTS_TAB);
assert.deepEqual(selectedTorrentView.sources, [torrentSource]);
assert.deepEqual(selectedTorrentView.counts, { hls: 1, torrents: 1 });

const selectedHlsView = buildSourceMenuView({
  sources,
  selectedSourceHash: hlsSource.sourceHash,
  torrentsEnabled: true,
});
assert.equal(selectedHlsView.activeTab, SOURCE_MENU_HLS_TAB);
assert.deepEqual(selectedHlsView.sources, [hlsSource]);

// Empty requestedTab (menu just opened) must follow the playing source, not
// stick to a previously browsed tab.
const reopenOnPlayingSource = buildSourceMenuView({
  sources,
  selectedSourceHash: hlsSource.sourceHash,
  requestedTab: "",
  torrentsEnabled: true,
});
assert.equal(reopenOnPlayingSource.activeTab, SOURCE_MENU_HLS_TAB);

const requestedHlsView = buildSourceMenuView({
  sources,
  selectedSourceHash: torrentSource.sourceHash,
  requestedTab: SOURCE_MENU_HLS_TAB,
  torrentsEnabled: true,
});
assert.equal(requestedHlsView.activeTab, SOURCE_MENU_HLS_TAB);
assert.deepEqual(requestedHlsView.sources, [hlsSource]);
assert.equal(requestedHlsView.emptyMessage, "No HLS sources available.");

const emptyTorrentView = buildSourceMenuView({
  sources: [hlsSource],
  requestedTab: SOURCE_MENU_TORRENTS_TAB,
  torrentsEnabled: true,
});
assert.deepEqual(emptyTorrentView.sources, []);
assert.equal(emptyTorrentView.emptyMessage, "No torrent sources available.");


const cachedTorrentSource = {
  ...torrentSource,
  sourceHash: "c".repeat(40),
  primary: "Movie.2160p.mkv",
  container: "mkv",
  seeders: 1,
  realDebridCached: true,
};
const popularUncachedTorrentSource = {
  ...torrentSource,
  seeders: 10_000,
};
const morePopularUncachedTorrentSource = {
  ...torrentSource,
  sourceHash: "e".repeat(40),
  primary: "Movie.1080p.Remux.mp4",
  seeders: 20_000,
};
assert.deepEqual(
  sortSourcesBySeeders(
    [popularUncachedTorrentSource, cachedTorrentSource, hlsSource],
    { preferContainer: "mp4" },
  ),
  [hlsSource, cachedTorrentSource, popularUncachedTorrentSource],
  "HLS stays first while an RD-cached torrent outranks container and seeder preferences",
);
assert.deepEqual(
  promoteSelectedSourceWithinCacheTier(
    [
      hlsSource,
      cachedTorrentSource,
      morePopularUncachedTorrentSource,
      popularUncachedTorrentSource,
    ],
    popularUncachedTorrentSource.sourceHash,
  ),
  [
    hlsSource,
    cachedTorrentSource,
    popularUncachedTorrentSource,
    morePopularUncachedTorrentSource,
  ],
  "the playing torrent leads its uncached tier without jumping ahead of HLS or RD-cached sources",
);
assert.match(
  getSourceDisplayHint(cachedTorrentSource),
  /^RD cached \u2022 /,
  "cached torrents should show an instant-ready hint",
);
assert.equal(
  getSourceDisplayHint({ ...hlsSource, realDebridCached: true }),
  "HLS",
  "an HLS entry must not present itself as an RD-cached torrent",
);
assert.equal(
  shouldRefreshRealDebridCachedSources({
    realDebridActive: true,
    attemptCount: 0,
    sources: [popularUncachedTorrentSource],
  }),
  true,
);
assert.equal(
  shouldRefreshRealDebridCachedSources({
    realDebridActive: true,
    attemptCount: 1,
    sources: [popularUncachedTorrentSource],
  }),
  true,
  "a second bounded refresh can observe providers that take up to three seconds",
);
assert.equal(
  shouldRefreshRealDebridCachedSources({
    realDebridActive: true,
    attemptCount: 2,
    sources: [popularUncachedTorrentSource],
  }),
  false,
  "the same page/request identity gets at most two cache refreshes",
);
assert.equal(
  shouldRefreshRealDebridCachedSources({
    realDebridActive: true,
    attemptCount: 0,
    sources: [cachedTorrentSource],
  }),
  false,
);
assert.equal(
  shouldRefreshRealDebridCachedSources({
    realDebridActive: false,
    attemptCount: 0,
    sources: [popularUncachedTorrentSource],
  }),
  false,
);

const scheduledRefreshTimers = [];
const observedRefreshKeys = [];
const refreshController = createRealDebridSourceRefreshController({
  isRealDebridActive: () => true,
  onRefresh: (requestKey) => observedRefreshKeys.push(requestKey),
  delaysMs: [12, 24],
  setTimeoutFn: (callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false };
    scheduledRefreshTimers.push(timer);
    return timer;
  },
  clearTimeoutFn: (timer) => {
    timer.cancelled = true;
  },
});
assert.equal(refreshController.prepareRequest({ requestKey: "episode-1" }), true);
assert.equal(
  refreshController.observeSources({
    requestKey: "episode-1",
    sources: [popularUncachedTorrentSource],
  }),
  true,
);
assert.equal(scheduledRefreshTimers[0].delayMs, 12);
scheduledRefreshTimers[0].callback();
assert.deepEqual(observedRefreshKeys, ["episode-1"]);
assert.equal(
  refreshController.prepareRequest({
    requestKey: "episode-1",
    refreshRequest: true,
    expectedRequestKey: "episode-1",
  }),
  true,
);
assert.equal(
  refreshController.observeSources({
    requestKey: "episode-1",
    refreshRequest: true,
    sources: [popularUncachedTorrentSource],
  }),
  true,
  "a slow or failed first follow-up should schedule the post-provider-window attempt",
);
assert.equal(scheduledRefreshTimers[1].delayMs, 24);
scheduledRefreshTimers[1].callback();
assert.deepEqual(observedRefreshKeys, ["episode-1", "episode-1"]);
assert.equal(
  refreshController.observeSources({
    requestKey: "episode-1",
    refreshRequest: true,
    sources: [popularUncachedTorrentSource],
  }),
  false,
  "the controller must stop after two follow-ups",
);
refreshController.dispose();

console.log("Source menu tab tests passed.");

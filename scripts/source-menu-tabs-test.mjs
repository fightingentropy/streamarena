import assert from "node:assert/strict";
import {
  SOURCE_MENU_HLS_TAB,
  SOURCE_MENU_TORRENTS_TAB,
  buildSourceMenuView,
  shouldIgnoreRememberedTorrentSource,
} from "../src-ui/player/source-menu-tabs.js";

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

const selectedTorrentView = buildSourceMenuView({
  sources,
  selectedSourceHash: torrentSource.sourceHash,
  torrentsEnabled: true,
});
assert.equal(selectedTorrentView.activeTab, SOURCE_MENU_TORRENTS_TAB);
assert.deepEqual(selectedTorrentView.sources, [torrentSource]);
assert.deepEqual(selectedTorrentView.counts, { hls: 1, torrents: 1 });

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

assert.equal(shouldIgnoreRememberedTorrentSource(false, true), true);
assert.equal(shouldIgnoreRememberedTorrentSource(true, true), false);
assert.equal(shouldIgnoreRememberedTorrentSource(true, false), true);

console.log("Source menu tab tests passed.");

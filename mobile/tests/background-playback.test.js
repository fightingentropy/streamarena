const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const appConfig = require("../app.json");
const watchSource = readFileSync(join(__dirname, "../src/app/watch/[id].tsx"), "utf8");
const vlcSource = readFileSync(join(__dirname, "../src/video/VlcVideo.tsx"), "utf8");
const vlcTypes = readFileSync(
  join(__dirname, "../src/video/react-native-vlc-media-player.d.ts"),
  "utf8",
);
const vlcPatch = readFileSync(
  join(__dirname, "../patches/react-native-vlc-media-player+1.0.98.patch"),
  "utf8",
);

test("iOS declares background audio playback", () => {
  assert.ok(appConfig.expo.ios.infoPlist.UIBackgroundModes.includes("audio"));
  const videoPlugin = appConfig.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "react-native-video",
  );
  assert.equal(videoPlugin?.[1]?.enableBackgroundAudio, true);
});

test("native AVPlayer playback continues in the background with PiP and lock-screen controls", () => {
  assert.match(watchSource, /playInBackground=\{iosBackgroundPlayback\}/);
  assert.match(watchSource, /playWhenInactive=\{iosBackgroundPlayback\}/);
  assert.match(watchSource, /enterPictureInPictureOnLeave=\{iosBackgroundPlayback\}/);
  assert.match(watchSource, /showNotificationControls=\{iosBackgroundPlayback\}/);
  assert.match(watchSource, /restoreUserInterfaceForPictureInPictureStopCompleted\(true\)/);
  assert.match(watchSource, /metadata:\s*\{/);
});

test("VLC fallback sources opt into the patched iOS background audio session", () => {
  assert.match(vlcSource, /playInBackground=\{Platform\.OS === "ios"\}/);
  assert.match(vlcTypes, /playInBackground\?: boolean/);
  assert.match(vlcPatch, /RCT_EXPORT_VIEW_PROPERTY\(playInBackground, BOOL\)/);
  assert.match(vlcPatch, /AVAudioSessionCategoryPlayback/);
  assert.match(vlcPatch, /AVAudioSessionModeMoviePlayback/);
});

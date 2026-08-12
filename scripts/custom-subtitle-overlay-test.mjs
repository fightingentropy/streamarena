#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  applyCustomSubtitleText,
  createCustomSubtitleOverlay,
  findSubtitleCueAtTime,
  splitCustomSubtitleLines,
} from "../src-ui/player/custom-subtitle-overlay.js";

assert.deepEqual(splitCustomSubtitleLines(""), []);
assert.deepEqual(splitCustomSubtitleLines("  Hello  "), ["Hello"]);
assert.deepEqual(splitCustomSubtitleLines("Hello\nWorld"), ["Hello", "World"]);
assert.deepEqual(splitCustomSubtitleLines("One\nTwo\nThree"), ["One Two", "Three"]);

const cues = [
  { startSeconds: 1, endSeconds: 2, text: "Hello" },
  { startSeconds: 3, endSeconds: 4, text: "World" },
];
assert.equal(findSubtitleCueAtTime(cues, 1.5), 0);
assert.equal(findSubtitleCueAtTime(cues, 3), 1);
assert.equal(findSubtitleCueAtTime(cues, 2.5), -1);
assert.equal(findSubtitleCueAtTime(cues, 0.5), -1);
assert.equal(findSubtitleCueAtTime([], 1), -1);

function createElement(tag) {
  return { tagName: tag, textContent: "" };
}

function makeOverlay() {
  return {
    hidden: true,
    lang: "",
    childNodes: [],
    get textContent() {
      return this.childNodes
        .map((child) =>
          child.tagName === "br" ? "\n" : String(child.textContent || ""),
        )
        .join("");
    },
    set textContent(value) {
      this.childNodes = value ? [{ tagName: "span", textContent: value }] : [];
    },
    appendChild(child) {
      this.childNodes.push(child);
    },
  };
}

const overlay = makeOverlay();
applyCustomSubtitleText(overlay, "", createElement);
assert.equal(overlay.hidden, true);
assert.equal(overlay.textContent, "");

applyCustomSubtitleText(overlay, "Hello\nWorld", createElement);
assert.equal(overlay.hidden, false);
assert.equal(overlay.childNodes.length, 3);
assert.equal(overlay.childNodes[0].textContent, "Hello");
assert.equal(overlay.childNodes[1].tagName, "br");
assert.equal(overlay.childNodes[2].textContent, "World");

let selectedIndex = 0;
let currentTime = 1.5;
let offsetSeconds = 0;
let playing = false;
const scheduled = [];
const overlayNode = makeOverlay();

const controller = createCustomSubtitleOverlay({
  getOverlay: () => overlayNode,
  getSelectedSubtitleStreamIndex: () => selectedIndex,
  getCurrentTimeSeconds: () => currentTime,
  getOffsetSeconds: () => offsetSeconds,
  isVideoPlaying: () => playing,
  parseCues: () => cues,
  fetchFn: async () => ({
    ok: true,
    text: async () => "WEBVTT\n",
  }),
  now: () => 1,
  requestAnimationFrameFn: (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  },
  cancelAnimationFrameFn: () => {
    scheduled.length = 0;
  },
  createElement,
});

await controller.loadFromTrack({ vttUrl: "/subs.vtt", language: "en" });
assert.equal(overlayNode.lang, "en");
assert.equal(overlayNode.hidden, false);
assert.equal(overlayNode.childNodes[0].textContent, "Hello");

currentTime = 3.2;
controller.invalidateRenderedCue();
controller.render();
assert.equal(overlayNode.childNodes[0].textContent, "World");

offsetSeconds = 1.4;
controller.invalidateRenderedCue();
controller.render();
assert.equal(overlayNode.childNodes[0].textContent, "Hello");

currentTime = 2.5;
offsetSeconds = 0;
controller.render();
assert.equal(overlayNode.hidden, true);

currentTime = 1.5;
controller.render();
assert.equal(overlayNode.hidden, false);
selectedIndex = -1;
controller.render();
assert.equal(overlayNode.hidden, true);

playing = true;
selectedIndex = 0;
currentTime = 1.2;
await controller.loadFromTrack({ vttUrl: "/subs.vtt", language: "fr" });
assert.equal(overlayNode.lang, "fr");
assert.equal(scheduled.length, 1);

controller.startRafLoop();
assert.equal(scheduled.length, 1);
controller.stopRafLoop();
assert.equal(scheduled.length, 0);

let releaseSlow;
const slowReady = new Promise((resolve) => {
  releaseSlow = resolve;
});
const racing = createCustomSubtitleOverlay({
  getOverlay: () => makeOverlay(),
  getSelectedSubtitleStreamIndex: () => 0,
  getCurrentTimeSeconds: () => 1.5,
  getOffsetSeconds: () => 0,
  isVideoPlaying: () => false,
  parseCues: (raw) => [{ startSeconds: 1, endSeconds: 2, text: raw.trim() }],
  fetchFn: async (url) => {
    if (url.includes("slow")) {
      await slowReady;
      return { ok: true, text: async () => "slow" };
    }
    return { ok: true, text: async () => "fast" };
  },
  now: () => 1,
  requestAnimationFrameFn: () => 1,
  cancelAnimationFrameFn: () => {},
  createElement,
});
const slowPromise = racing.loadFromTrack({ vttUrl: "/slow.vtt" });
const fastResult = await racing.loadFromTrack({ vttUrl: "/fast.vtt" });
releaseSlow();
assert.equal(fastResult, true);
assert.equal(await slowPromise, false);

console.log("custom-subtitle-overlay tests passed");

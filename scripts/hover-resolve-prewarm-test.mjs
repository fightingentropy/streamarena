#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildMovieResolvePrewarmUrl,
  buildTvResolvePrewarmUrl,
  buildResolvePrewarmUrl,
  createMovieResolvePrewarmer,
} from "../src-ui/lib/hover-resolve-prewarm.js";

const movieA = {
  tmdbId: "155",
  title: "The Dark Knight",
  year: "2008",
  audioLang: "en",
  subtitleLang: "off",
  quality: "1080p",
};
const movieB = { ...movieA, tmdbId: "157336", title: "Interstellar", year: "2014" };
const movieC = { ...movieA, tmdbId: "24428", title: "The Avengers", year: "2012" };

const url = new URL(buildMovieResolvePrewarmUrl(movieA), "http://localhost");
assert.equal(url.pathname, "/api/resolve/movie");
assert.equal(url.searchParams.get("tmdbId"), "155");
assert.equal(url.searchParams.get("resolverProvider"), "fastest");
assert.equal(url.searchParams.get("subtitleLang"), "off");
assert.equal(url.searchParams.has("sourceHash"), false);
assert.equal(buildMovieResolvePrewarmUrl({ tmdbId: "not-a-tmdb-id" }), "");

const pending = [];
const calls = [];
const prewarmer = createMovieResolvePrewarmer({
  maxConcurrent: 2,
  fetchFn: (requestUrl, options) => {
    calls.push({ requestUrl, options });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  },
});

assert.equal(prewarmer.prewarm(movieA), true);
assert.equal(prewarmer.prewarm(movieA), false, "duplicate hover should share one warm-up");
assert.equal(prewarmer.prewarm(movieB), true);
assert.equal(prewarmer.prewarm(movieC), false, "concurrent warm-ups should be capped");
assert.equal(prewarmer.getActiveCount(), 2);
assert.equal(calls[0].options.keepalive, true);
assert.equal(calls[0].options.credentials, "same-origin");

pending[0].resolve({ ok: true, status: 200 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(prewarmer.getStatus(movieA), "ready");
assert.equal(prewarmer.prewarm(movieC), true);

pending[1].reject(new Error("upstream unavailable"));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(prewarmer.getStatus(movieB), "");
assert.equal(prewarmer.prewarm(movieB), true, "failed warm-ups should be retryable");

const tvEpisode = {
  tmdbId: "1399",
  mediaType: "tv",
  title: "Game of Thrones",
  year: "2011",
  seasonNumber: 2,
  episodeNumber: 3,
  audioLang: "en",
};
const tvUrl = new URL(buildTvResolvePrewarmUrl(tvEpisode), "http://localhost");
assert.equal(tvUrl.pathname, "/api/resolve/tv");
assert.equal(tvUrl.searchParams.get("tmdbId"), "1399");
assert.equal(tvUrl.searchParams.get("seasonNumber"), "2");
assert.equal(tvUrl.searchParams.get("episodeNumber"), "3");
assert.equal(tvUrl.searchParams.get("resolverProvider"), "fastest");
assert.equal(buildTvResolvePrewarmUrl({ tmdbId: "bad" }), "");
assert.equal(
  new URL(buildTvResolvePrewarmUrl({ tmdbId: "1399" }), "http://localhost").searchParams.get(
    "seasonNumber",
  ),
  "1",
  "missing episode context should default to S01E01",
);
assert.equal(buildResolvePrewarmUrl(tvEpisode), buildTvResolvePrewarmUrl(tvEpisode));
assert.equal(buildResolvePrewarmUrl(movieA), buildMovieResolvePrewarmUrl(movieA));

const tvPrewarmer = createMovieResolvePrewarmer({
  buildUrl: buildResolvePrewarmUrl,
  fetchFn: (requestUrl) => {
    calls.push({ requestUrl });
    return Promise.resolve({ ok: true, status: 200 });
  },
});
assert.equal(tvPrewarmer.prewarm(tvEpisode), true);
assert.equal(tvPrewarmer.prewarm(tvEpisode), false, "duplicate TV hover should share one warm-up");
assert.ok(calls.at(-1).requestUrl.startsWith("/api/resolve/tv?"));

console.log("Hover resolve prewarm tests passed.");

#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildMovieResolvePrewarmUrl,
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

console.log("Hover resolve prewarm tests passed.");

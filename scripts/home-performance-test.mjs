#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = Number(process.env.HOME_PERFORMANCE_TEST_PORT || 4191);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROWSER: "none" },
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });
const catalog = (start) => ({ results: Array.from({ length: 14 }, (_, offset) => ({
  id: start + offset, title: `Performance Movie ${start + offset}`, name: `Performance Series ${start + offset}`,
  media_type: "movie", poster_path: `/poster-${start + offset}.jpg`, backdrop_path: `/backdrop-${start + offset}.jpg`,
  overview: "A catalogue item for deterministic browser performance regression checks.", release_date: "2026-01-01", genre_ids: [],
})) });
const bootstrap = { popular: catalog(100), bingeworthy: catalog(200), crowdPleasers: catalog(300), topSeries: catalog(400), criticallyAcclaimed: catalog(500), genres: [], library: { movies: [], series: [] } };
const entry = { sourceIdentity: "tmdb:movie:900", tmdbId: "900", mediaType: "movie", title: "Resume Fixture", resumeSeconds: 120, updatedAt: Date.now(), thumb: "https://image.tmdb.org/t/p/w780/resume-fixture.jpg" };
const json = (payload) => ({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="780" height="439"><rect width="780" height="439" fill="#334455"/></svg>';
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${serverOutput}`);
    try { if ((await fetch(baseUrl)).ok) break; } catch {}
    if (attempt === 79) throw new Error("Timed out waiting for Vite");
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const { mobile, empty } of [{ mobile: false }, { mobile: true }, { mobile: true, empty: true }]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseContinue, releaseDetails;
    const continueGate = new Promise((resolve) => { releaseContinue = resolve; });
    const detailsGate = new Promise((resolve) => { releaseDetails = resolve; });
    const counts = new Map();
    const images = [];
    let myListResponded = false;
    const listWrites = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "image.tmdb.org") {
        images.push(url.href);
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
      }
      if (url.origin !== baseUrl) return route.abort();
      if (url.pathname === "/") {
        const response = await route.fetch();
        const html = (await response.text()).replace("</head>", `<script id="home-bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script></head>`);
        return route.fulfill({ response, body: html });
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
      if (url.pathname === "/api/auth/me") return route.fulfill(json({ id: 991, email: "performance@example.test", emailVerified: true }));
      if (url.pathname === "/api/user/my-list") {
        if (route.request().method() === "PUT") {
          listWrites.push(route.request().postDataJSON());
          return route.fulfill(json({ ok: true }));
        }
        await delay(1500);
        myListResponded = true;
        return route.fulfill(json({ entries: [{ tmdbId: "800", mediaType: "movie", title: "Existing Saved Movie" }] }));
      }
      if (url.pathname === "/api/user/continue-watching") { await continueGate; return route.fulfill(json({ entries: empty ? [] : [entry] })); }
      if (url.pathname === "/api/user/watch-progress") return route.fulfill(json({ entries: [] }));
      if (url.pathname === "/api/tmdb/details") {
        if (url.searchParams.get("tmdbId") === "900") await detailsGate;
        return route.fulfill(json({ title: url.searchParams.get("tmdbId") === "900" ? "Resume Fixture Enriched" : "Performance Movie", runtime: 95, release_date: "2026-01-01", certification: "PG", overview: "A catalogue item for deterministic browser performance regression checks.", videos: { results: [] }, credits: { cast: [] }, genres: [] }));
      }
      if (url.pathname === "/api/home/bootstrap") return route.fulfill(json(bootstrap));
      if (url.pathname === "/api/library") return route.fulfill(json({ movies: [], series: [] }));
      return route.fulfill(json({}));
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#popularRow .card");
    const initialPosition = await page.evaluate(() => ({
      scrollY: window.scrollY,
      heroTop: document.querySelector(".featured-hero").getBoundingClientRect().top,
      headerBottom: document.querySelector(".top-nav").getBoundingClientRect().bottom,
    }));
    assert.equal(initialPosition.scrollY, 0, "Home startup focus must not scroll past the top of the hero");
    assert(initialPosition.heroTop >= initialPosition.headerBottom - 1, "the full hero must start below the fixed header");
    assert.equal(myListResponded, false, "My List must not block the initial Home render");
    await page.waitForFunction(() => !document.querySelector("#continueRow")?.hidden);
    const before = await page.locator("#popularRow").boundingBox();
    assert(before);
    assert.equal(await page.locator(".card-hover-image[src]").count(), 0, "hidden hover previews must not start downloads");
    await page.waitForFunction(() => document.querySelector(".hero-poster")?.complete);
    const initialImages = await page.locator(".card-base img[src]").count();
    const totalImages = await page.locator(".card-base img").count();
    assert(initialImages < totalImages / 2, "initial Home should only load near-visible cards, not every rail");
    await page.locator("#popularRow .card").first().locator(".card-touch-my-list").evaluate((button) => button.click());
    await page.waitForTimeout(50);
    assert.equal(listWrites.length, 0, "a list mutation must wait for the initial server snapshot");
    releaseContinue();
    if (empty) {
      await page.waitForFunction(() => document.querySelector("#continueRow")?.getAttribute("aria-busy") === "false");
      const afterEmpty = await page.locator("#popularRow").boundingBox();
      assert(Math.abs(afterEmpty.y - before.y) < 1, "empty hydration must not collapse the reserved row after paint");
      assert.equal(await page.locator("#continueCards .card").count(), 0);
      releaseDetails();
    } else {
      await page.waitForSelector("#continueCards .card");
      const afterContinue = await page.locator("#popularRow").boundingBox();
      assert(Math.abs(afterContinue.y - before.y) < 1, `Continue hydration moved the popular rail by ${afterContinue.y - before.y}px`);
      await page.evaluate(() => { window.__continueCard = document.querySelector("#continueCards .card"); });
      releaseDetails();
      await page.waitForFunction(() => document.querySelector("#continueCards .card")?.dataset.title === "Resume Fixture Enriched");
      assert(await page.evaluate(() => window.__continueCard === document.querySelector("#continueCards .card")), "metadata enrichment must preserve the existing card node and focus");
      const afterDetails = await page.locator("#popularRow").boundingBox();
      assert(Math.abs(afterDetails.y - afterContinue.y) < 1, "metadata enrichment must preserve rail geometry");
    }
    await page.waitForTimeout(1600);
    await page.waitForFunction(() => {
      const entries = JSON.parse(localStorage.getItem("streamarena-my-list-v1") || "[]");
      return entries.some((entry) => entry.tmdbId === "200") && entries.some((entry) => entry.tmdbId === "800");
    });
    assert.equal(listWrites.length, 1, "the deferred click must write exactly once after hydration");
    assert.deepEqual(new Set(listWrites[0].entries.map((entry) => entry.tmdbId)), new Set(["200", "800"]), "the first mutation must preserve existing saved titles");
    assert.equal(counts.get("/api/home/bootstrap") || 0, 0, "the injected bootstrap must prevent a duplicate fetch");
    assert.equal(counts.get("/api/user/continue-watching"), 1, "Home must reuse authenticated hydration");
    assert.equal(counts.get("/api/library") || 0, 0, "Home must reuse the injected library");
    if (!mobile) {
      const firstCard = page.locator("#popularRow .card").first();
      await firstCard.scrollIntoViewIfNeeded();
      await firstCard.hover();
      await page.waitForTimeout(100);
      assert.equal(await firstCard.locator(".card-hover-image[src]").count(), 0, "brief pointer passes must not load previews");
      await page.mouse.move(1, 1);
      await page.waitForTimeout(450);
      assert.equal(await firstCard.locator(".card-hover-image[src]").count(), 0);
      await firstCard.locator(".card-primary-action").focus();
      await page.waitForFunction(() => Boolean(document.querySelector("#popularRow .card .card-hover-image[src]")));
    }
    await page.locator("#topRatedCardsContainer .card").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    assert(images.length > initialImages, "scrolling must activate artwork in later rails");
    assert.deepEqual(errors, [], "Home should not raise browser errors");
    console.log(`${mobile ? "Mobile" : "Desktop"}${empty ? " empty" : ""} Home: ${initialImages}/${totalImages} card images initially active; no bootstrap/library/CW duplicate; delayed My List does not gate Home; Continue/metadata rail shift <1px.`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

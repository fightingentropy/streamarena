import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = Number(process.env.TITLE_DETAILS_TEST_PORT || 4193);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });
const series = { id: 920, name: "Signal", media_type: "tv", first_air_date: "2020-01-01", poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg", overview: "A signal brings old friends back together.", genre_ids: [] };
const resume = { tmdbId: "920", mediaType: "tv", sourceIdentity: "tmdb:tv:920:s2:e2", title: "Signal", seasonNumber: 2, episodeNumber: 2, resumeSeconds: 120, updatedAt: Date.now() };
const bootstrap = { bingeworthy: { results: [series] }, popular: { results: [] }, topSeries: { results: [] }, genres: [], library: { movies: [], series: [{ id: "local-series", title: "Local Series", episodes: [{ title: "Getting started", src: "/videos/first.mp4" }, { title: "Next steps", src: "/videos/second.mp4" }] }] } };
const details = { ...series, number_of_seasons: 3, seasons: [1, 2, 3].map((number) => ({ season_number: number, episode_count: 3, name: `Season ${number}` })), credits: { cast: [] }, videos: { results: [] }, genres: [] };
const json = (payload, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(payload) });
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="500" height="750" fill="#263e54"/></svg>';
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(baseUrl)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Vite did not start: ${serverOutput}`);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    const seasonRequests = [];
    let resolveRequests = 0;
    let failSeason = true;
    let releaseLate, markLateStarted;
    const lateSeason = new Promise((resolve) => { releaseLate = resolve; });
    const lateStarted = new Promise((resolve) => { markLateStarted = resolve; });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "image.tmdb.org") return route.fulfill({ contentType: "image/svg+xml", body: image });
      if (url.origin !== baseUrl) return route.abort();
      if (url.pathname.startsWith("/watch")) return route.fulfill({ contentType: "text/html", body: "<h1>Playback destination</h1>" });
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/auth/me") return route.fulfill(json({ id: 930, email: "titles@example.test", emailVerified: true }));
      if (url.pathname === "/api/home/bootstrap") return route.fulfill(json(bootstrap));
      if (url.pathname === "/api/library") return route.fulfill(json(bootstrap.library));
      if (url.pathname === "/api/user/continue-watching") return route.fulfill(json({ entries: [resume] }));
      if (url.pathname.startsWith("/api/user/")) return route.fulfill(json({ entries: [] }));
      if (url.pathname === "/api/tmdb/details") return route.fulfill(json(details));
      if (url.pathname === "/api/tmdb/search") return route.fulfill(json({ results: [{ ...series, title: series.name, mediaType: "tv", posterPath: series.poster_path }], genres: [] }));
      if (url.pathname === "/api/tmdb/recommendations") return route.fulfill(json({ results: [] }));
      if (url.pathname.startsWith("/api/resolve/")) resolveRequests++;
      if (url.pathname === "/api/tmdb/tv/season") {
        const seasonNumber = Number(url.searchParams.get("seasonNumber"));
        seasonRequests.push(seasonNumber);
        if (seasonNumber === 2 && failSeason) {
          failSeason = false;
          return route.fulfill(json({ error: "Temporary failure" }, 503));
        }
        if (seasonNumber === 3) { markLateStarted(); await lateSeason; }
        return route.fulfill(json({ seasonNumber, episodes: [1, 2, 3].map((episodeNumber) => ({ seasonNumber, episodeNumber, name: `Chapter ${seasonNumber}.${episodeNumber}`, overview: "An unexpected visitor brings a choice that changes everything.", runtime: 48, stillUrl: "https://image.tmdb.org/t/p/w300/episode.jpg", airDate: episodeNumber === 3 ? "2999-01-01" : "2020-01-01" })) })).catch(() => {});
      }
      return route.fulfill(json({}));
    });

    const card = page.locator('.card:not([data-resume-source])[data-tmdb-id="920"]').first().locator(".card-primary-action");
    await page.goto(baseUrl);
    await card.waitFor();
    await card.click();
    await page.getByRole("dialog", { name: "Signal", exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume S2 E2", exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry episodes", exact: true }).click();
    await page.getByRole("button", { name: "Resume season 2, episode 2: Chapter 2.2", exact: true }).waitFor();
    assert.deepEqual(seasonRequests, [2, 2], "Only the selected season loads, with an explicit retry after failure");
    assert.equal(resolveRequests, 0, "Opening a series must not start playback resolution");

    await page.getByLabel("Season", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Play season 1, episode 1: Chapter 1.1", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Upcoming season 1, episode 3: Chapter 1.3", exact: true }).isDisabled(), true);
    await page.getByLabel("Season", { exact: true }).selectOption("3");
    await lateStarted;
    assert.equal(seasonRequests.at(-1), 3);
    await page.getByLabel("Season", { exact: true }).selectOption("1");
    releaseLate();
    await page.getByRole("button", { name: "Play season 1, episode 1: Chapter 1.1", exact: true }).waitFor();
    await delay(80);
    assert.equal(await page.getByLabel("Season", { exact: true }).inputValue(), "1");
    assert.equal(await page.locator(".details-episode").filter({ hasText: "Chapter 3." }).count(), 0, "A late response must not replace the selected season");
    assert.equal(seasonRequests.filter((season) => season === 1).length, 1, "Revisiting a season reuses its successful response");
    if (mobile) await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.querySelector(".details-sheet").scrollWidth > document.querySelector(".details-sheet").clientWidth), false, "Episode rows fit the dialog on narrow screens");
    await page.locator(".details-episode").last().scrollIntoViewIfNeeded();
    const closeRect = await page.locator("#detailsClose").boundingBox();
    assert.ok(closeRect && closeRect.y >= 0 && closeRect.y + closeRect.height < (mobile ? 700 : 900), "Close stays reachable while browsing episodes");
    const browseY = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Escape");
    await page.locator("#detailsModal").waitFor({ state: "hidden" });
    assert.equal(await card.evaluate((element) => element === document.activeElement), true, "Closing details restores the initiating card");
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - browseY) < 2, "Closing details preserves the browsing position");

    await card.click();
    await page.getByLabel("Season", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Play season 1, episode 2: Chapter 1.2", exact: true }).click();
    await page.waitForURL("**/watch/tv/920/signal/s1e2");
    let params = new URLSearchParams(await page.evaluate(() => sessionStorage.getItem("watch:signal")));
    assert.equal(params.has("resumePlayback"), false, "Selecting another episode clears the old resume intent");
    assert.equal(params.has("src"), false, "Selecting another episode must not reuse the previous source URL");
    await page.goto(baseUrl);
    await card.click();
    await page.getByRole("button", { name: "Resume S2 E2", exact: true }).click();
    await page.waitForURL("**/watch/tv/920/signal/s2e2");
    params = new URLSearchParams(await page.evaluate(() => sessionStorage.getItem("watch:signal")));
    assert.equal(params.get("resumePlayback"), "1");

    await page.goto(baseUrl);
    await page.locator("#openSearchButton").click();
    await page.locator("#navSearchInput").fill("Signal");
    const searchCard = page.getByRole("button", { name: "Details for Signal", exact: true });
    await searchCard.click();
    await page.getByRole("dialog", { name: "Signal", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/", "Search results open details without launching the player");
    await page.keyboard.press("Escape");
    await page.locator("#detailsModal").waitFor({ state: "hidden" });
    assert.equal(await searchCard.evaluate((element) => element === document.activeElement), true);
    await page.goto(baseUrl);
    const localCard = page.locator('#libraryRow .card[data-series-id="local-series"]');
    if (mobile) await localCard.getByRole("button", { name: "More details for Local Series", exact: true }).click();
    else await localCard.locator(".card-primary-action").press("Enter");
    await page.getByRole("button", { name: "Play season 1, episode 2: Next steps", exact: true }).click();
    await page.waitForURL("**/watch?**");
    const localTarget = new URL(page.url());
    assert.equal(localTarget.searchParams.get("src"), "/videos/second.mp4");
    assert.equal(localTarget.searchParams.get("episodeIndex"), "1");
    assert.deepEqual(errors, []);
    console.log(`${mobile ? "Mobile" : "Desktop"}: details-first browsing, resume, selected-season loading/cache, retry, stale-response protection, upcoming episodes, focus/scroll restoration and search passed.`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

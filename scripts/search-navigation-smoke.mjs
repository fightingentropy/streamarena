import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = Number(process.env.SEARCH_TEST_PORT || 4197);
const baseUrl = `http://127.0.0.1:${port}`;
// Use a generated clip so a fresh CI checkout needs no ignored local movies.
const video = "/assets/videos/search-navigation-fixture.mp4";
const clip = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
const server = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });
const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });
const library = { movies: [], series: [] };
const bootstrap = { popular: { results: [] }, bingeworthy: { results: [] }, genres: [], library };
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="500" height="750" fill="#263e54"/></svg>';
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(baseUrl)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Vite did not start: ${output}`);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "image.tmdb.org") return route.fulfill({ contentType: "image/svg+xml", body: image });
      if (url.origin !== baseUrl) return route.abort();
      if (url.pathname === video) return route.fulfill({ contentType: "video/mp4", body: clip });
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/auth/me") return route.fulfill(json({ id: 950, email: "search@example.test", emailVerified: true }));
      if (url.pathname === "/api/home/bootstrap") return route.fulfill(json(bootstrap));
      if (url.pathname === "/api/library") return route.fulfill(json(library));
      if (url.pathname === "/api/user/preferences") return route.fulfill(json({}));
      if (url.pathname.startsWith("/api/user/")) return route.fulfill(json({ entries: [] }));
      if (url.pathname === "/api/tmdb/search") {
        const params = Object.fromEntries(url.searchParams);
        requests.push(params);
        const nextPage = Number(params.page || 1);
        return route.fulfill(json({
          results: Array.from({ length: 24 }, (_, index) => {
            const id = (nextPage - 1) * 24 + index + 1;
            return { id: String(id), mediaType: "movie", title: `Film ${id}`, posterPath: `/film-${id}.jpg`, releaseDate: "2010-01-01" };
          }),
          genres: [{ id: "science-fiction", name: "Science Fiction" }],
          people: [{ id: 525, name: "Christopher Nolan", department: "Directing" }],
          person: params.personId ? { id: 525, name: "Christopher Nolan" } : null,
          page: nextPage, hasMore: nextPage < 3,
        }));
      }
      if (url.pathname === "/api/tmdb/details") return route.fulfill(json({ title: `Film ${url.searchParams.get("tmdbId")}`, overview: "A journey home.", runtime: 110, release_date: "2010-01-01", credits: { cast: [] }, genres: [], videos: { results: [] } }));
      if (url.pathname === "/api/resolve/movie") return route.fulfill(json({ sourceHash: "b".repeat(40), sourceInput: video, playableUrl: video, fallbackUrls: [], tracks: { audioTracks: [{ streamIndex: 0, language: "en", codec: "aac", isDefault: true }], subtitleTracks: [] }, selectedAudioStreamIndex: 0, selectedSubtitleStreamIndex: -1, preferences: { audioLang: "en", subtitleLang: "" }, metadata: { displayTitle: "Film 40", displayYear: "2010" } }));
      if (url.pathname === "/api/resolve/sources") return route.fulfill(json({ sources: [] }));
      return route.fulfill(json({ results: [] }));
    });

    const origin = "/?view=my-list&type=movie&sort=title";
    await page.goto(`${baseUrl}${origin}`);
    await page.locator("#openSearchButton").click();
    await page.locator("#navSearchInput").fill("Christopher Nolan");
    await page.getByRole("button", { name: "Details for Film 1", exact: true }).waitFor();
    await page.getByRole("button", { name: "Christopher Nolan Directing", exact: true }).click();
    await page.getByLabel("Title type", { exact: true }).selectOption("movie");
    await page.getByLabel("Genre", { exact: true }).selectOption("science-fiction");
    await page.getByLabel("Release year", { exact: true }).fill("2010");
    await page.waitForFunction(() => document.querySelector("#searchStatus")?.textContent.includes("Films and series with Christopher Nolan"));
    const searchUrl = page.url();
    const params = new URL(searchUrl).searchParams;
    for (const [key, value] of Object.entries({ search: "1", q: "Christopher Nolan", mediaType: "movie", genre: "science-fiction", year: "2010", personId: "525", view: "my-list", type: "movie", sort: "title" })) assert.equal(params.get(key), value);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    const target = page.getByRole("button", { name: "Details for Film 40", exact: true });
    await target.waitFor();
    await target.scrollIntoViewIfNeeded();
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.ok(scrollY > 500, "The chosen result must be far enough down to test scroll restoration");
    const requestCount = requests.length;
    await target.click();
    await page.locator("#detailsPlay").click();
    await page.waitForURL("**/watch/movie/40/film-40");
    await page.waitForFunction(() => { const video = document.querySelector("video"); return video?.currentTime > 0.3 && video.videoWidth > 0 && !video.error; });
    await page.getByRole("button", { name: "Back to browse", exact: true }).click();
    await page.waitForURL(searchUrl);
    await target.waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset.searchKey === "movie:40");
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY) < 3, "Player Back restores the selected row's scroll position");
    assert.equal(await page.locator("#searchResultsGrid > button").count(), 48);
    assert.equal(await page.getByLabel("Genre", { exact: true }).inputValue(), "science-fiction");
    assert.equal(await page.getByLabel("Title type", { exact: true }).inputValue(), "movie");
    assert.equal(await page.getByLabel("Release year", { exact: true }).inputValue(), "2010");
    assert.equal(await page.locator("#navSearchInput").inputValue(), "Christopher Nolan");
    assert.equal(requests.length, requestCount, "Returning to loaded search pages does not repeat catalogue requests");

    await page.reload();
    await target.waitFor();
    assert.equal(await page.locator("#searchResultsGrid > button").count(), 48);
    assert.equal(requests.length, requestCount, "Reload retains the loaded result pages");
    await page.locator("#closeSearchButton").click();
    await page.waitForURL(`${baseUrl}${origin}`);
    await page.locator("#myListView").waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Sort My List").inputValue(), "title");
    await page.goForward();
    await page.waitForURL(searchUrl);
    await target.waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset.searchKey === "movie:40");
    await page.locator("#closeSearchButton").click();
    await page.waitForURL(`${baseUrl}${origin}`);
    await page.locator("#openSearchButton").click();
    await page.waitForFunction(() => document.activeElement?.id === "navSearchInput");
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByRole("button", { name: "Details for Film 72", exact: true }).waitFor();
    assert.equal(requests.at(-1).page, "3", "Pagination resumes after the last restored page");

    // A shared link has no cached results or preceding Search history entry.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${baseUrl}/?search=1&mediaType=tv&genre=science-fiction`);
    await page.getByRole("button", { name: "Details for Film 1", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Title type", { exact: true }).inputValue(), "tv");
    assert.equal(await page.getByLabel("Genre", { exact: true }).inputValue(), "science-fiction");
    assert.equal(requests.at(-1).query, "");
    if (mobile) await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.locator("#closeSearchButton").click();
    assert.equal(page.url(), `${baseUrl}/`);
    assert.deepEqual(errors, []);
    console.log(`${mobile ? "Mobile" : "Desktop"}: actual playback and Back, full filter/pagination/scroll/focus restoration, request reuse, reload, history, shared/empty search and narrow layout passed.`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

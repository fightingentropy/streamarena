import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = Number(process.env.MY_LIST_TEST_PORT || 4196);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="500" height="750" fill="#263e54"/></svg>';
const initialEntries = [
  { title: "Arrival", tmdbId: "901", mediaType: "movie", year: "2016", addedAt: 1, thumb: "https://image.tmdb.org/t/p/w500/arrival.jpg" },
  { title: "Signal", tmdbId: "902", mediaType: "tv", year: "2020", addedAt: 2, thumb: "https://image.tmdb.org/t/p/w500/signal.jpg" },
  { title: "Zodiac", tmdbId: "903", mediaType: "movie", year: "2007", addedAt: 3, thumb: "https://image.tmdb.org/t/p/w500/zodiac.jpg" },
];
const library = { movies: [{ title: "Local Film", id: "local-only", src: "/videos/local.mp4", thumb: "/assets/images/thumbnail.jpg" }], series: [] };
const bootstrap = { popular: { results: [{ id: 901, title: "Arrival", media_type: "movie", poster_path: "/arrival.jpg" }] }, bingeworthy: { results: [] }, genres: [], library };
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
    const writes = [];
    let entries = structuredClone(initialEntries);
    let failSave = false;
    let failLoad = false;
    let releaseLoad;
    let delayedLoad = new Promise((resolve) => { releaseLoad = resolve; });
    let releaseSave;
    let delayedSave;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "image.tmdb.org") return route.fulfill({ contentType: "image/svg+xml", body: image });
      if (url.origin !== baseUrl) return route.abort();
      if (url.pathname.startsWith("/watch")) return route.fulfill({ contentType: "text/html", body: "<h1>Playback destination</h1>" });
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/auth/me") return route.fulfill(json({ id: 940, email: "list@example.test", emailVerified: true }));
      if (url.pathname === "/api/home/bootstrap") return route.fulfill(json(bootstrap));
      if (url.pathname === "/api/library") return route.fulfill(json(library));
      if (url.pathname === "/api/user/my-list") {
        if (route.request().method() === "PUT") {
          writes.push(route.request().postDataJSON());
          if (delayedSave) await delayedSave;
          if (failSave) return route.fulfill(json({ error: "Unavailable" }, 503));
          entries = writes.at(-1).entries;
          return route.fulfill(json({ ok: true }));
        }
        if (delayedLoad) await delayedLoad;
        return route.fulfill(json({ entries }, failLoad ? 503 : 200));
      }
      if (url.pathname.startsWith("/api/user/")) return route.fulfill(json({ entries: [] }));
      if (url.pathname === "/api/tmdb/details") return route.fulfill(json({ title: "Arrival", overview: "A discovery changes everything.", runtime: 116, release_date: "2016-01-01", credits: { cast: [] }, genres: [], videos: { results: [] } }));
      if (url.pathname === "/api/tmdb/recommendations") return route.fulfill(json({ results: [] }));
      return route.fulfill(json({ results: [] }));
    });
    await page.goto(`${baseUrl}/?view=my-list`);
    await page.getByText("Loading your list…", { exact: true }).waitFor();
    assert.equal(await page.locator(".my-list-empty").count(), 0, "Pending account state must not look like an empty list");
    releaseLoad(); delayedLoad = null;
    await page.waitForFunction(() => document.querySelectorAll(".saved-title").length === 3);
    assert.equal(writes.length, 0, "Rendering and local-library enrichment must not rewrite the saved list");
    assert.equal(await page.locator("#navMyList").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".featured-hero").isVisible(), false);
    assert.equal(await page.locator("#myListView").getByText("Local Film").count(), 0, "Unsaved local files belong in Local library");
    const titles = () => page.locator(".saved-title-open strong").allTextContents();
    assert.deepEqual(await titles(), ["Zodiac", "Signal", "Arrival"]);

    await page.getByRole("group", { name: "Filter My List" }).getByRole("button", { name: "Movies", exact: true }).click();
    await page.getByLabel("Sort My List").selectOption("title");
    assert.deepEqual(await titles(), ["Arrival", "Zodiac"]);
    assert.match(page.url(), /view=my-list&type=movie&sort=title/);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".saved-title").length === 2);
    assert.equal(await page.getByLabel("Sort My List").inputValue(), "title");
    assert.deepEqual(await titles(), ["Arrival", "Zodiac"]);
    await page.getByLabel("Sort My List").selectOption("year");
    assert.deepEqual(await titles(), ["Arrival", "Zodiac"]);
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.locator("#libraryRow").getByRole("button", { name: "Details for Local Film", exact: true }).waitFor();
    assert.equal(await page.locator("#myListRow").getByText("Local Film").count(), 0);
    await page.goBack();
    await page.locator("#myListView").waitFor({ state: "visible" });
    assert.deepEqual(await titles(), ["Arrival", "Zodiac"]);
    await page.locator("#openSearchButton").click();
    assert.equal(await page.locator("#myListView").isVisible(), false);
    await page.locator("#closeSearchButton").click();
    assert.equal(await page.locator("#myListView").isVisible(), true);

    await page.locator("#myListView").getByRole("button", { name: "Details for Arrival", exact: true }).click();
    await page.locator("#detailsPlay").click();
    await page.waitForURL("**/watch/movie/901/arrival");
    const params = new URLSearchParams(await page.evaluate(() => sessionStorage.getItem("watch:arrival")));
    assert.equal(params.get("returnTo"), "/?view=my-list&type=movie&sort=year");
    await page.goto(`${baseUrl}${params.get("returnTo")}`);
    const removeArrival = page.getByRole("button", { name: "Remove Arrival from My List", exact: true });
    await removeArrival.waitFor();
    failSave = true;
    await removeArrival.click();
    await page.getByText("Couldn’t save your list. Please try again.", { exact: true }).first().waitFor();
    assert.deepEqual(await titles(), ["Arrival", "Zodiac"], "Failed persistence must keep the saved title visible");
    assert.equal(await removeArrival.isEnabled(), true);
    failSave = false;
    delayedSave = new Promise((resolve) => { releaseSave = resolve; });
    const writesBefore = writes.length;
    await removeArrival.click();
    await page.waitForFunction(() => document.querySelector(".saved-title-remove")?.disabled);
    assert.equal(await page.getByRole("button", { name: "Remove Zodiac from My List", exact: true }).isDisabled(), true, "Pending writes prevent conflicting full-list updates");
    releaseSave(); delayedSave = null;
    await page.waitForFunction(() => document.querySelectorAll(".saved-title").length === 1);
    assert.equal(writes.length, writesBefore + 1);
    assert.deepEqual(entries.map((entry) => entry.title).sort(), ["Signal", "Zodiac"]);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Details for Zodiac");

    if (mobile) await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "My List fits narrow screens without horizontal page scrolling");
    const navBox = await page.locator("#navMyList").boundingBox();
    assert.ok(navBox && navBox.x >= 0 && navBox.x + navBox.width <= (mobile ? 320 : 1280));
    await page.getByRole("button", { name: "Remove Zodiac from My List", exact: true }).click();
    await page.getByRole("heading", { name: "No movies saved yet", exact: true }).waitFor();
    await page.getByRole("group", { name: "Filter My List" }).getByRole("button", { name: "All titles", exact: true }).click();
    await page.getByRole("button", { name: "Remove Signal from My List", exact: true }).click();
    await page.getByRole("heading", { name: "Make room for your next favorite", exact: true }).waitFor();

    failLoad = true;
    await page.reload();
    await page.getByRole("button", { name: "Retry My List", exact: true }).waitFor();
    assert.equal(await page.locator(".my-list-empty").count(), 0, "Unavailable account state must not look like an empty list");
    entries = structuredClone(initialEntries);
    failLoad = false;
    await page.getByRole("button", { name: "Retry My List", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".saved-title").length === 3);

    entries = Array.from({ length: 100 }, (_, index) => ({ ...initialEntries[0], title: `Saved ${index + 1}`, tmdbId: String(1000 + index), addedAt: index + 1 }));
    await page.goto(baseUrl);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("streamarena-my-list-v1") || "[]").length === 100);
    await page.locator("#cardsContainer").getByRole("button", { name: "Details for Arrival", exact: true }).click();
    const writesAtLimit = writes.length;
    await page.locator("#detailsMyList").click();
    await page.getByText("Your list has 100 titles. Remove one before adding another.", { exact: true }).last().waitFor();
    assert.equal(writes.length, writesAtLimit, "A full list must not silently evict an existing title");
    assert.equal(entries.length, 100);
    assert.deepEqual(errors, []);
    console.log(`${mobile ? "Mobile" : "Desktop"}: My List loading/retry, saved-only content, filtering/sorting/history, player return, failed/concurrent writes, empty states and focus passed.`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

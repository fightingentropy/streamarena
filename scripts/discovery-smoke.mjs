import assert from "node:assert/strict";

export function createDiscoverySmoke(page) {
  let failSearch = true;
  let failDetails = true;
  const requests = [];
  const movie = { id: "901", mediaType: "movie", title: "Related Film", releaseDate: "2010-01-01", posterPath: "/poster.jpg", backdropPath: "/backdrop.jpg" };
  const genres = [{ id: "science-fiction", name: "Science Fiction" }];
  const respond = (route, payload, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
  return {
    async route(route) {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/tmdb/search") {
        const q = url.searchParams.get("query") || "";
        requests.push(Object.fromEntries(url.searchParams));
        if (q === "Retry test" && failSearch) {
          failSearch = false;
          await respond(route, { error: "Temporary failure" }, 503);
        } else {
          const nextPage = Number(url.searchParams.get("page") || 1);
          const nolan = q === "Christopher Nolan";
          await respond(route, {
            query: q, genres, imageBase: "https://image.tmdb.org/t/p", page: nextPage,
            hasMore: nextPage === 1,
            people: nolan ? [{ id: 525, name: q, department: "Directing" }] : [],
            person: nolan ? { id: 525, name: q } : null,
            results: [{ ...movie, id: nextPage === 1 ? "901" : "902", title: nolan ? "Inception" : nextPage === 1 ? "Search Film" : "Next Page Film" }],
          });
        }
        return true;
      }
      if (url.pathname === "/api/tmdb/recommendations") {
        await respond(route, { results: url.searchParams.get("tmdbId") === "901" ? [] : [movie] });
        return true;
      }
      if (url.pathname === "/api/tmdb/details" && url.searchParams.get("tmdbId") === "901") {
        if (failDetails) {
          failDetails = false;
          await respond(route, { error: "Temporary failure" }, 503);
        } else {
          await respond(route, { id: 901, title: "Related Film", release_date: "2010-01-01", runtime: 110, credits: { cast: [{ name: "Recovered Actor" }] } });
        }
        return true;
      }
      return false;
    },
    async verify() {
      await page.waitForSelector(".has-continue-watching #continueCards .continue-caption");
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        const layout = await page.evaluate(() => ({
          bottom: document.querySelector("#continueCards .continue-caption").getBoundingClientRect().bottom,
          height: window.innerHeight,
          caption: document.querySelector("#continueCards .continue-caption").textContent,
          fakeProgress: !!document.querySelector("#continueCards progress"),
          recentBadges: document.querySelectorAll(".card-recent-badge").length,
        }));
        assert.ok(layout.bottom < layout.height, `Continue Watching must be visible: ${JSON.stringify(layout)}`);
        assert.match(layout.caption, /2 min watched/);
        assert.equal(layout.fakeProgress, false, "Unknown duration must not show invented progress");
        assert.equal(layout.recentBadges, 0, "Popularity must not imply recently added");
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator("#heroMotionToggle").click();
      assert.equal(await page.locator("#heroMotionToggle").getAttribute("aria-label"), "Resume previews");
      assert.equal(await page.locator("#heroMotionToggle").getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => !document.querySelector(".featured-hero").classList.contains("is-preview-playing"));
      await page.locator("#heroMotionToggle").click();
      assert.equal(await page.locator("#heroMotionToggle").getAttribute("aria-label"), "Pause previews");

      await page.locator("#heroInfo").click();
      await page.getByRole("button", { name: "Open Related Film", exact: true }).click();
      assert.ok(page.url().endsWith("/index.html"), "Related titles must open details");
      await page.getByRole("button", { name: "Retry details", exact: true }).waitFor();
      assert.equal(await page.locator("#detailsQuality").isVisible(), false);
      assert.equal(await page.locator("#detailsAudio").isVisible(), false);
      await page.getByRole("button", { name: "Retry details", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#detailsCast")?.textContent.includes("Recovered Actor"));
      await page.locator("#detailsClose").click();
      await page.locator("#openSearchButton").click();
      await page.locator("#navSearchInput").fill("Retry test");
      await page.getByRole("button", { name: "Retry search", exact: true }).waitFor();
      assert.equal(await page.locator("#navSearchInput").inputValue(), "Retry test");
      await page.getByRole("button", { name: "Retry search", exact: true }).click();
      await page.getByRole("button", { name: "Play Search Film", exact: true }).waitFor();
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await page.getByRole("button", { name: "Play Next Page Film", exact: true }).waitFor();
      assert.equal(await page.locator("#searchResultsGrid > button").count(), 2);

      await page.locator("#navSearchInput").fill("Christopher Nolan");
      await page.getByRole("button", { name: "Play Inception", exact: true }).waitFor();
      assert.match(await page.locator("#searchStatus").textContent(), /Films and series with Christopher Nolan/);
      await page.getByLabel("Title type", { exact: true }).selectOption("movie");
      await page.getByLabel("Genre", { exact: true }).selectOption("science-fiction");
      await page.getByLabel("Release year", { exact: true }).fill("2010");
      await page.waitForResponse((response) => response.url().includes("/api/tmdb/search?") && response.url().includes("year=2010"));
      assert.ok(requests.some((request) => request.query === "Christopher Nolan" && request.mediaType === "movie" && request.genre === "science-fiction" && request.year === "2010"));
      await page.getByRole("button", { name: /Christopher Nolan Directing/ }).click();
      await page.locator("#navSearchInput").fill("");
      await page.getByRole("button", { name: "Christopher Nolan", exact: true }).waitFor();
      await page.setViewportSize({ width: 320, height: 700 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "Search filters must fit narrow screens");
    },
  };
}

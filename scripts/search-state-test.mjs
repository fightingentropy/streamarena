import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchState, readSearchLocation, readSearchSnapshot, searchLocation, writeSearchSnapshot } from "../src-ui/lib/search-state.js";

const filters = { query: "Christopher Nolan", mediaType: "movie", genre: "science-fiction", year: "2010", personId: "525" };
const results = { results: [{ id: 27205, title: "Inception", mediaType: "movie" }], genres: [], page: 2, hasMore: true, scrollY: 950, selectedKey: "movie:27205" };
function storage() {
  let value = null;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}

test("search links preserve all filters and the underlying My List view", () => {
  const origin = "/?view=my-list&type=tv&sort=title#saved";
  const location = searchLocation(origin, filters);
  assert.deepEqual(readSearchLocation(location), { active: true, state: filters });
  assert.equal(searchLocation(location, filters, false), origin);
  assert.deepEqual(readSearchLocation("/?q=Arrival").state, normalizeSearchState({ query: "Arrival" }));
  assert.equal(readSearchLocation("/?q=Arrival").active, true, "Existing query-only links still work");
});

test("empty discovery searches stay open after reload and use Home from Live", () => {
  const location = searchLocation("/live", { mediaType: "tv" });
  assert.equal(location, "/?search=1&mediaType=tv");
  assert.equal(readSearchLocation(location).active, true);
  assert.equal(readSearchLocation("/?view=my-list").active, false);
  assert.equal(searchLocation("/live.html", {}), "/?search=1");
});

test("incomplete year input is retained while unknown values are normalized", () => {
  assert.deepEqual(normalizeSearchState({ query: "  Arrival  ", mediaType: "unknown", year: "20ab1", personId: "invalid" }), { query: "Arrival", mediaType: "all", genre: "", year: "201", personId: "" });
});

test("return snapshots require the same account and search and expire after six hours", () => {
  const cache = storage();
  writeSearchSnapshot(filters, results, 42, cache, 1000);
  assert.deepEqual(readSearchSnapshot(filters, "42", cache, 2000), results);
  assert.equal(readSearchSnapshot(filters, 43, cache, 2000), null);
  assert.equal(readSearchSnapshot(filters, null, cache, 2000), null);
  assert.equal(readSearchSnapshot({ ...filters, year: "2014" }, 42, cache, 2000), null);
  assert.equal(readSearchSnapshot(filters, 42, cache, 999), null);
  assert.equal(readSearchSnapshot(filters, 42, cache, 1000 + 6 * 60 * 60 * 1000 + 1), null);
});

test("corrupt, oversized, and unavailable storage fall back to fetching results", () => {
  const cache = storage();
  cache.setItem("", "{bad json");
  assert.equal(readSearchSnapshot(filters, 42, cache), null);
  writeSearchSnapshot(filters, { ...results, page: 0 }, 42, cache);
  assert.equal(readSearchSnapshot(filters, 42, cache), null);
  writeSearchSnapshot(filters, { ...results, results: [{ title: "x".repeat(1_000_001) }] }, 42, cache);
  assert.equal(readSearchSnapshot(filters, 42, cache), null);
  const denied = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } };
  assert.doesNotThrow(() => writeSearchSnapshot(filters, results, 42, denied));
  assert.equal(readSearchSnapshot(filters, 42, denied), null);
});

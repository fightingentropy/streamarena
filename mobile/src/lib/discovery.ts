import { useCallback, useEffect, useRef, useState } from "react";
import { getIsOnline } from "@/lib/connectivity";
import { storage } from "@/lib/storage";
import { normalizeSearchTitle, searchTitles, type SearchFilters, type SearchResponse, type Title } from "@/lib/streamarena";

export function readRecentSearches(scope: string): string[] {
  try {
    const entries = JSON.parse(storage.getItem(`recent-searches:${scope}`) || "[]");
    return Array.isArray(entries) ? entries.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch { return []; }
}

export function rememberSearch(scope: string, query: string): string[] {
  const text = query.trim();
  if (text.length < 2) return readRecentSearches(scope);
  const next = [text, ...readRecentSearches(scope).filter((item) => item.toLowerCase() !== text.toLowerCase())].slice(0, 8);
  storage.setItem(`recent-searches:${scope}`, JSON.stringify(next));
  return next;
}

export function clearRecentSearches(scope: string) {
  storage.removeItem(`recent-searches:${scope}`);
}

export function useDiscovery(query: string, filters: SearchFilters, scope: string) {
  const [results, setResults] = useState<Title[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const failedPage = useRef(1);
  const { mediaType = "all", genre = "", year = "", personId = "" } = filters;

  const load = useCallback(async (nextPage = 1) => {
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    const request = ++sequence.current;
    failedPage.current = nextPage;
    setLoading(true);
    setError(null);
    try {
      const data = await searchTitles(query.trim(), 40, pending.signal, { mediaType, genre, year, personId, page: nextPage });
      if (pending.signal.aborted || request !== sequence.current) return;
      setResults((previous) => {
        const initial = nextPage === 1 ? [] : previous;
        const seen = new Set(initial.map((item) => `${item.mediaType}:${item.id}`));
        return [...initial, ...data.results.map(normalizeSearchTitle).filter((item) => {
          const key = `${item.mediaType}:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })];
      });
      setResponse(data);
      setPage(nextPage);
    } catch {
      if (pending.signal.aborted || request !== sequence.current) return;
      setError(getIsOnline() ? "Search couldn’t load. Please try again." : "You’re offline. Reconnect and try again.");
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [query, mediaType, genre, year, personId]);

  useEffect(() => {
    sequence.current += 1;
    controller.current?.abort();
    setResults([]);
    setResponse((previous) => previous ? { ...previous, people: [], person: null, hasMore: false } : null);
    setError(null);
    setLoading(false);
    setPage(1);
    if (query.trim().length === 1 || (year && !/^\d{4}$/.test(year))) return;
    setLoading(true);
    const timer = setTimeout(() => void load(), 300);
    return () => {
      clearTimeout(timer);
      sequence.current += 1;
      controller.current?.abort();
    };
  }, [load, query, year, scope]);

  return { results, response, loading, error, loadMore: () => load(page + 1), retry: () => load(failedPage.current) };
}

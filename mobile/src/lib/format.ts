import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// NativeWind consumes the merged className; tailwind-merge dedupes conflicts.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatTime(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return "--:--";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const two = (n: number) => n.toString().padStart(2, "0");
  return hrs > 0 ? `${hrs}:${two(mins)}:${two(secs)}` : `${mins}:${two(secs)}`;
}

// "2h 14m" / "47m" from a minute count (TMDB runtime). Empty string when unknown.
export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Year from a "YYYY-MM-DD" TMDB date string.
export function formatYear(date: string | null | undefined): string {
  if (!date) return "";
  const m = /^(\d{4})/.exec(date);
  return m ? m[1] : "";
}

// TMDB vote_average (0..10) → "8.4" rating label, or "" when unrated.
export function formatRating(vote: number | null | undefined): string {
  if (!vote || vote <= 0) return "";
  return vote.toFixed(1);
}

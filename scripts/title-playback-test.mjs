import assert from "node:assert/strict";
import test from "node:test";
import { episodePlaybackTarget, findTitleResume, titlePlaybackTarget } from "../src-ui/lib/title-playback.js";

const title = { tmdbId: "1399", mediaType: "tv", title: "A series", src: "/videos/first.mp4", librarySrc: "/videos/first.mp4" };
const resume = { tmdbId: "1399", mediaType: "tv", sourceIdentity: "tmdb:tv:1399:s2:e3", seasonNumber: 2, episodeNumber: 3, episodeIndex: 12, resumeSeconds: 120, src: "" };

test("a catalogue title resumes its saved episode without reusing a different local file", () => {
  const target = titlePlaybackTarget(title, findTitleResume(title, [resume]));
  assert.equal(target.seasonNumber, 2);
  assert.equal(target.episodeNumber, 3);
  assert.equal(target.resumeSource, resume.sourceIdentity);
  assert.equal(target.src, "");
  assert.equal(target.librarySrc, "");
  assert.equal(target.title, title.title);
});

test("movies and series sharing a numeric TMDB ID never share resume state", () => {
  assert.equal(findTitleResume({ tmdbId: "1399", mediaType: "movie" }, [resume]), null);
});

test("choosing a different episode clears the saved episode source and identity", () => {
  const target = episodePlaybackTarget({ ...title, ...resume, resumeSource: resume.sourceIdentity }, { seasonNumber: 1, episodeNumber: 4, name: "Fourth episode" });
  assert.equal(target.seasonNumber, 1);
  assert.equal(target.episodeNumber, 4);
  assert.equal(target.episode, "Fourth episode");
  assert.equal(target.episodeIndex, -1);
  assert.equal(target.src, "");
  assert.equal(target.librarySrc, "");
  assert.equal(target.resumeSource, "");
});

test("local episodes retain their own file and catalogue index", () => {
  const target = episodePlaybackTarget(title, { seasonNumber: 2, episodeNumber: 1, episodeIndex: 8, src: "/videos/second-season.mp4", title: "Season premiere" });
  assert.equal(target.src, "/videos/second-season.mp4");
  assert.equal(target.episodeIndex, 8);
  assert.equal(target.episode, "Season premiere");
});

test("local series and movies resume by their stable identity", () => {
  const local = { seriesId: "local-series", src: "/videos/second.mp4", sourceIdentity: "series:local-series:episode:2", resumeSeconds: 90 };
  assert.equal(findTitleResume({ seriesId: "local-series" }, [local]), local);
  assert.equal(findTitleResume({ src: "/videos/second.mp4" }, [local]), local);
});

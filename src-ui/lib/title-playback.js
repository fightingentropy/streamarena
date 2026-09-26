// A catalogue title and its saved episode are different navigation targets.
// Keep source/resume state out of the shared TMDB metadata cache.
export function findTitleResume(title, entries) {
  const mediaType = title.mediaType || (title.seriesId ? "tv" : "movie");
  return entries.find((entry) => {
    if (title.tmdbId && entry.tmdbId) {
      return String(title.tmdbId) === String(entry.tmdbId) && mediaType === entry.mediaType;
    }
    if (title.seriesId) return title.seriesId === entry.seriesId;
    const source = title.src || title.librarySrc;
    return Boolean(source && (source === entry.src || source === entry.sourceIdentity));
  }) || null;
}

export function titlePlaybackTarget(title, resume) {
  if (!resume) return title;
  return {
    ...title,
    src: resume.src || "",
    librarySrc: "",
    episode: resume.episode || "",
    seriesId: resume.seriesId || title.seriesId || "",
    episodeIndex: resume.episodeIndex ?? -1,
    seasonNumber: resume.seasonNumber || 0,
    episodeNumber: resume.episodeNumber || 0,
    resumeSource: resume.sourceIdentity,
  };
}

export function episodePlaybackTarget(title, episode) {
  return {
    ...title,
    src: episode.src || "",
    librarySrc: "",
    episode: episode.name || episode.title || `Episode ${episode.episodeNumber}`,
    episodeIndex: episode.episodeIndex ?? -1,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    // Choosing a different episode must never reuse the title's saved source.
    resumeSource: "",
  };
}

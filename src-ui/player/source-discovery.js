export function buildTmdbSourceDiscoveryQuery({
  tmdbId = "",
  mediaType = "movie",
  title = "",
  year = "",
  audioLang = "auto",
  quality = "auto",
  resolverProvider = "fastest",
  resultLimit = 0,
  seasonNumber = 0,
  episodeNumber = 0,
  preferredContainer = "",
  pinnedSourceHash = "",
  minSeeders = 0,
  preferredSourceFormats = [],
  supportedSourceFormats = [],
  sourceLanguage = "auto",
  sourceAudioProfile = "auto",
} = {}) {
  const query = new URLSearchParams({
    tmdbId,
    mediaType,
    title,
    year,
    audioLang,
    quality,
    resolverProvider,
    limit: String(resultLimit),
  });
  if (mediaType === "tv") {
    query.set("seasonNumber", String(seasonNumber));
    query.set("episodeNumber", String(episodeNumber));
    if (preferredContainer) query.set("preferredContainer", preferredContainer);
  }
  if (pinnedSourceHash) {
    query.set("sourceHash", pinnedSourceHash);
    return query;
  }
  if (minSeeders > 0) query.set("minSeeders", String(minSeeders));
  if (
    preferredSourceFormats.length > 0 &&
    preferredSourceFormats.length < supportedSourceFormats.length
  ) {
    query.set("allowedFormats", preferredSourceFormats.join(","));
  }
  query.set("sourceLang", sourceLanguage);
  query.set("sourceAudioProfile", sourceAudioProfile);
  return query;
}

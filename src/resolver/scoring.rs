use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::utils::{normalize_preferred_audio_lang, normalize_preferred_stream_quality};

use super::{
    DEFAULT_ALLOWED_SOURCE_FORMATS, DiscoveryStream, ResolveMetadata, SOURCE_AUDIO_PROFILE_DEFAULT,
    SOURCE_HEALTH_AVOID_SCORE, SOURCE_LANGUAGE_FILTER_DEFAULT, SourceFilters, SourceSummary,
    audio_language_tokens, build_stream_release_text, build_stream_text, build_stream_text_raw,
    count_matching_title_tokens, get_stream_info_hash, has_explicit_multi_audio_marker,
    normalize_episode_ordinal, normalize_preferred_container,
    normalize_source_audio_profile_filter, normalize_source_hash, normalize_source_language_filter,
    normalize_text_for_match, normalize_whitespace, prefer_episode_title_matched_candidates,
    prefer_movie_title_matched_candidates, stream_quality_target, tokenize_title_for_match,
};

#[cfg(test)]
use super::FASTEST_PARALLEL_CANDIDATES;

static SEED_COUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*([0-9.,]+)").expect("valid seed regex"));
static STREAM_SIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([^\n⚙👤]+)").expect("valid stream size regex"));
static STREAM_RELEASE_GROUP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"⚙\s*([^\n👤]+)").expect("valid release group regex"));
static HXH_SEASON_EPISODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bs(?:eason\s*)?0*(\d{1,2})\s*[-_. ]?e(?:pisode\s*)?0*(\d{1,3})\b")
        .expect("valid episode regex")
});
static X_SEASON_EPISODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b0*(\d{1,2})x0*(\d{1,3})\b").expect("valid x episode regex"));
static EPISODE_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:e|ep|episode)\s*[-_. ]?0*(\d{1,3})\b").expect("valid episode-only regex")
});
/// Matches season-level (pack) releases with no usable episode signature, e.g.
/// "Show Season 2", "Show.S02.1080p", "Show S02 Complete", "Seasons 1-5".
/// Only consulted when NO episode signature was found in the text, so true
/// single-episode releases (which carry SxxExx / NxN / "Episode N") and
/// signature-less generic releases never hit the bare `sNN` alternative.
static SEASON_PACK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:seasons?\s*0*\d{1,2}|s0*\d{1,2}|complete\s+(?:season|series)|full\s+season|season\s+complete)\b",
    )
    .expect("valid season pack regex")
});
static HMS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b").expect("valid hms runtime regex")
});
static HOURS_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*h(?:ours?)?\b").expect("valid hours runtime regex")
});
static MINUTES_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\b").expect("valid minutes runtime regex")
});
static COMPACT_RUNTIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2})h(?:\s*|)(\d{1,2})m\b").expect("valid compact runtime regex")
});
static LOW_QUALITY_THEATRICAL_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:hdts|telesync|ts|telecine|tc|hdcam|camrip|cam)\b")
        .expect("valid low quality theatrical release regex")
});
static LOW_QUALITY_SCREENER_RELEASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:dvdscr|dvdscreener|screener|workprint)\b")
        .expect("valid low quality screener release regex")
});

static RESOLUTION_2160_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(2160p|4k|uhd)\b").expect("valid 2160 regex"));
static RESOLUTION_1080_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(1080p|full\s*hd)\b").expect("valid 1080 regex"));
static RESOLUTION_720_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b720p\b").expect("valid 720 regex"));
static RESOLUTION_480_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(480p|sd)\b").expect("valid 480 regex"));

#[allow(clippy::too_many_arguments)]
pub(super) fn select_top_movie_candidates<'a>(
    streams: &'a [DiscoveryStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let title_filtered = prefer_movie_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered = filter_streams_by_quality_preference(title_filtered, preferred_quality);
    let sorted = sort_movie_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let capped = sorted
        .iter()
        .copied()
        .take(limit.max(1))
        .collect::<Vec<_>>();
    let selected = prioritize_candidates_by_source_hash(capped, sorted.clone(), source_hash, limit);
    apply_mp4_default_candidate_rule(
        selected,
        sorted,
        source_hash,
        limit,
        &source_filters.source_language,
        health_scores,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn select_top_episode_candidates<'a>(
    streams: &'a [DiscoveryStream],
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    preferred_container: &str,
    source_hash: &str,
    limit: usize,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let ranked_pool = streams
        .iter()
        .filter(|stream| !get_stream_info_hash(stream).is_empty())
        .collect::<Vec<_>>();
    let filtered_pool = apply_source_stream_filters(ranked_pool, source_filters);
    if filtered_pool.is_empty() {
        return Vec::new();
    }
    let episode_filtered = prefer_episode_title_matched_candidates(filtered_pool, metadata);
    let quality_filtered =
        filter_streams_by_quality_preference(episode_filtered, preferred_quality);
    let sorted = sort_episode_candidates(
        quality_filtered,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    let selected = prioritize_candidates_by_source_hash(
        sorted
            .iter()
            .copied()
            .take(limit.max(1))
            .collect::<Vec<_>>(),
        sorted.clone(),
        source_hash,
        limit,
    );
    if should_prefer_mp4_episode_candidate(preferred_container, source_hash) {
        apply_mp4_default_candidate_rule(
            selected,
            sorted,
            source_hash,
            limit,
            &source_filters.source_language,
            health_scores,
        )
    } else {
        selected
    }
}

#[cfg(test)]
pub(super) fn select_fastest_race_candidates(
    candidates: Vec<&DiscoveryStream>,
) -> Vec<&DiscoveryStream> {
    let safe_limit = FASTEST_PARALLEL_CANDIDATES.max(1);
    let mut selected = Vec::new();
    let mut seen_hashes = HashSet::new();
    for candidate in candidates.iter().copied().take(2) {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            return selected;
        }
    }

    let mut local_friendly = candidates.clone();
    local_friendly.sort_by(|left, right| {
        let right_score = score_fastest_local_candidate(right);
        let left_score = score_fastest_local_candidate(left);
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    for candidate in local_friendly {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            return selected;
        }
    }

    for candidate in candidates {
        push_unique_candidate(&mut selected, &mut seen_hashes, candidate);
        if selected.len() >= safe_limit {
            break;
        }
    }
    selected
}

#[cfg(test)]
fn score_fastest_local_candidate(stream: &DiscoveryStream) -> i64 {
    let seed_count = parse_seed_count(if stream.title.is_empty() {
        stream.name.as_str()
    } else {
        stream.title.as_str()
    });
    let size_bytes = parse_stream_size_bytes(stream);
    let mut score = if seed_count > 0 {
        (((seed_count + 1) as f64).log10() * 900.0).round() as i64
    } else {
        0
    };

    if size_bytes > 0 {
        let size_gb = size_bytes as f64 / 1_073_741_824.0;
        score += if size_gb <= 1.5 {
            600
        } else if size_gb <= 3.5 {
            1_100
        } else if size_gb <= 6.0 {
            800
        } else if size_gb <= 10.0 {
            250
        } else {
            -((size_gb - 10.0) * 85.0).round() as i64
        };
    }
    if is_stream_likely_container(stream, "mp4") {
        score += 550;
    }
    score + score_stream_release_quality(stream)
}

fn should_prefer_mp4_episode_candidate(preferred_container: &str, source_hash: &str) -> bool {
    match normalize_preferred_container(preferred_container).as_str() {
        "mp4" => true,
        "mkv" => false,
        _ => normalize_source_hash(source_hash).is_empty(),
    }
}

pub(super) fn summarize_stream_candidate_for_client(
    stream: &DiscoveryStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Option<SourceSummary> {
    let info_hash = get_stream_info_hash(stream);
    if info_hash.is_empty() {
        return None;
    }
    let title_lines = extract_stream_title_lines(stream);
    let filename = stream.behaviorHints.filename.trim().to_owned();
    let primary = if !filename.is_empty() {
        filename.clone()
    } else if let Some(line) = title_lines.first() {
        line.clone()
    } else if !stream.name.trim().is_empty() {
        stream.name.trim().to_owned()
    } else {
        "Source".to_owned()
    };
    let provider = normalize_whitespace(&stream.name);
    let seeders = parse_seed_count(stream.title.as_str()).max(0);
    let resolution = parse_stream_vertical_resolution(stream);
    let container = infer_stream_container_label(stream);
    let mut score = score_stream_quality(
        stream,
        metadata,
        preferred_audio_lang,
        preferred_quality,
        source_filters,
        health_scores,
    );
    if metadata.episode_number > 0 {
        score +=
            score_stream_episode_match(stream, metadata.season_number, metadata.episode_number);
    }
    Some(SourceSummary {
        sourceHash: info_hash.clone(),
        infoHash: info_hash,
        provider,
        primary,
        filename,
        qualityLabel: if resolution > 0 {
            format!("{resolution}p")
        } else {
            String::new()
        },
        container,
        isTorrent: true,
        seeders,
        size: extract_stream_size_label(stream),
        releaseGroup: extract_stream_release_group(stream),
        score,
    })
}

fn apply_source_stream_filters<'a>(
    streams: Vec<&'a DiscoveryStream>,
    source_filters: &SourceFilters,
) -> Vec<&'a DiscoveryStream> {
    let effective_allowed_formats = if source_filters.allowed_formats.is_empty() {
        DEFAULT_ALLOWED_SOURCE_FORMATS
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    } else {
        source_filters.allowed_formats.clone()
    };
    let allowed_format_set = effective_allowed_formats
        .into_iter()
        .collect::<HashSet<_>>();
    streams
        .into_iter()
        .filter(|stream| {
            if source_filters.min_seeders > 0
                && parse_seed_count(if stream.title.is_empty() {
                    stream.name.as_str()
                } else {
                    stream.title.as_str()
                }) < source_filters.min_seeders
            {
                return false;
            }
            let container = infer_stream_container_label(stream);
            if container.is_empty() || !allowed_format_set.contains(&container) {
                return false;
            }
            if source_filters.source_language != "any"
                && !matches_source_language_filter(stream, &source_filters.source_language)
            {
                return false;
            }
            true
        })
        .collect()
}

fn filter_streams_by_quality_preference<'a>(
    streams: Vec<&'a DiscoveryStream>,
    preferred_quality: &str,
) -> Vec<&'a DiscoveryStream> {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return streams;
    }
    let target_height = stream_quality_target(&normalized_quality);
    if target_height == 0 {
        return streams;
    }

    let exact_matches = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) == target_height)
        .collect::<Vec<_>>();
    if !exact_matches.is_empty() {
        return exact_matches;
    }

    let lower_or_equal = streams
        .iter()
        .copied()
        .filter(|stream| {
            let height = parse_stream_vertical_resolution(stream);
            height > 0 && height <= target_height
        })
        .collect::<Vec<_>>();
    if !lower_or_equal.is_empty() {
        return lower_or_equal;
    }

    let higher = streams
        .iter()
        .copied()
        .filter(|stream| parse_stream_vertical_resolution(stream) > target_height)
        .collect::<Vec<_>>();
    if !higher.is_empty() {
        return higher;
    }

    streams
}

pub(super) fn sort_movie_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score = score_stream_quality(
            right,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        let left_score = score_stream_quality(
            left,
            metadata,
            preferred_audio_lang,
            preferred_quality,
            source_filters,
            health_scores,
        );
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn sort_episode_candidates<'a>(
    streams: Vec<&'a DiscoveryStream>,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let mut sorted = streams;
    sorted.sort_by(|left, right| {
        let right_score =
            score_stream_quality(
                right,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(right, metadata.season_number, metadata.episode_number);
        let left_score =
            score_stream_quality(
                left,
                metadata,
                preferred_audio_lang,
                preferred_quality,
                source_filters,
                health_scores,
            ) + score_stream_episode_match(left, metadata.season_number, metadata.episode_number);
        if right_score != left_score {
            return right_score.cmp(&left_score);
        }
        parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
    });
    sorted
}

fn score_stream_quality(
    stream: &DiscoveryStream,
    metadata: &ResolveMetadata,
    preferred_audio_lang: &str,
    preferred_quality: &str,
    source_filters: &SourceFilters,
    health_scores: &HashMap<String, i64>,
) -> i64 {
    score_stream_language_preference(stream, preferred_audio_lang)
        + score_stream_source_audio_profile(
            stream,
            &source_filters.source_language,
            &source_filters.source_audio_profile,
        )
        + score_stream_quality_preference(stream, preferred_quality)
        + score_stream_title_year_match(stream, metadata)
        + score_stream_runtime_match(stream, metadata)
        + score_stream_release_quality(stream)
        + score_stream_seeders(stream)
        + health_scores
            .get(&get_stream_info_hash(stream))
            .copied()
            .unwrap_or_default()
}

fn prioritize_candidates_by_source_hash<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    source_hash: &str,
    limit: usize,
) -> Vec<&'a DiscoveryStream> {
    let normalized_hash = normalize_source_hash(source_hash);
    let safe_limit = limit.max(1);
    if normalized_hash.is_empty() {
        return candidates.into_iter().take(safe_limit).collect();
    }

    // Manual/pinned source selection must resolve only the requested hash.
    // Returning substitutes lets local-torrent racing (or RD fallbacks) win with
    // a different infohash; the player then rejects the mismatch and rolls back.
    let dedup_by_hash = |list: Vec<&'a DiscoveryStream>| {
        let mut seen = HashSet::new();
        let mut output = Vec::new();
        for item in list {
            let hash = get_stream_info_hash(item);
            if hash.is_empty() || !seen.insert(hash) {
                continue;
            }
            output.push(item);
        }
        output
    };

    if let Some(selected) = dedup_by_hash(candidates)
        .into_iter()
        .find(|item| get_stream_info_hash(item) == normalized_hash)
    {
        return vec![selected];
    }

    if let Some(selected_from_pool) = dedup_by_hash(ranked_pool)
        .into_iter()
        .find(|item| get_stream_info_hash(item) == normalized_hash)
    {
        return vec![selected_from_pool];
    }

    Vec::new()
}

fn apply_mp4_default_candidate_rule<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    source_hash: &str,
    limit: usize,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    // Pinned resolves must stay on the selected hash; never inject/replace MP4.
    if !normalize_source_hash(source_hash).is_empty() {
        return candidates;
    }
    let with_mp4 = ensure_at_least_one_container_candidate(
        candidates,
        ranked_pool.clone(),
        "mp4",
        limit,
        source_language,
        health_scores,
    );
    if with_mp4.is_empty() {
        return with_mp4;
    }

    let mut mp4_candidates = ranked_pool
        .iter()
        .copied()
        .filter(|candidate| {
            is_stream_likely_container(candidate, "mp4")
                && is_candidate_healthy_enough_for_default(candidate, health_scores)
        })
        .collect::<Vec<_>>();
    if mp4_candidates.is_empty() {
        return move_container_candidates_to_front(with_mp4, "mp4");
    }

    mp4_candidates
        .sort_by(|left, right| compare_container_default_candidates(left, right, source_language));

    let safe_limit = limit.max(1);
    let mut seen_hashes = HashSet::new();
    let mut next = Vec::new();
    for candidate in mp4_candidates {
        push_unique_candidate(&mut next, &mut seen_hashes, candidate);
        if next.len() >= safe_limit {
            return next;
        }
    }
    for candidate in with_mp4 {
        push_unique_candidate(&mut next, &mut seen_hashes, candidate);
        if next.len() >= safe_limit {
            break;
        }
    }
    next
}

fn push_unique_candidate<'a>(
    output: &mut Vec<&'a DiscoveryStream>,
    seen_hashes: &mut HashSet<String>,
    candidate: &'a DiscoveryStream,
) {
    let hash = get_stream_info_hash(candidate);
    if hash.is_empty() || seen_hashes.insert(hash) {
        output.push(candidate);
    }
}

fn ensure_at_least_one_container_candidate<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    ranked_pool: Vec<&'a DiscoveryStream>,
    container: &str,
    limit: usize,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Vec<&'a DiscoveryStream> {
    let safe_limit = limit.max(1);
    let mut current = candidates.into_iter().take(safe_limit).collect::<Vec<_>>();
    if current.is_empty() {
        return current;
    }
    if current.iter().any(|candidate| {
        is_stream_likely_container(candidate, container)
            && is_candidate_healthy_enough_for_default(candidate, health_scores)
    }) {
        return current;
    }
    let current_hashes = current
        .iter()
        .map(|candidate| get_stream_info_hash(candidate))
        .filter(|hash| !hash.is_empty())
        .collect::<HashSet<_>>();
    let Some(fallback) =
        pick_best_container_candidate(&ranked_pool, container, source_language, health_scores)
    else {
        return current;
    };
    let fallback_hash = get_stream_info_hash(fallback);
    if !fallback_hash.is_empty() && current_hashes.contains(&fallback_hash) {
        return current;
    }
    if let Some(last) = current.last_mut() {
        *last = fallback;
    }
    current
}

fn pick_best_container_candidate<'a>(
    candidates: &[&'a DiscoveryStream],
    container: &str,
    source_language: &str,
    health_scores: &HashMap<String, i64>,
) -> Option<&'a DiscoveryStream> {
    let mut container_candidates = candidates
        .iter()
        .copied()
        .filter(|candidate| {
            is_stream_likely_container(candidate, container)
                && is_candidate_healthy_enough_for_default(candidate, health_scores)
        })
        .collect::<Vec<_>>();
    container_candidates
        .sort_by(|left, right| compare_container_default_candidates(left, right, source_language));
    container_candidates.first().copied()
}

fn is_candidate_healthy_enough_for_default(
    candidate: &DiscoveryStream,
    health_scores: &HashMap<String, i64>,
) -> bool {
    let source_hash = get_stream_info_hash(candidate);
    health_scores.get(&source_hash).copied().unwrap_or_default() > SOURCE_HEALTH_AVOID_SCORE
}

fn compare_container_default_candidates(
    left: &DiscoveryStream,
    right: &DiscoveryStream,
    source_language: &str,
) -> std::cmp::Ordering {
    let left_language_score = score_container_default_language(left, source_language);
    let right_language_score = score_container_default_language(right, source_language);
    if left_language_score != right_language_score {
        return right_language_score.cmp(&left_language_score);
    }
    let left_resolution = parse_stream_vertical_resolution(left);
    let right_resolution = parse_stream_vertical_resolution(right);
    if left_resolution != right_resolution {
        return right_resolution.cmp(&left_resolution);
    }
    parse_seed_count(&right.title).cmp(&parse_seed_count(&left.title))
}

fn move_container_candidates_to_front<'a>(
    candidates: Vec<&'a DiscoveryStream>,
    container: &str,
) -> Vec<&'a DiscoveryStream> {
    let mut preferred = Vec::new();
    let mut rest = Vec::new();
    for candidate in candidates {
        if is_stream_likely_container(candidate, container) {
            preferred.push(candidate);
        } else {
            rest.push(candidate);
        }
    }
    preferred.extend(rest);
    preferred
}

fn score_container_default_language(stream: &DiscoveryStream, source_language: &str) -> i64 {
    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return 0;
    }
    let detected = get_detected_stream_languages(stream);
    if detected.contains(&normalized_source_language) {
        return if detected.len() == 1 { 4 } else { 2 };
    }
    if detected.is_empty() && normalized_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT {
        return 1;
    }
    -5
}

fn score_stream_source_audio_profile(
    stream: &DiscoveryStream,
    source_language: &str,
    source_audio_profile: &str,
) -> i64 {
    let normalized_profile = normalize_source_audio_profile_filter(source_audio_profile);
    if normalized_profile != SOURCE_AUDIO_PROFILE_DEFAULT {
        return 0;
    }

    let detected_languages = get_detected_stream_languages(stream);
    let has_multi_audio_marker = has_explicit_multi_audio_marker(stream);
    if has_multi_audio_marker || detected_languages.len() > 1 {
        let normalized_source_language = normalize_source_language_filter(source_language);
        if normalized_source_language != "any"
            && detected_languages.contains(&normalized_source_language)
        {
            return -2_200;
        }
        return -1_800;
    }

    let normalized_source_language = normalize_source_language_filter(source_language);
    if normalized_source_language == "any" {
        return if detected_languages.len() == 1 {
            450
        } else {
            0
        };
    }

    if detected_languages.len() == 1 && detected_languages.contains(&normalized_source_language) {
        return 1_600;
    }

    0
}

fn score_stream_seeders(stream: &DiscoveryStream) -> i64 {
    let seed_count = parse_seed_count(if stream.title.is_empty() {
        stream.name.as_str()
    } else {
        stream.title.as_str()
    });
    if seed_count <= 0 {
        return 0;
    }
    ((((seed_count + 1) as f64).log10() * 320.0).round() as i64).min(900)
}

fn score_stream_language_preference(stream: &DiscoveryStream, preferred_audio_lang: &str) -> i64 {
    let preferred = normalize_preferred_audio_lang(preferred_audio_lang);
    if preferred == "auto" {
        return 0;
    }
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let mut score = 0;
    if audio_language_tokens(&preferred)
        .iter()
        .any(|token| stream_text.contains(token))
    {
        score += 2500;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        if lang == preferred {
            continue;
        }
        if audio_language_tokens(lang)
            .iter()
            .any(|token| stream_text.contains(token))
        {
            score -= 1400;
        }
    }
    score
}

fn score_stream_quality_preference(stream: &DiscoveryStream, preferred_quality: &str) -> i64 {
    let normalized_quality = normalize_preferred_stream_quality(preferred_quality);
    if normalized_quality == "auto" {
        return 0;
    }
    let target_height = stream_quality_target(&normalized_quality);
    let candidate_height = parse_stream_vertical_resolution(stream);
    if target_height == 0 || candidate_height == 0 {
        return 0;
    }
    if candidate_height == target_height {
        return 1400;
    }
    if candidate_height > target_height {
        return -700 - (candidate_height - target_height).min(900);
    }
    -300 - (target_height - candidate_height).min(700)
}

fn score_stream_title_year_match(stream: &DiscoveryStream, metadata: &ResolveMetadata) -> i64 {
    let stream_text = normalize_text_for_match(&build_stream_text_raw(stream));
    if stream_text.is_empty() {
        return 0;
    }
    let title_tokens = tokenize_title_for_match(&metadata.display_title);
    if title_tokens.is_empty() {
        return 0;
    }
    let matched_token_count = count_matching_title_tokens(&stream_text, &title_tokens);
    let has_year =
        !metadata.display_year.is_empty() && stream_text.contains(&metadata.display_year);
    let required_matches = title_tokens.len().min(2);
    if matched_token_count >= required_matches && has_year {
        return 1800;
    }
    if matched_token_count >= required_matches {
        return 1100;
    }
    if matched_token_count >= 1 && has_year {
        return 420;
    }
    if matched_token_count == 0 && has_year {
        return -900;
    }
    -600
}

fn score_stream_runtime_match(stream: &DiscoveryStream, metadata: &ResolveMetadata) -> i64 {
    let target_runtime_seconds = metadata.runtime_seconds.max(0);
    if target_runtime_seconds < 1800 {
        return 0;
    }
    let candidate_runtime_seconds =
        parse_runtime_from_label_seconds(&build_stream_text_raw(stream));
    if candidate_runtime_seconds <= 0 {
        return 0;
    }
    let delta_ratio = ((candidate_runtime_seconds - target_runtime_seconds).abs() as f64)
        / target_runtime_seconds as f64;
    if delta_ratio <= 0.06 {
        return 420;
    }
    if delta_ratio <= 0.12 {
        return 220;
    }
    if delta_ratio <= 0.2 {
        return 60;
    }
    -360
}

fn score_stream_release_quality(stream: &DiscoveryStream) -> i64 {
    let stream_text = build_stream_release_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    if LOW_QUALITY_THEATRICAL_RELEASE_RE.is_match(&stream_text) {
        return -4200;
    }
    if LOW_QUALITY_SCREENER_RELEASE_RE.is_match(&stream_text) {
        return -2600;
    }
    0
}

pub(super) fn score_stream_episode_match(
    stream: &DiscoveryStream,
    season_number: i64,
    episode_number: i64,
) -> i64 {
    let stream_text = build_stream_text(stream);
    if stream_text.is_empty() {
        return 0;
    }
    let target_signature = build_episode_signature(season_number, episode_number);
    let signatures = collect_episode_signatures(&stream_text, Some(season_number));
    if signatures.is_empty() {
        // No episode signature anywhere: exact single-episode releases always
        // carry one, so this is either a season pack or a bare/generic release.
        // Packs start playback much slower (large multi-file metadata, swarm
        // spread across many files), so push them below generic releases while
        // still keeping them as a fallback when nothing better exists.
        if SEASON_PACK_RE.is_match(&stream_text) {
            return -1800;
        }
        return 0;
    }
    if signatures.contains(&target_signature) {
        return 2800;
    }
    -3400
}

pub(super) fn build_episode_signature(season_number: i64, episode_number: i64) -> String {
    format!(
        "{}x{}",
        normalize_episode_ordinal(&season_number.to_string(), 1),
        normalize_episode_ordinal(&episode_number.to_string(), 1)
    )
}

pub(super) fn collect_episode_signatures(text: &str, season_hint: Option<i64>) -> Vec<String> {
    let normalized = text.to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut signatures = Vec::new();
    let mut push = |season: i64, episode: i64| {
        if !(1..=99).contains(&season) || !(1..=999).contains(&episode) {
            return;
        }
        signatures.push(format!("{season}x{episode}"));
    };
    for captures in HXH_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    for captures in X_SEASON_EPISODE_RE.captures_iter(&normalized) {
        push(
            captures
                .get(1)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<i64>().ok())
                .unwrap_or_default(),
        );
    }
    if let Some(season_hint) = season_hint.filter(|value| *value > 0) {
        for captures in EPISODE_ONLY_RE.captures_iter(&normalized) {
            push(
                season_hint,
                captures
                    .get(1)
                    .and_then(|value| value.as_str().parse::<i64>().ok())
                    .unwrap_or_default(),
            );
        }
    }
    signatures.sort();
    signatures.dedup();
    signatures
}

pub(super) fn parse_runtime_from_label_seconds(value: &str) -> i64 {
    let text = value.to_lowercase();
    if text.is_empty() {
        return 0;
    }
    if let Some(captures) = HMS_RUNTIME_RE.captures(&text) {
        let first = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let second = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let third = captures
            .get(3)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        if captures.get(3).is_some() {
            return first * 3600 + second * 60 + third;
        }
        return first * 60 + second;
    }
    let hours = HOURS_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    let minutes = MINUTES_RUNTIME_RE
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or_default();
    if hours > 0.0 || minutes > 0.0 {
        return (hours * 3600.0 + minutes * 60.0).round() as i64;
    }
    if let Some(captures) = COMPACT_RUNTIME_RE.captures(&text) {
        let hours = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let minutes = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        return hours * 3600 + minutes * 60;
    }
    0
}

fn parse_stream_vertical_resolution(stream: &DiscoveryStream) -> i64 {
    parse_vertical_resolution_from_text(&build_stream_text(stream))
}

pub(super) fn parse_vertical_resolution_from_text(value: &str) -> i64 {
    let stream_text = value.to_lowercase();
    if stream_text.is_empty() {
        return 0;
    }
    if RESOLUTION_2160_RE.is_match(&stream_text) {
        return 2160;
    }
    if RESOLUTION_1080_RE.is_match(&stream_text) {
        return 1080;
    }
    if RESOLUTION_720_RE.is_match(&stream_text) {
        return 720;
    }
    if RESOLUTION_480_RE.is_match(&stream_text) {
        return 480;
    }
    0
}

fn infer_stream_container_label(stream: &DiscoveryStream) -> String {
    let stream_text = [
        stream.behaviorHints.filename.as_str(),
        stream.title.as_str(),
        stream.name.as_str(),
        stream.description.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    if stream_text.is_empty() {
        return String::new();
    }
    if stream_text.contains(".mp4") {
        return "mp4".to_owned();
    }
    if stream_text.contains(".mkv") {
        return "mkv".to_owned();
    }
    if stream_text.contains(".avi") {
        return "avi".to_owned();
    }
    if stream_text.contains(".wmv") {
        return "wmv".to_owned();
    }
    if stream_text.contains(".m3u8") {
        return "m3u8".to_owned();
    }
    if stream_text.contains(".ts") {
        return "ts".to_owned();
    }
    if stream.discoveryProvider == "torznab" {
        return "mkv".to_owned();
    }
    String::new()
}

fn is_stream_likely_container(stream: &DiscoveryStream, container: &str) -> bool {
    let inferred = infer_stream_container_label(stream);
    if !inferred.is_empty() {
        return inferred == container;
    }
    false
}

fn matches_source_language_filter(stream: &DiscoveryStream, source_language: &str) -> bool {
    let safe_source_language = normalize_source_language_filter(source_language);
    if safe_source_language == "any" {
        return true;
    }
    let matched = get_detected_stream_languages(stream);
    if matched.contains(&safe_source_language) {
        return matched.len() == 1;
    }
    safe_source_language == SOURCE_LANGUAGE_FILTER_DEFAULT && matched.is_empty()
}

fn get_detected_stream_languages(stream: &DiscoveryStream) -> HashSet<String> {
    let stream_text_raw = build_stream_text_raw(stream);
    let normalized_stream_text = normalize_text_for_match(&stream_text_raw);
    let stream_text = format!(" {} ", normalized_stream_text.trim());
    let mut matched = HashSet::new();
    if stream_text.trim().is_empty() {
        return matched;
    }
    for lang in ["en", "fr", "es", "de", "it", "pt"] {
        let has_match = audio_language_tokens(lang).iter().any(|token| {
            let normalized = normalize_text_for_match(token);
            !normalized.is_empty() && stream_text.contains(&format!(" {normalized} "))
        });
        if has_match {
            matched.insert(lang.to_owned());
        }
    }
    matched
}

pub(super) fn extract_stream_title_lines(stream: &DiscoveryStream) -> Vec<String> {
    stream
        .title
        .lines()
        .map(normalize_whitespace)
        .filter(|line| !line.is_empty())
        .collect()
}

fn extract_stream_size_label(stream: &DiscoveryStream) -> String {
    STREAM_SIZE_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| normalize_whitespace(value.as_str()))
        .unwrap_or_default()
}

#[cfg(test)]
fn parse_stream_size_bytes(stream: &DiscoveryStream) -> i64 {
    parse_size_label_bytes(&extract_stream_size_label(stream))
}

#[cfg(test)]
pub(super) fn parse_size_label_bytes(label: &str) -> i64 {
    let mut parts = label.split_whitespace();
    let Some(number_part) = parts.next() else {
        return 0;
    };
    let value = number_part.replace(',', "").parse::<f64>().unwrap_or(0.0);
    if value <= 0.0 {
        return 0;
    }
    let unit = parts.next().unwrap_or("b").to_lowercase();
    let multiplier = if unit.starts_with("kb") || unit.starts_with("kib") {
        1024.0
    } else if unit.starts_with("mb") || unit.starts_with("mib") {
        1024.0_f64.powi(2)
    } else if unit.starts_with("gb") || unit.starts_with("gib") {
        1024.0_f64.powi(3)
    } else if unit.starts_with("tb") || unit.starts_with("tib") {
        1024.0_f64.powi(4)
    } else {
        1.0
    };
    (value * multiplier).round() as i64
}

fn extract_stream_release_group(stream: &DiscoveryStream) -> String {
    STREAM_RELEASE_GROUP_RE
        .captures(&stream.title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            normalize_whitespace(value.as_str())
                .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
                .to_owned()
        })
        .unwrap_or_default()
}

pub(super) fn parse_seed_count(stream_title: &str) -> i64 {
    SEED_COUNT_RE
        .captures(stream_title)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            value
                .as_str()
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<i64>()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

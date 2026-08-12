use std::collections::HashMap;
use std::sync::LazyLock;

use super::{
    GALLIC_API_BASE, MERIDIAN_API_BASE, NOTORRENT_API_BASE, ResolveFilters, ResolveMetadata,
    ResolvePreferences, ResolverProvider, SOURCE_HEALTH_AVOID_SCORE, SourceSummary,
    lordflix_source_url, nebula_addon_base, normalize_source_hash, stremio_addon_stream_url,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::resolver) struct ExternalEmbedProvider {
    pub(in crate::resolver) id: &'static str,
    pub(in crate::resolver) label: &'static str,
    pub(in crate::resolver) priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::resolver) struct ExternalEmbedServer {
    pub(in crate::resolver) id: &'static str,
    pub(in crate::resolver) label: &'static str,
    pub(in crate::resolver) quality_label: &'static str,
    pub(in crate::resolver) detail_label: &'static str,
    pub(in crate::resolver) priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::resolver) struct ExternalEmbedSource {
    pub(in crate::resolver) provider: ExternalEmbedProvider,
    pub(in crate::resolver) server: Option<ExternalEmbedServer>,
}

pub(super) const EXTERNAL_EMBED_PROVIDERS: &[ExternalEmbedProvider] = &[
    ExternalEmbedProvider {
        id: "videasy",
        label: "VidEasy",
        priority: 5,
    },
    ExternalEmbedProvider {
        id: "vidlink",
        label: "VidLink",
        priority: 0,
    },
    ExternalEmbedProvider {
        id: "vidrock",
        label: "VidRock",
        priority: 1,
    },
    ExternalEmbedProvider {
        id: "notorrent",
        label: "NoTorrent",
        priority: 2,
    },
    ExternalEmbedProvider {
        id: "vixsrc",
        label: "VixSrc",
        priority: 3,
    },
    ExternalEmbedProvider {
        id: "lordflix",
        label: "LordFlix",
        priority: 4,
    },
    ExternalEmbedProvider {
        id: "icefy",
        label: "Icefy",
        priority: 6,
    },
    ExternalEmbedProvider {
        id: "meridian",
        label: "Meridian",
        priority: 7,
    },
    ExternalEmbedProvider {
        id: "gallic",
        label: "Gallic",
        priority: 8,
    },
    ExternalEmbedProvider {
        id: "nebula",
        label: "NebulaStreams",
        priority: 9,
    },
];

const VIDEASY_EXTERNAL_EMBED_SERVERS: &[ExternalEmbedServer] = &[
    ExternalEmbedServer {
        id: "YORU",
        label: "Yoru",
        quality_label: "4K",
        detail_label: "Movies only, may have 4K",
        priority: 0,
    },
    ExternalEmbedServer {
        id: "NEON",
        label: "Neon",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 10,
    },
    ExternalEmbedServer {
        id: "CYPHER",
        label: "Cypher",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 11,
    },
    ExternalEmbedServer {
        id: "SAGE",
        label: "Sage",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 12,
    },
    ExternalEmbedServer {
        id: "BREACH",
        label: "Breach",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 13,
    },
    ExternalEmbedServer {
        id: "VYSE",
        label: "Vyse",
        quality_label: "HLS",
        detail_label: "Original audio",
        priority: 14,
    },
    ExternalEmbedServer {
        id: "RAZE",
        label: "Raze",
        quality_label: "HLS",
        detail_label: "Portuguese audio",
        priority: 15,
    },
];

pub(super) fn combine_external_embed_source_summaries(
    external_sources: Vec<SourceSummary>,
    torrent_sources: Vec<SourceSummary>,
) -> Vec<SourceSummary> {
    if external_sources.is_empty() {
        return torrent_sources;
    }
    let mut sources = external_sources;
    sources.extend(torrent_sources);
    sources
}

pub(super) fn build_external_embed_source_summaries(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Vec<SourceSummary> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter_map(|source| {
            let source_hash = external_embed_source_hash(source, metadata);
            if source_hash.is_empty() || external_embed_url(source, metadata).is_none() {
                return None;
            }
            let display_name = external_embed_source_display_name(source);
            let filename = external_embed_source_filename(source);
            Some(SourceSummary {
                sourceHash: source_hash.clone(),
                infoHash: source_hash,
                provider: external_embed_source_provider_label(source).to_owned(),
                primary: display_name,
                filename,
                qualityLabel: external_embed_source_quality_label(source).to_owned(),
                container: "hls".to_owned(),
                isTorrent: false,
                seeders: 0,
                size: String::new(),
                releaseGroup: external_embed_source_detail_label(source).to_owned(),
                score: 1_000_000
                    + external_embed_source_rank_score(source, metadata, health_scores),
            })
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.primary.cmp(&right.primary))
    });
    sources
}

pub(super) fn external_embed_source_for_source_hash(
    metadata: &ResolveMetadata,
    source_hash: &str,
) -> Option<ExternalEmbedSource> {
    let normalized_hash = normalize_source_hash(source_hash);
    if normalized_hash.is_empty() {
        return None;
    }
    external_embed_sources()
        .into_iter()
        .find(|source| external_embed_source_hash(*source, metadata) == normalized_hash)
}

pub(super) fn default_external_embed_source(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Option<ExternalEmbedSource> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter(|source| external_embed_url(*source, metadata).is_some())
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        external_embed_source_rank_score(*right, metadata, health_scores)
            .cmp(&external_embed_source_rank_score(
                *left,
                metadata,
                health_scores,
            ))
            .then_with(|| {
                external_embed_source_display_name(*left)
                    .cmp(&external_embed_source_display_name(*right))
            })
    });
    sources.into_iter().next()
}

pub(super) fn preferred_external_embed_hls_sources(
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> Vec<ExternalEmbedSource> {
    let mut sources = external_embed_sources()
        .into_iter()
        .filter(|source| is_default_external_embed_hls_fallback_source(*source))
        .filter(|source| is_external_embed_hls_capable_source(*source))
        .filter(|source| external_embed_url(*source, metadata).is_some())
        .filter(|source| {
            is_external_embed_source_healthy_enough_for_fallback(*source, metadata, health_scores)
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        external_embed_source_rank_score(*right, metadata, health_scores)
            .cmp(&external_embed_source_rank_score(
                *left,
                metadata,
                health_scores,
            ))
            .then_with(|| {
                external_embed_source_display_name(*left)
                    .cmp(&external_embed_source_display_name(*right))
            })
    });
    sources
}

pub(super) fn external_embed_source_rank_score(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> i64 {
    let source_hash = external_embed_source_hash(source, metadata);
    external_embed_source_availability_score(source)
        + external_embed_source_quality_score(source)
        + health_scores.get(&source_hash).copied().unwrap_or_default()
        - external_embed_source_priority(source, metadata)
}

pub(super) fn is_default_external_embed_hls_fallback_source(source: ExternalEmbedSource) -> bool {
    match source.provider.id {
        "videasy" => source
            .server
            .map(|server| server.id == "YORU")
            .unwrap_or(true),
        "vidlink" => source.server.is_none(),
        "vidrock" | "notorrent" | "vixsrc" | "lordflix" | "meridian" | "gallic" | "nebula" => {
            source.server.is_none()
        }
        id if crate::provider_registry::is_custom(id) => source.server.is_none(),
        _ => false,
    }
}

fn is_external_embed_source_healthy_enough_for_fallback(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    health_scores: &HashMap<String, i64>,
) -> bool {
    let source_hash = external_embed_source_hash(source, metadata);
    health_scores.get(&source_hash).copied().unwrap_or_default() > SOURCE_HEALTH_AVOID_SCORE
}

pub(super) fn is_external_embed_hls_capable_source(source: ExternalEmbedSource) -> bool {
    matches!(
        source.provider.id,
        "videasy"
            | "vidlink"
            | "icefy"
            | "vidrock"
            | "vixsrc"
            | "lordflix"
            | "notorrent"
            | "meridian"
            | "gallic"
            | "nebula"
    ) || crate::provider_registry::is_custom(source.provider.id)
}

fn external_embed_source_availability_score(source: ExternalEmbedSource) -> i64 {
    // This is the de-facto reliability tier for the Server menu and the auto-pick/
    // fallback order (it dominates external_embed_source_rank_score). The per-
    // provider baseline lives in `provider_registry::EMBED_DEFAULT_RANK` (which
    // documents the tier rationale) and is admin-overridable live via the Providers
    // dashboard (`embed:<id>:rank`), so an operator can re-rank sources without a
    // redeploy. The default Meridian->LordFlix gap (200) exceeds the +75 positive-
    // health cap, so a transient good streak can't lift a lower tier above a higher
    // one; only a genuine per-title failure (the uncapped -6000 penalty) demotes a
    // source, at which point the staggered hedge races the next provider in.
    //
    // VidEasy's per-server variants stay a low fallback tier regardless of the
    // provider weight — they only surface when the base providers miss.
    if source.provider.id == "videasy" && source.server.is_some() {
        return 150;
    }
    crate::provider_registry::embed_rank(source.provider.id)
}

fn external_embed_source_quality_score(source: ExternalEmbedSource) -> i64 {
    match source.provider.id {
        "videasy" if source.server.map(|server| server.id) == Some("YORU") => 600,
        "vidlink" | "vidrock" | "notorrent" | "vixsrc" | "lordflix" => 400,
        "videasy" if source.server.is_none() => 400,
        "icefy" => 350,
        // Meridian ~1080p (preferred default); Gallic advertises up to 2160p.
        "meridian" => 400,
        "gallic" => 400,
        // Lowest-tier fallback; keeps Nebula just below meridian/gallic and above
        // the flaky VidEasy server-variants in the rank ordering.
        "nebula" => 350,
        "videasy" => 300,
        _ => 0,
    }
}

pub(super) fn should_prefer_default_external_embed(
    filters: &ResolveFilters,
    resolver_provider: ResolverProvider,
) -> bool {
    filters.source_hash.is_empty()
        && !matches!(
            resolver_provider,
            ResolverProvider::RealDebrid | ResolverProvider::LocalTorrent
        )
}

pub(super) fn should_resolve_torrent_candidates(
    filters: &ResolveFilters,
    resolver_provider: ResolverProvider,
) -> bool {
    !filters.source_hash.is_empty() || !resolver_provider.is_fastest()
}

pub(super) fn external_embed_url(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
) -> Option<String> {
    let tmdb_id = metadata.tmdb_id.trim();
    if tmdb_id.is_empty() {
        return None;
    }
    match (source.provider.id, metadata.media_type.as_str()) {
        ("videasy", "movie") => Some(format!(
            "https://player.videasy.to/movie/{tmdb_id}?color=ffd700"
        )),
        ("videasy", "tv") => Some(format!(
            "https://player.videasy.to/tv/{}/{}/{}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=false&overlay=true&color=ffd700",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vidlink", "movie") => Some(format!("https://vidlink.pro/movie/{tmdb_id}")),
        ("vidlink", "tv") => Some(format!(
            "https://vidlink.pro/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("icefy", "movie") => Some(format!("https://streams.icefy.top/movie/{tmdb_id}")),
        ("icefy", "tv") => Some(format!(
            "https://streams.icefy.top/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vixsrc", "movie") => Some(format!("https://vixsrc.to/api/movie/{tmdb_id}")),
        ("vixsrc", "tv") => Some(format!(
            "https://vixsrc.to/api/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("vidrock", "movie") => Some(format!("https://vidrock.net/movie/{tmdb_id}")),
        ("vidrock", "tv") => Some(format!(
            "https://vidrock.net/tv/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        ("lordflix", _) => lordflix_source_url(metadata),
        // NoTorrent + Nebula are Stremio stream addons sharing one request shape;
        // Nebula's base is env-gated, so an unset install resolves to no URL.
        ("notorrent", _) => stremio_addon_stream_url(NOTORRENT_API_BASE, metadata),
        ("nebula", _) => stremio_addon_stream_url(nebula_addon_base()?, metadata),
        ("meridian", "movie") => Some(format!("{MERIDIAN_API_BASE}/movie/{tmdb_id}")),
        ("meridian", "tv") => Some(format!(
            "{MERIDIAN_API_BASE}/show/{}/{}/{}",
            tmdb_id, metadata.season_number, metadata.episode_number
        )),
        // Gallic's upstream (senpai-stream.club) is movie-only.
        ("gallic", "movie") => Some(format!("{GALLIC_API_BASE}/movie/{tmdb_id}")),
        // Admin-added custom providers are generic Stremio stream addons keyed on
        // the stored base URL (imdb-based, like NoTorrent/Nebula).
        (id, _) if crate::provider_registry::is_custom(id) => {
            crate::provider_registry::custom_base(id)
                .and_then(|base| stremio_addon_stream_url(&base, metadata))
        }
        _ => None,
    }
}

pub(super) fn external_embed_playback_url(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
    _preferences: &ResolvePreferences,
) -> Option<String> {
    external_embed_url(source, metadata)
}

pub(super) fn external_embed_source_hash(
    source: ExternalEmbedSource,
    metadata: &ResolveMetadata,
) -> String {
    if external_embed_url(source, metadata).is_none() {
        return String::new();
    }
    let identity = format!(
        "external-embed|{}|{}|{}|{}|{}|{}",
        source.provider.id,
        source.server.map(|server| server.id).unwrap_or("default"),
        metadata.media_type,
        metadata.tmdb_id.trim(),
        metadata.season_number,
        metadata.episode_number
    );
    deterministic_40_hex(&identity)
}

// Leaked-`&'static` cache for admin-added custom providers. Their ids/labels are
// runtime Strings; `ExternalEmbedProvider` needs `&'static str`, so each distinct
// (id, label) pair is leaked exactly once and reused — never per call (which would
// leak unboundedly, since `external_embed_sources` runs every resolve). The set is
// admin-bounded and process-lifetime, so the leak is bounded.
static CUSTOM_EMBED_PROVIDER_CACHE: LazyLock<
    std::sync::RwLock<std::collections::HashMap<String, ExternalEmbedProvider>>,
> = LazyLock::new(|| std::sync::RwLock::new(std::collections::HashMap::new()));

/// `ExternalEmbedProvider` entries for the admin-registered custom Stremio addons,
/// so they flow through the whole embed pipeline. Priority 10 keeps them below
/// every compiled provider (0..=9); effective order is driven by `embed_rank`.
fn custom_embed_providers() -> Vec<ExternalEmbedProvider> {
    crate::provider_registry::list_custom()
        .into_iter()
        .map(|provider| {
            let cache_key = format!("{}\u{0}{}", provider.id, provider.label);
            if let Some(found) = CUSTOM_EMBED_PROVIDER_CACHE
                .read()
                .ok()
                .and_then(|cache| cache.get(&cache_key).copied())
            {
                return found;
            }
            let entry = ExternalEmbedProvider {
                id: Box::leak(provider.id.into_boxed_str()),
                label: Box::leak(provider.label.into_boxed_str()),
                priority: 10,
            };
            if let Ok(mut cache) = CUSTOM_EMBED_PROVIDER_CACHE.write() {
                cache.insert(cache_key, entry);
            }
            entry
        })
        .collect()
}

pub(super) fn external_embed_sources() -> Vec<ExternalEmbedSource> {
    let mut sources = Vec::new();
    for provider in EXTERNAL_EMBED_PROVIDERS
        .iter()
        .copied()
        .chain(custom_embed_providers())
    {
        // Admin can disable a flaky embed provider from the Providers dashboard
        // without a redeploy; a disabled provider contributes no sources.
        if !crate::provider_registry::embed_enabled(provider.id) {
            continue;
        }
        for server in external_embed_servers_for_provider(provider) {
            sources.push(ExternalEmbedSource {
                provider,
                server: Some(*server),
            });
        }
        sources.push(ExternalEmbedSource {
            provider,
            server: None,
        });
    }
    sources
}

fn external_embed_servers_for_provider(
    provider: ExternalEmbedProvider,
) -> &'static [ExternalEmbedServer] {
    match provider.id {
        "videasy" => VIDEASY_EXTERNAL_EMBED_SERVERS,
        _ => &[],
    }
}

fn external_embed_source_priority(source: ExternalEmbedSource, _metadata: &ResolveMetadata) -> i64 {
    if source.provider.id == "vidlink" {
        return 0;
    }
    if matches!(
        source.provider.id,
        "vidrock"
            | "notorrent"
            | "vixsrc"
            | "lordflix"
            | "icefy"
            | "meridian"
            | "gallic"
            | "nebula"
    ) && source.server.is_none()
    {
        return source.provider.priority;
    }
    if crate::provider_registry::is_custom(source.provider.id) && source.server.is_none() {
        return source.provider.priority;
    }
    if source.provider.id == "videasy" && source.server.is_none() {
        return source.provider.priority;
    }
    if source.provider.id == "videasy" {
        return source
            .server
            .map(|server| 100 + server.priority)
            .unwrap_or(150);
    }
    if let Some(server) = source.server {
        return source.provider.priority * 100 + server.priority;
    }
    source.provider.priority * 100 + 50
}

fn external_embed_source_display_name(source: ExternalEmbedSource) -> String {
    source
        .server
        .map(|server| server.label.to_owned())
        .unwrap_or_else(|| source.provider.label.to_owned())
}

fn external_embed_source_provider_label(source: ExternalEmbedSource) -> &'static str {
    if source.server.is_some() {
        source.provider.label
    } else {
        "LivNet"
    }
}

fn external_embed_source_quality_label(source: ExternalEmbedSource) -> &'static str {
    if source.provider.id == "gallic" {
        return "4K";
    }
    if matches!(
        source.provider.id,
        "icefy" | "vidrock" | "vixsrc" | "lordflix" | "notorrent" | "meridian"
    ) {
        return "1080p";
    }
    source
        .server
        .map(|server| server.quality_label)
        .unwrap_or("HLS")
}

fn external_embed_source_detail_label(source: ExternalEmbedSource) -> &'static str {
    match source.provider.id {
        "icefy" => return "Fast native HLS",
        "vidrock" => return "Native HLS",
        "vixsrc" => return "Native HLS, alternate audio",
        "lordflix" => return "Multi-server native HLS",
        "notorrent" => return "Stremio addon HLS",
        "nebula" => return "Stremio addon HLS",
        "meridian" => return "Native HLS, TV + movies",
        "gallic" => return "Native HLS, up to 4K",
        id if crate::provider_registry::is_custom(id) => return "Custom Stremio addon",
        _ => {}
    }
    source
        .server
        .map(|server| server.detail_label)
        .unwrap_or("")
}

pub(super) fn external_embed_source_filename(source: ExternalEmbedSource) -> String {
    if let Some(server) = source.server {
        format!("{} {} embed", source.provider.label, server.label)
    } else {
        format!("{} embed", source.provider.label)
    }
}

fn deterministic_40_hex(value: &str) -> String {
    let a = fnv1a64(value.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let b = fnv1a64(value.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let c = fnv1a64(value.as_bytes(), 0x94d0_49bb_1331_11eb);
    format!("{a:016x}{b:016x}{:08x}", (c >> 32) as u32)
}

fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
    bytes.iter().fold(seed, |mut hash, byte| {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        hash
    })
}

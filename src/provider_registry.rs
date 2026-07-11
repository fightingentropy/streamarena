//! Runtime-overridable provider URLs.
//!
//! Stream/source providers (sports APIs, live channels, VOD embeds) and a couple
//! of infra origins are compiled in as defaults, but the domains hop often enough
//! that swapping one used to mean a code edit + redeploy. This module keeps a
//! small in-memory map of admin overrides — loaded from the `provider_overrides`
//! table at startup and updated whenever an admin saves one — and a `resolve`
//! helper that returns the override if present, else the compiled default.
//!
//! It's a process-global (`OnceLock<RwLock<..>>`) rather than something threaded
//! through `AppState` so the dozens of hardcoded const sites across `football.rs`
//! and `resolver.rs` can opt in with a one-line wrap instead of plumbing state.
//! Reads are per-request (not per-segment), so the RwLock is never hot.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use serde::Serialize;

use crate::config::Config;

static OVERRIDES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();

fn store() -> &'static RwLock<HashMap<String, String>> {
    OVERRIDES.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Stable keys for every backend-resolved provider. Live channel keys are
/// `live:<channelId>:<streamId>` and validated by prefix (their defaults live in
/// the frontend `live-channels.js`, so the backend only stores their overrides).
pub mod keys {
    pub const SPORTS_STREAMED_MATCHES: &str = "sports:streamed-matches";
    pub const SPORTS_STREAMED_FOOTBALL: &str = "sports:streamed-football";
    pub const SPORTS_STREAMED_BASKETBALL: &str = "sports:streamed-basketball";
    pub const SPORTS_MATCHSTREAM_WEBMASTER: &str = "sports:matchstream-webmaster";
    pub const SPORTS_MATCHSTREAM_VIEWER: &str = "sports:matchstream-viewer";
    pub const SPORTS_NTVS_SEARCH: &str = "sports:ntvs-search";
    pub const SPORTS_ESPN_FOOTBALL: &str = "sports:espn-football";

    pub const INFRA_APP_ORIGIN: &str = "infra:app-origin";
    pub const INFRA_TORRENTIO: &str = "infra:torrentio";
    pub const INFRA_LIVE_HLS_WORKER: &str = "infra:live-hls-worker";
}

/// Provider ids of the external VOD embeds. Their base URLs are deeply coupled to
/// per-host referer/fingerprint logic in the resolver, so they are not URL-
/// swappable; the dashboard exposes an enable/disable toggle instead.
pub const EMBED_IDS: &[&str] = &[
    "videasy",
    "vidlink",
    "vidrock",
    "notorrent",
    "vixsrc",
    "lordflix",
    "icefy",
    "meridian",
    "gallic",
    "nebula",
];

/// Replace the whole override map (called once at startup from the DB).
pub fn load(map: HashMap<String, String>) {
    if let Ok(mut guard) = store().write() {
        *guard = map;
    }
}

/// Set (non-empty) or clear (empty/whitespace) a single override in memory.
pub fn set(key: &str, value: &str) {
    let trimmed = value.trim();
    if let Ok(mut guard) = store().write() {
        if trimmed.is_empty() {
            guard.remove(key);
        } else {
            guard.insert(key.to_owned(), trimmed.to_owned());
        }
    }
}

/// Effective value: the admin override if one is set, else the compiled default.
pub fn resolve(key: &str, default: &str) -> String {
    store()
        .read()
        .ok()
        .and_then(|guard| guard.get(key).cloned())
        .unwrap_or_else(|| default.to_owned())
}

/// The raw override for a key, if any (used for catalog display).
pub fn get_override(key: &str) -> Option<String> {
    store()
        .read()
        .ok()
        .and_then(|guard| guard.get(key).cloned())
}

/// Only the live-channel overrides, served to the frontend so it can merge them
/// over the compiled channel list.
pub fn live_overrides() -> HashMap<String, String> {
    store()
        .read()
        .map(|guard| {
            guard
                .iter()
                .filter(|(key, _)| key.starts_with("live:"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether an external embed provider is enabled. Stored as `embed:<id>:enabled`
/// = "0" to disable; absence (or any non-"0" value) means enabled.
pub fn embed_enabled(id: &str) -> bool {
    get_override(&format!("embed:{id}:enabled")).is_none_or(|value| value.trim() != "0")
}

/// An admin-registered custom Stremio stream-addon provider. Only identity lives
/// here; enable/disable + rank ride the shared override store (`embed:<id>:*`), so
/// the existing `/set` endpoint and Rankings UI manage them with no extra plumbing.
#[derive(Clone, Debug)]
pub struct CustomProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
}

/// Default rank weight for custom providers — a low fallback tier (below the
/// compiled embeds' floor), so a freshly added addon only fires when better
/// sources miss. Admins can re-rank it live via `embed:<id>:rank`.
pub const CUSTOM_PROVIDER_DEFAULT_RANK: i64 = 300;

static CUSTOM_PROVIDERS: OnceLock<RwLock<Vec<CustomProvider>>> = OnceLock::new();

fn custom_store() -> &'static RwLock<Vec<CustomProvider>> {
    CUSTOM_PROVIDERS.get_or_init(|| RwLock::new(Vec::new()))
}

/// Replace the whole custom-provider list (called once at startup from the DB).
pub fn load_custom(list: Vec<CustomProvider>) {
    if let Ok(mut guard) = custom_store().write() {
        *guard = list;
    }
}

/// Add or update a custom provider in memory (`id` is the stable key).
pub fn add_custom(provider: CustomProvider) {
    if let Ok(mut guard) = custom_store().write() {
        if let Some(existing) = guard.iter_mut().find(|item| item.id == provider.id) {
            *existing = provider;
        } else {
            guard.push(provider);
        }
    }
}

/// Remove a custom provider by id; returns true if one was actually removed.
pub fn remove_custom(id: &str) -> bool {
    if let Ok(mut guard) = custom_store().write() {
        let before = guard.len();
        guard.retain(|item| item.id != id);
        return guard.len() != before;
    }
    false
}

/// Snapshot of all custom providers (used by the resolver and the catalog).
pub fn list_custom() -> Vec<CustomProvider> {
    custom_store()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Whether `id` is a registered custom provider.
pub fn is_custom(id: &str) -> bool {
    custom_store()
        .read()
        .map(|guard| guard.iter().any(|item| item.id == id))
        .unwrap_or(false)
}

/// The stored Stremio-addon base URL for a custom provider id, if registered.
pub fn custom_base(id: &str) -> Option<String> {
    custom_store().read().ok().and_then(|guard| {
        guard
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.base_url.clone())
    })
}

/// Default ranking weight per embed provider — the de-facto reliability tier that
/// drives the Server-menu order and the auto-pick/fallback order in the resolver
/// (see `external_embed_source_availability_score`). Higher = preferred / shown
/// first. Admins can override any of these live via `embed:<id>:rank`; live
/// per-title health still nudges the final order by a capped amount on top of
/// this baseline.
///
/// LordFlix ranks first: its segments stream to the browser directly off its CDN
/// (tiktokcdn, CORS-open), off the mini's bandwidth-limited uplink, so it's both
/// fastest and cheapest for our origin. VidRock shares that pipeline server-side.
/// Both rank above the flaky ones (VidLink/VixSrc gate on TLS fingerprint, Icefy's
/// upstream rate-limits). The Aether-backed gallic/meridian are low-tier cached
/// third-party fallbacks. NebulaStreams (a Stremio addon, env-gated) ranks lowest:
/// it only returns a usable direct-HLS stream for a subset of titles, so it fires
/// last, after every first-party source misses.
pub const EMBED_DEFAULT_RANK: &[(&str, i64)] = &[
    ("lordflix", 1_600),
    ("vidrock", 1_400),
    ("notorrent", 1_100),
    ("vidlink", 950),
    ("vixsrc", 800),
    ("videasy", 700),
    ("icefy", 500),
    ("gallic", 450),
    ("meridian", 400),
    ("nebula", 380),
];

/// Compiled default ranking weight for an embed provider (custom providers get
/// `CUSTOM_PROVIDER_DEFAULT_RANK`; 0 if the id is unknown entirely).
pub fn embed_default_rank(id: &str) -> i64 {
    EMBED_DEFAULT_RANK
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, value)| *value)
        .unwrap_or_else(|| {
            if is_custom(id) {
                CUSTOM_PROVIDER_DEFAULT_RANK
            } else {
                0
            }
        })
}

/// The admin rank override for an embed provider, if a valid one is set.
pub fn embed_rank_override(id: &str) -> Option<i64> {
    get_override(&format!("embed:{id}:rank")).and_then(|raw| raw.trim().parse::<i64>().ok())
}

/// Effective ranking weight: the admin override if set, else the compiled default.
pub fn embed_rank(id: &str) -> i64 {
    embed_rank_override(id).unwrap_or_else(|| embed_default_rank(id))
}

/// What kind of write a key accepts, or `None` if it is not admin-writable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    /// A URL override (empty value clears it).
    Url,
    /// An enable/disable flag ("0"/"1").
    Toggle,
    /// A ranking weight (a whole number; empty value clears it).
    Rank,
}

pub fn classify_writable(key: &str) -> Option<WriteKind> {
    // live:<channelId>:<streamId>
    if key.starts_with("live:") && key.matches(':').count() >= 2 {
        return Some(WriteKind::Url);
    }
    match key {
        keys::SPORTS_STREAMED_MATCHES
        | keys::SPORTS_STREAMED_FOOTBALL
        | keys::SPORTS_STREAMED_BASKETBALL
        | keys::SPORTS_MATCHSTREAM_WEBMASTER
        | keys::SPORTS_MATCHSTREAM_VIEWER
        | keys::SPORTS_NTVS_SEARCH
        | keys::INFRA_APP_ORIGIN
        | keys::INFRA_TORRENTIO => Some(WriteKind::Url),
        _ => {
            let rest = key.strip_prefix("embed:")?;
            if let Some(id) = rest.strip_suffix(":enabled") {
                return (EMBED_IDS.contains(&id) || is_custom(id)).then_some(WriteKind::Toggle);
            }
            if let Some(id) = rest.strip_suffix(":rank") {
                return (EMBED_IDS.contains(&id) || is_custom(id)).then_some(WriteKind::Rank);
            }
            None
        }
    }
}

/// One row in the admin Providers table for a backend-resolved provider.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub key: String,
    pub group: String,
    pub label: String,
    #[serde(rename = "defaultUrl")]
    pub default_url: String,
    #[serde(rename = "effectiveUrl")]
    pub effective_url: String,
    pub overridden: bool,
    /// URL is admin-swappable.
    pub editable: bool,
    /// Has an enable/disable toggle (embed providers).
    pub toggle: bool,
    pub enabled: bool,
    /// Effective ranking weight (embed providers only; higher = shown first).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<i64>,
    /// Compiled default ranking weight (embed providers only).
    #[serde(rename = "rankDefault", skip_serializing_if = "Option::is_none")]
    pub rank_default: Option<i64>,
    /// Whether the ranking weight is admin-overridden.
    #[serde(rename = "rankOverridden")]
    pub rank_overridden: bool,
    /// True for admin-added custom Stremio-addon providers (vs compiled ones).
    pub custom: bool,
    /// Whether this provider can be deleted from the dashboard (custom only).
    pub removable: bool,
    pub note: String,
}

fn url_entry(key: &str, group: &str, label: &str, default_url: &str, note: &str) -> ProviderInfo {
    let override_value = get_override(key);
    ProviderInfo {
        key: key.to_owned(),
        group: group.to_owned(),
        label: label.to_owned(),
        default_url: default_url.to_owned(),
        effective_url: override_value
            .clone()
            .unwrap_or_else(|| default_url.to_owned()),
        overridden: override_value.is_some(),
        editable: true,
        toggle: false,
        enabled: true,
        rank: None,
        rank_default: None,
        rank_overridden: false,
        custom: false,
        removable: false,
        note: note.to_owned(),
    }
}

/// The backend-known provider catalog (sports, embed, infra). Live channels are
/// assembled on the frontend from the compiled channel list + `live_overrides()`.
pub fn catalog(config: &Config) -> Vec<ProviderInfo> {
    // ── Sports stream APIs (URL-swappable) ──────────────────────────────────
    let mut out = vec![
        url_entry(
            keys::SPORTS_ESPN_FOOTBALL,
            "sports",
            "ESPN · football fixtures",
            crate::football::ESPN_FOOTBALL_SCOREBOARD_URL,
            "Broad football fixture scoreboard; contains no playback URLs",
        ),
        url_entry(
            keys::SPORTS_STREAMED_FOOTBALL,
            "sports",
            "Streamed · football schedule",
            crate::football::STREAMED_FOOTBALL_MATCHES_URL,
            "streamed.pk football match list",
        ),
        url_entry(
            keys::SPORTS_STREAMED_BASKETBALL,
            "sports",
            "Streamed · basketball schedule",
            crate::football::STREAMED_BASKETBALL_MATCHES_URL,
            "streamed.pk basketball match list",
        ),
        url_entry(
            keys::SPORTS_STREAMED_MATCHES,
            "sports",
            "Streamed · matches base",
            crate::football::STREAMED_MATCHES_BASE_URL,
            "Base for other sport categories (/{sport} is appended)",
        ),
        url_entry(
            keys::SPORTS_MATCHSTREAM_WEBMASTER,
            "sports",
            "MatchStream · webmaster",
            crate::football::MATCHSTREAM_WEBMASTER_URL,
            "matchstream.do discovery + referer",
        ),
        url_entry(
            keys::SPORTS_MATCHSTREAM_VIEWER,
            "sports",
            "MatchStream · viewer",
            crate::football::MATCHSTREAM_VIEWER_URL,
            "matchstream.do viewer endpoint",
        ),
        url_entry(
            keys::SPORTS_NTVS_SEARCH,
            "sports",
            "NTVS · search",
            crate::football::NTVS_SEARCH_URL,
            "ntvs.cx football search API",
        ),
    ];

    // ── External VOD embeds (enable/disable; base shown for reference) ───────
    // Display bases mirror `resolver::external_embed_url`. They are reference-only
    // (testable) — the URL itself is not swappable because each host is coupled to
    // per-provider referer/fingerprint handling in the resolver.
    const EMBED_BASES: &[(&str, &str, &str)] = &[
        ("videasy", "VidEasy", "https://player.videasy.to"),
        ("vidlink", "VidLink", "https://vidlink.pro"),
        ("vidrock", "VidRock", "https://vidrock.net"),
        ("notorrent", "NoTorrent", "https://addon-osvh.onrender.com"),
        ("vixsrc", "VixSrc", "https://vixsrc.to"),
        ("lordflix", "LordFlix", "https://snowhouse.lordflix.club"),
        ("icefy", "Icefy", "https://streams.icefy.top"),
        ("meridian", "Meridian", "https://meridian.aether.bar"),
        ("gallic", "Gallic", "https://gallic.aether.bar"),
        // Reference base only — the real install URL (with its private token) is
        // supplied via the NEBULA_ADDON_BASE env var and never shown/stored here.
        ("nebula", "NebulaStreams", "https://nebula.work.gd"),
    ];
    for (id, label, base) in EMBED_BASES.iter().copied() {
        out.push(ProviderInfo {
            key: format!("embed:{id}:enabled"),
            group: "embed".to_owned(),
            label: label.to_owned(),
            default_url: base.to_owned(),
            effective_url: base.to_owned(),
            overridden: get_override(&format!("embed:{id}:enabled")).is_some(),
            editable: false,
            toggle: true,
            enabled: embed_enabled(id),
            rank: Some(embed_rank(id)),
            rank_default: Some(embed_default_rank(id)),
            rank_overridden: embed_rank_override(id).is_some(),
            custom: false,
            removable: false,
            note: "Enable/disable + ranking weight — base URL is coupled to resolver host logic"
                .to_owned(),
        });
    }

    // ── Admin-added custom Stremio stream addons ─────────────────────────────
    // Identity comes from the `custom_providers` table; enable/rank ride the same
    // `embed:<id>:*` override store as the compiled embeds, so the Rankings UI
    // treats them identically (plus a Remove button via `removable`).
    for provider in list_custom() {
        let enabled_key = format!("embed:{}:enabled", provider.id);
        out.push(ProviderInfo {
            key: enabled_key.clone(),
            group: "embed".to_owned(),
            label: provider.label.clone(),
            default_url: provider.base_url.clone(),
            effective_url: provider.base_url.clone(),
            overridden: get_override(&enabled_key).is_some(),
            editable: false,
            toggle: true,
            enabled: embed_enabled(&provider.id),
            rank: Some(embed_rank(&provider.id)),
            rank_default: Some(embed_default_rank(&provider.id)),
            rank_overridden: embed_rank_override(&provider.id).is_some(),
            custom: true,
            removable: true,
            note: "Custom Stremio stream addon — added from the dashboard".to_owned(),
        });
    }

    // ── Infra / origin URLs ─────────────────────────────────────────────────
    out.push(url_entry(
        keys::INFRA_APP_ORIGIN,
        "infra",
        "App origin",
        &config.app_origin,
        "Public origin for email verification / reset links",
    ));
    out.push(url_entry(
        keys::INFRA_TORRENTIO,
        "infra",
        "Torrentio base",
        &config.torrentio_base_url,
        "Torrent addon discovery base",
    ));
    // Live-HLS worker base feeds the hot per-segment rewrite path; a bad value
    // would 404 every live segment, so it stays env-controlled (view/test only).
    let worker_base = config.live_hls_resource_worker_base.trim();
    out.push(ProviderInfo {
        key: keys::INFRA_LIVE_HLS_WORKER.to_owned(),
        group: "infra".to_owned(),
        label: "Live-HLS segment worker".to_owned(),
        default_url: worker_base.to_owned(),
        effective_url: worker_base.to_owned(),
        overridden: false,
        editable: false,
        toggle: false,
        enabled: true,
        rank: None,
        rank_default: None,
        rank_overridden: false,
        custom: false,
        removable: false,
        note: "Env-controlled (LIVE_HLS_RESOURCE_WORKER_BASE) — on the hot segment path".to_owned(),
    });

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_writable_recognizes_each_group() {
        assert_eq!(
            classify_writable(keys::SPORTS_NTVS_SEARCH),
            Some(WriteKind::Url)
        );
        assert_eq!(
            classify_writable(keys::INFRA_APP_ORIGIN),
            Some(WriteKind::Url)
        );
        assert_eq!(
            classify_writable("live:bbc-news:roku-1080p"),
            Some(WriteKind::Url)
        );
        assert_eq!(
            classify_writable("embed:vidlink:enabled"),
            Some(WriteKind::Toggle)
        );
        assert_eq!(
            classify_writable("embed:vidlink:rank"),
            Some(WriteKind::Rank)
        );
        // Not writable: unknown embed id, the env-only worker base, malformed keys.
        assert_eq!(classify_writable("embed:bogus:enabled"), None);
        assert_eq!(classify_writable("embed:bogus:rank"), None);
        assert_eq!(classify_writable(keys::INFRA_LIVE_HLS_WORKER), None);
        assert_eq!(classify_writable("live:onlyonepart"), None);
        assert_eq!(classify_writable("random:key"), None);
    }

    #[test]
    fn embed_rank_prefers_override_then_compiled_default() {
        // Use a real embed id but restore it after so parallel tests that read the
        // process-global store aren't affected.
        let id = "vixsrc";
        assert_eq!(embed_rank(id), embed_default_rank(id));
        assert_eq!(embed_rank_override(id), None);
        set(&format!("embed:{id}:rank"), "1750");
        assert_eq!(embed_rank_override(id), Some(1750));
        assert_eq!(embed_rank(id), 1750);
        // A non-numeric override is ignored (falls back to the default).
        set(&format!("embed:{id}:rank"), "oops");
        assert_eq!(embed_rank_override(id), None);
        assert_eq!(embed_rank(id), embed_default_rank(id));
        // Clearing restores the default.
        set(&format!("embed:{id}:rank"), "");
        assert_eq!(embed_rank(id), embed_default_rank(id));
    }

    #[test]
    fn every_embed_id_has_a_default_rank() {
        for id in EMBED_IDS {
            assert!(
                embed_default_rank(id) > 0,
                "embed id {id} is missing a default rank weight"
            );
        }
    }

    #[test]
    fn resolve_prefers_override_then_default() {
        // Synthetic key no other code/test reads, so the process-global store can't
        // cross-contaminate parallel tests.
        let key = "test:__registry_probe_resolve";
        assert_eq!(
            resolve(key, "https://default.example"),
            "https://default.example"
        );
        set(key, "https://override.example");
        assert_eq!(
            resolve(key, "https://default.example"),
            "https://override.example"
        );
        assert_eq!(
            get_override(key).as_deref(),
            Some("https://override.example")
        );
        // An empty/whitespace value clears the override.
        set(key, "   ");
        assert_eq!(
            resolve(key, "https://default.example"),
            "https://default.example"
        );
        assert_eq!(get_override(key), None);
    }

    #[test]
    fn embed_enabled_defaults_true_and_honors_disable_flag() {
        let id = "test_fake_embed_probe";
        assert!(embed_enabled(id));
        set(&format!("embed:{id}:enabled"), "0");
        assert!(!embed_enabled(id));
        set(&format!("embed:{id}:enabled"), "");
        assert!(embed_enabled(id));
    }
}

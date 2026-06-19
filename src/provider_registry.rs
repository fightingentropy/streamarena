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

    pub const INFRA_APP_ORIGIN: &str = "infra:app-origin";
    pub const INFRA_TORRENTIO: &str = "infra:torrentio";
    pub const INFRA_LIVE_HLS_WORKER: &str = "infra:live-hls-worker";
}

/// Provider ids of the external VOD embeds. Their base URLs are deeply coupled to
/// per-host referer/fingerprint logic in the resolver, so they are not URL-
/// swappable; the dashboard exposes an enable/disable toggle instead.
pub const EMBED_IDS: &[&str] = &[
    "videasy", "vidlink", "vidrock", "notorrent", "vixsrc", "lordflix", "icefy", "meridian",
    "gallic",
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
    store().read().ok().and_then(|guard| guard.get(key).cloned())
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
    get_override(&format!("embed:{id}:enabled")).map_or(true, |value| value.trim() != "0")
}

/// What kind of write a key accepts, or `None` if it is not admin-writable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    /// A URL override (empty value clears it).
    Url,
    /// An enable/disable flag ("0"/"1").
    Toggle,
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
        _ => key
            .strip_prefix("embed:")
            .and_then(|rest| rest.strip_suffix(":enabled"))
            .filter(|id| EMBED_IDS.contains(id))
            .map(|_| WriteKind::Toggle),
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
    pub note: String,
}

fn url_entry(key: &str, group: &str, label: &str, default_url: &str, note: &str) -> ProviderInfo {
    let override_value = get_override(key);
    ProviderInfo {
        key: key.to_owned(),
        group: group.to_owned(),
        label: label.to_owned(),
        default_url: default_url.to_owned(),
        effective_url: override_value.clone().unwrap_or_else(|| default_url.to_owned()),
        overridden: override_value.is_some(),
        editable: true,
        toggle: false,
        enabled: true,
        note: note.to_owned(),
    }
}

/// The backend-known provider catalog (sports, embed, infra). Live channels are
/// assembled on the frontend from the compiled channel list + `live_overrides()`.
pub fn catalog(config: &Config) -> Vec<ProviderInfo> {
    let mut out = Vec::new();

    // ── Sports stream APIs (URL-swappable) ──────────────────────────────────
    out.push(url_entry(
        keys::SPORTS_STREAMED_FOOTBALL,
        "sports",
        "Streamed · football schedule",
        crate::football::STREAMED_FOOTBALL_MATCHES_URL,
        "streamed.pk football match list",
    ));
    out.push(url_entry(
        keys::SPORTS_STREAMED_BASKETBALL,
        "sports",
        "Streamed · basketball schedule",
        crate::football::STREAMED_BASKETBALL_MATCHES_URL,
        "streamed.pk basketball match list",
    ));
    out.push(url_entry(
        keys::SPORTS_STREAMED_MATCHES,
        "sports",
        "Streamed · matches base",
        crate::football::STREAMED_MATCHES_BASE_URL,
        "Base for other sport categories (/{sport} is appended)",
    ));
    out.push(url_entry(
        keys::SPORTS_MATCHSTREAM_WEBMASTER,
        "sports",
        "MatchStream · webmaster",
        crate::football::MATCHSTREAM_WEBMASTER_URL,
        "matchstream.do discovery + referer",
    ));
    out.push(url_entry(
        keys::SPORTS_MATCHSTREAM_VIEWER,
        "sports",
        "MatchStream · viewer",
        crate::football::MATCHSTREAM_VIEWER_URL,
        "matchstream.do viewer endpoint",
    ));
    out.push(url_entry(
        keys::SPORTS_NTVS_SEARCH,
        "sports",
        "NTVS · search",
        crate::football::NTVS_SEARCH_URL,
        "ntvs.cx football search API",
    ));

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
            note: "Enable/disable only — base URL is coupled to resolver host logic".to_owned(),
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
        // Not writable: unknown embed id, the env-only worker base, malformed keys.
        assert_eq!(classify_writable("embed:bogus:enabled"), None);
        assert_eq!(classify_writable(keys::INFRA_LIVE_HLS_WORKER), None);
        assert_eq!(classify_writable("live:onlyonepart"), None);
        assert_eq!(classify_writable("random:key"), None);
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
        assert_eq!(get_override(key).as_deref(), Some("https://override.example"));
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

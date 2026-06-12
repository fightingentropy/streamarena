//! Background edge pre-warmer.
//!
//! The biggest remaining cold spot after the streaming speedups is the *first-ever*
//! play of a popular title: its segments aren't in the Cloudflare edge yet, so the
//! first viewer pulls them through the mini's ~33 Mbps home uplink (a slow cold
//! MISS). Every viewer after that gets an edge HIT, off the uplink.
//!
//! This task closes that gap by periodically fetching the first few segments of the
//! most popular movies *through the public, Cloudflare-fronted origin* — paying the
//! one-time uplink cost in the background so the first real viewer also lands on an
//! edge HIT. It reuses the home-page's already-cached popular list (what users are
//! most likely to click) and is paced + bounded so it never meaningfully competes
//! with live viewers for the uplink or the resolver.
//!
//! Inert in local dev: it only runs when the app origin is a public https URL (so a
//! warm fetch actually traverses Cloudflare) and `EDGE_PREWARM_ENABLED` is not set
//! to a falsey value.

use std::time::Duration;

use serde_json::Value;

use crate::routes::AppState;

/// Wait after boot before the first cycle so the home-bootstrap cache (the title
/// source) has refreshed.
const PREWARM_STARTUP_DELAY: Duration = Duration::from_secs(90);
/// How often to run a warm cycle. Segments stay edge-cached for 1h (max-age=3600),
/// so a 20-min cadence keeps the popular set warm with generous headroom while a
/// re-warm of an already-cached segment is a cheap edge HIT (download only, no
/// origin/uplink fetch).
const PREWARM_INTERVAL: Duration = Duration::from_secs(20 * 60);
/// Most popular movies warmed per cycle.
const PREWARM_MAX_TITLES: usize = 8;
/// First N segments warmed per title — enough to cover the initial buffer so the
/// player's time-to-first-frame is an edge HIT.
const PREWARM_SEGMENTS_PER_TITLE: usize = 3;
/// Pace between titles so a cycle is a trickle, not a burst that contends with live
/// viewers for the uplink or the 2-permit resolver.
const PREWARM_TITLE_DELAY: Duration = Duration::from_secs(3);
/// Pace between segment warms within a title.
const PREWARM_SEGMENT_DELAY: Duration = Duration::from_millis(500);
/// Per-request bound on a warm fetch.
const PREWARM_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Sentinel user id for system-initiated resolves (no account; takes the
/// external-embed path because no Real-Debrid key is supplied).
const PREWARM_SYSTEM_USER_ID: i64 = 0;

/// Spawn the background edge pre-warm loop. No-op (returns without spawning) when
/// pre-warming is disabled or the origin isn't a public https URL.
pub fn spawn_edge_prewarm(state: AppState) {
    if !edge_prewarm_enabled(&state.config.app_origin) {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(PREWARM_STARTUP_DELAY).await;
        let mut interval = tokio::time::interval(PREWARM_INTERVAL);
        loop {
            interval.tick().await;
            run_prewarm_cycle(&state).await;
        }
    });
}

/// Pre-warming is on unless `EDGE_PREWARM_ENABLED` is explicitly falsey, and only
/// when the origin is a public https URL — otherwise a warm fetch would never reach
/// Cloudflare and there'd be nothing to warm (local dev, direct-to-origin).
fn edge_prewarm_enabled(app_origin: &str) -> bool {
    let disabled = std::env::var("EDGE_PREWARM_ENABLED")
        .map(|value| matches!(value.trim(), "0" | "false" | "off" | "no"))
        .unwrap_or(false);
    if disabled {
        return false;
    }
    let origin = app_origin.trim();
    origin.starts_with("https://")
        && !origin.contains("localhost")
        && !origin.contains("127.0.0.1")
        && !origin.contains(".local")
}

async fn run_prewarm_cycle(state: &AppState) {
    let title_ids = popular_movie_ids(state).await;
    if title_ids.is_empty() {
        return;
    }
    let mut warmed = 0_usize;
    for tmdb_id in title_ids.into_iter().take(PREWARM_MAX_TITLES) {
        prewarm_movie(state, &tmdb_id).await;
        warmed += 1;
        tokio::time::sleep(PREWARM_TITLE_DELAY).await;
    }
    tracing::debug!(titles = warmed, "edge pre-warm cycle complete");
}

/// Top popular movie ids, sourced from the already-cached home-bootstrap payload
/// (the rails the home page shows). Drawn from a few movie rails and de-duplicated
/// so a cycle covers a useful spread of the most-clickable titles.
async fn popular_movie_ids(state: &AppState) -> Vec<String> {
    let payload = state
        .home_bootstrap_cache
        .payload_or_refresh(state.clone())
        .await;
    extract_popular_movie_ids(&payload)
}

fn extract_popular_movie_ids(payload: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for rail in ["popular", "crowdPleasers", "topRated"] {
        let Some(results) = payload
            .get(rail)
            .and_then(|value| value.get("results"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for item in results {
            if let Some(id) = item.get("id").and_then(tmdb_id_to_string)
                && seen.insert(id.clone())
            {
                ids.push(id);
            }
        }
    }
    ids
}

/// TMDB ids arrive as JSON numbers; accept a string form too for robustness.
fn tmdb_id_to_string(value: &Value) -> Option<String> {
    if let Some(number) = value.as_i64() {
        if number > 0 {
            return Some(number.to_string());
        }
        return None;
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_owned)
}

/// Resolve one movie and fetch its first few segments through the public origin so
/// Cloudflare caches them. Best-effort: any failure (resolve miss, non-embed source,
/// fetch error) just skips the title.
async fn prewarm_movie(state: &AppState, tmdb_id: &str) {
    let resolved = match state
        .resolver
        .resolve_movie(
            PREWARM_SYSTEM_USER_ID,
            "",
            false,
            tmdb_id,
            "",
            "",
            "auto",
            "auto",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "auto",
            false,
        )
        .await
    {
        Ok(value) => value,
        Err(_) => return,
    };

    let Some(playable) = resolved.get("playableUrl").and_then(Value::as_str) else {
        return;
    };
    // Only the proxied external-embed path benefits — direct/off-uplink and local
    // sources don't transit the edge cache we're warming.
    if !playable.starts_with("/api/live/hls.m3u8") {
        return;
    }

    let origin = state.config.app_origin.trim_end_matches('/');
    let Some(master) = warm_fetch_text(state, &join_origin(origin, playable)).await else {
        return;
    };
    let Some(variant_line) = first_playlist_uri(&master) else {
        return;
    };
    let Some(variant_url) = origin_segment_url(origin, &variant_line) else {
        return;
    };
    let Some(media) = warm_fetch_text(state, &variant_url).await else {
        return;
    };

    for segment_line in playlist_segment_uris(&media)
        .into_iter()
        .take(PREWARM_SEGMENTS_PER_TITLE)
    {
        if let Some(segment_url) = origin_segment_url(origin, &segment_line) {
            warm_fetch_discard(state, &segment_url).await;
            tokio::time::sleep(PREWARM_SEGMENT_DELAY).await;
        }
    }
}

/// First playlist URI line (a variant in a master, the top non-comment line).
fn first_playlist_uri(playlist: &str) -> Option<String> {
    playlist
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
}

/// All segment URI lines of a media playlist, in order.
fn playlist_segment_uris(playlist: &str) -> Vec<String> {
    playlist
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

/// Build an absolute warm-fetch URL for a playlist line, but only for our own
/// proxied `/api/live/*` paths — absolute off-uplink CDN URLs (e.g. LordFlix direct)
/// don't traverse our edge and are left alone.
fn origin_segment_url(origin: &str, line: &str) -> Option<String> {
    if line.starts_with("/api/live/") {
        Some(join_origin(origin, line))
    } else {
        None
    }
}

fn join_origin(origin: &str, path: &str) -> String {
    format!("{}{}", origin.trim_end_matches('/'), path)
}

/// Fetch a playlist as text through the public origin (warming the edge as a side
/// effect). Returns None on any error or non-success status.
async fn warm_fetch_text(state: &AppState, url: &str) -> Option<String> {
    let response = state
        .http_client
        .get(url)
        .timeout(PREWARM_FETCH_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

/// Fetch a segment fully (so Cloudflare caches the complete object) and discard the
/// body. Best-effort — errors are ignored.
async fn warm_fetch_discard(state: &AppState, url: &str) {
    let Ok(response) = state
        .http_client
        .get(url)
        .timeout(PREWARM_FETCH_TIMEOUT)
        .send()
        .await
    else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    // Drain the body so the full object is fetched and edge-cached.
    let _ = response.bytes().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prewarm_enabled_only_for_public_https_origin() {
        assert!(edge_prewarm_enabled("https://streamthatshit.com"));
        assert!(!edge_prewarm_enabled("http://streamthatshit.com"));
        assert!(!edge_prewarm_enabled("https://localhost:5173"));
        assert!(!edge_prewarm_enabled("https://127.0.0.1"));
        assert!(!edge_prewarm_enabled("https://mini.local"));
        assert!(!edge_prewarm_enabled(""));
    }

    #[test]
    fn extracts_and_dedupes_popular_movie_ids() {
        let payload = json!({
            "popular": { "results": [ { "id": 27205 }, { "id": 157336 }, { "id": 0 } ] },
            "crowdPleasers": { "results": [ { "id": 157336 }, { "id": 155 }, { "title": "no id" } ] },
            "topRated": { "results": [ { "id": "872585" } ] },
        });
        // 157336 appears twice -> de-duped; 0 and the id-less item are skipped; the
        // string id is accepted.
        assert_eq!(
            extract_popular_movie_ids(&payload),
            vec!["27205", "157336", "155", "872585"]
        );
    }

    #[test]
    fn extracts_nothing_from_warming_payload() {
        let payload = json!({ "popular": { "results": [] } });
        assert!(extract_popular_movie_ids(&payload).is_empty());
    }

    #[test]
    fn picks_first_variant_and_all_segments() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n/api/live/hls.m3u8?input=v720&sig=a\n#EXT-X-STREAM-INF:BANDWIDTH=720000\n/api/live/hls.m3u8?input=v360&sig=b\n";
        assert_eq!(
            first_playlist_uri(master).as_deref(),
            Some("/api/live/hls.m3u8?input=v720&sig=a")
        );
        let media = "#EXTM3U\n#EXTINF:4.0,\n/api/live/hls-resource?input=s1&sig=a&vod=1\n#EXTINF:4.0,\n/api/live/hls-resource?input=s2&sig=b&vod=1\n#EXT-X-ENDLIST\n";
        let segments = playlist_segment_uris(media);
        assert_eq!(segments.len(), 2);
        assert!(segments[0].contains("s1"));
    }

    #[test]
    fn only_proxies_our_live_paths_not_offuplink_cdns() {
        let origin = "https://streamthatshit.com";
        assert_eq!(
            origin_segment_url(origin, "/api/live/hls-resource?input=s1&sig=a").as_deref(),
            Some("https://streamthatshit.com/api/live/hls-resource?input=s1&sig=a")
        );
        // Off-uplink absolute CDN URLs (LordFlix direct etc.) are not warmed via origin.
        assert_eq!(
            origin_segment_url(origin, "https://p16-sg.tiktokcdn.com/seg-1.ts"),
            None
        );
    }
}

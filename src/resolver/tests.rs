use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::json;
use tokio::sync::{Notify, Semaphore, oneshot};

use crate::error::ApiError;
use crate::media::{AudioTrack, MediaProbe};

use super::finalize_external_embed_payload;
use super::race_staggered_first_success;
use super::{
    BoxResolverAttempt, CachedResolvedEmbed, EXTERNAL_EMBED_HEDGE_STAGGER_MS,
    FASTEST_PROVIDER_HEDGE_STAGGER, RealDebridValidationControl, ResolvedEmbedCache,
    acquire_owned_real_debrid_torrent_lease, cache_reuse_provider_for_context,
    complete_real_debrid_attempt_with_lease, compute_external_embed_provider_rank_health_score,
    external_embed_resolve_cache_key, race_staggered_resolver_attempts,
};
use super::{
    DiscoveryBehaviorHints, DiscoveryStream, EXTERNAL_EMBED_PROVIDERS, ExternalEmbedSource,
    LocalTorrentResolvedSource, PlaybackSession, RD_SELECTED_FILE_MISMATCH_ERROR, ResolveFilters,
    ResolveMetadata, ResolvePreferences, ResolvedSource, ResolverExternalGuard, ResolverMetrics,
    ResolverProvider, SOURCE_HEALTH_AVOID_SCORE, SourceFilters, SourceHealthStats,
    build_external_embed_source_summaries, build_movie_resolve_lock_key,
    build_playback_session_key_for_metadata, build_rd_torrent_cache_key,
    build_real_debrid_cache_scope, build_real_debrid_unrestrict_form,
    build_scoped_rd_torrent_cache_key, build_torrentio_stream_cache_key,
    build_torznab_download_cache_key, build_torznab_request_url, build_torznab_stream_cache_key,
    build_tv_resolve_lock_key, build_user_scoped_playback_session_key_for_metadata,
    collect_episode_signatures, compute_external_embed_rank_health_score,
    compute_source_health_score, compute_torrentio_cache_deadlines, default_external_embed_source,
    does_filename_likely_match_movie, external_embed_hls_candidate_sources,
    external_embed_source_for_source_hash, external_embed_source_hash,
    external_embed_source_rank_score, external_embed_sources, external_embed_url,
    extract_aether_proxied_origin, extract_info_hash_from_magnet,
    is_default_external_embed_hls_fallback_source, is_external_embed_hls_capable_source,
    is_persistent_source_resolve_error, is_public_external_embed_hls_hostname,
    is_supported_external_embed_hls_embed_url, is_supported_external_embed_hls_url,
    local_cache_upgrade_payload, merge_discovery_query_results, merge_discovery_streams,
    normalize_allowed_formats, normalize_nebula_addon_base,
    normalize_resolved_source_for_software_decode, normalize_resolver_provider,
    normalize_source_audio_profile_filter, normalize_source_hash, now_ms,
    parse_ready_real_debrid_hashes, parse_ready_real_debrid_torrents,
    parse_runtime_from_label_seconds, parse_seed_count, parse_size_label_bytes,
    parse_torrentio_streams_payload, parse_torznab_xml, playback_session_key_allowed_for_user,
    playback_session_matches_preferred_container, playback_session_matches_preferred_quality,
    playback_session_matches_source_hash, prefer_mp4_default_candidates,
    prioritize_local_torrent_first_wave, ready_info_has_selected_file_id,
    real_debrid_apple_transcode_url, score_stream_episode_match, select_resolved_track_indexes,
    select_top_episode_candidates, select_top_movie_candidates,
    should_allow_latest_playback_session_fallback, should_prefer_default_external_embed,
    should_prefer_software_decode_source, should_resolve_torrent_candidates,
    should_skip_playback_session_reuse, sort_movie_candidates, stream_list_contains_hash,
    stremio_addon_stream_url, summarize_stream_candidate_for_client, torrent_playback_enabled,
    torznab_download_url_allowed, user_facing_real_debrid_error, validate_real_debrid_user_payload,
};

use std::sync::Mutex as StdMutex;
use std::time::Duration;

/// Build an attempt future that records when it actually starts running (so a
/// test can assert the hedge never launches a redundant attempt), sleeps for
/// `delay`, then yields `result`.
async fn hedge_attempt(
    started: Arc<StdMutex<Vec<usize>>>,
    index: usize,
    delay: Duration,
    result: Option<&'static str>,
) -> Option<&'static str> {
    started.lock().unwrap().push(index);
    tokio::time::sleep(delay).await;
    result
}

async fn resolver_provider_attempt(
    started: Arc<StdMutex<Vec<usize>>>,
    index: usize,
    delay: Duration,
    succeeds: bool,
) -> Result<serde_json::Value, ApiError> {
    started.lock().unwrap().push(index);
    tokio::time::sleep(delay).await;
    if succeeds {
        Ok(json!({ "winner": index }))
    } else {
        Err(ApiError::bad_gateway(format!("provider {index} failed")))
    }
}

#[tokio::test]
async fn owned_real_debrid_add_cleans_after_caller_cancels_before_response() {
    let (provider_accepted_tx, provider_accepted_rx) = oneshot::channel();
    let (provider_response_tx, provider_response_rx) = oneshot::channel();
    let (cleanup_complete_tx, cleanup_complete_rx) = oneshot::channel();
    let cleanup_runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let caller = tokio::spawn({
        let cleanup_runs = cleanup_runs.clone();
        async move {
            acquire_owned_real_debrid_torrent_lease(
                async move {
                    let _ = provider_accepted_tx.send(());
                    let _ = provider_response_rx.await;
                    Ok("created-torrent-id".to_owned())
                },
                move |torrent_id| async move {
                    assert_eq!(torrent_id, "created-torrent-id");
                    cleanup_runs.fetch_add(1, Ordering::SeqCst);
                    let _ = cleanup_complete_tx.send(());
                },
            )
            .await
        }
    });

    provider_accepted_rx
        .await
        .expect("owned add task should reach the provider");
    caller.abort();
    assert!(caller.await.is_err());
    let _ = provider_response_tx.send(());
    tokio::time::timeout(Duration::from_secs(1), cleanup_complete_rx)
        .await
        .expect("accepted torrent should be cleaned after caller cancellation")
        .expect("cleanup should signal completion");
    assert_eq!(cleanup_runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn owned_real_debrid_cleanup_waits_for_delete_completion() {
    let (cleanup_started_tx, cleanup_started_rx) = oneshot::channel();
    let (allow_cleanup_tx, allow_cleanup_rx) = oneshot::channel();
    let lease = acquire_owned_real_debrid_torrent_lease(
        async { Ok("created-torrent-id".to_owned()) },
        move |_| async move {
            let _ = cleanup_started_tx.send(());
            let _ = allow_cleanup_rx.await;
        },
    )
    .await
    .expect("lease should be acquired");

    let cleanup = tokio::spawn(lease.cleanup());
    cleanup_started_rx
        .await
        .expect("cleanup should start after the explicit decision");
    assert!(!cleanup.is_finished());
    let _ = allow_cleanup_tx.send(());
    cleanup.await.expect("cleanup task should finish");
}

#[tokio::test]
async fn owned_real_debrid_lease_survives_until_payload_completion() {
    let (payload_started_tx, payload_started_rx) = oneshot::channel();
    let (cleanup_complete_tx, cleanup_complete_rx) = oneshot::channel();
    let lease = acquire_owned_real_debrid_torrent_lease(
        async { Ok("created-torrent-id".to_owned()) },
        move |_| async move {
            let _ = cleanup_complete_tx.send(());
        },
    )
    .await
    .expect("lease should be acquired");
    let provider_attempt = tokio::spawn(complete_real_debrid_attempt_with_lease(
        Some(lease),
        async move {
            let _ = payload_started_tx.send(());
            std::future::pending::<Result<(), ApiError>>().await
        },
    ));

    payload_started_rx
        .await
        .expect("post-resolve payload work should start");
    provider_attempt.abort();
    assert!(provider_attempt.await.is_err());
    tokio::time::timeout(Duration::from_secs(1), cleanup_complete_rx)
        .await
        .expect("cancellation during payload work should clean the owned torrent")
        .expect("cleanup should signal completion");
}

#[tokio::test]
async fn real_debrid_validation_dedupes_concurrent_success_for_same_token() {
    let control = RealDebridValidationControl::with_limits(10, 10, 2);
    let validation_runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (first_started_tx, first_started_rx) = oneshot::channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let first = tokio::spawn({
        let control = control.clone();
        let validation_runs = validation_runs.clone();
        async move {
            control
                .validate(1, "192.0.2.10", "same-token", move || async move {
                    validation_runs.fetch_add(1, Ordering::SeqCst);
                    let _ = first_started_tx.send(());
                    let _ = release_first_rx.await;
                    Ok(())
                })
                .await
        }
    });
    first_started_rx
        .await
        .expect("first validation should reach the upstream seam");
    let second = tokio::spawn({
        let control = control.clone();
        let validation_runs = validation_runs.clone();
        async move {
            control
                .validate(2, "192.0.2.11", "same-token", move || async move {
                    validation_runs.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        }
    });

    let _ = release_first_tx.send(());
    first
        .await
        .expect("first validation task should finish")
        .expect("first validation should succeed");
    second
        .await
        .expect("second validation task should finish")
        .expect("same-token validation should reuse success");
    assert_eq!(validation_runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn real_debrid_validation_limits_each_user_and_client_ip() {
    let per_user = RealDebridValidationControl::with_limits(1, 10, 2);
    let first = per_user
        .validate(7, "192.0.2.20", "bad-token-a", || async {
            Err(ApiError::bad_request("invalid token"))
        })
        .await
        .expect_err("invalid token should fail validation");
    assert_eq!(first.status(), axum::http::StatusCode::BAD_REQUEST);
    let second = per_user
        .validate(7, "192.0.2.21", "bad-token-b", || async {
            panic!("per-user limiter should reject before validation")
        })
        .await
        .expect_err("second user attempt should be throttled");
    assert_eq!(second.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);

    let per_ip = RealDebridValidationControl::with_limits(10, 1, 2);
    let first = per_ip
        .validate(8, "192.0.2.30", "bad-token-c", || async {
            Err(ApiError::bad_request("invalid token"))
        })
        .await
        .expect_err("invalid token should fail validation");
    assert_eq!(first.status(), axum::http::StatusCode::BAD_REQUEST);
    let second = per_ip
        .validate(9, "192.0.2.30", "bad-token-d", || async {
            panic!("per-IP limiter should reject before validation")
        })
        .await
        .expect_err("second IP attempt should be throttled");
    assert_eq!(second.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn real_debrid_validation_shares_a_small_concurrency_budget() {
    let control = RealDebridValidationControl::with_limits(10, 10, 1);
    let first_started = Arc::new(Notify::new());
    let second_started = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());
    let first = tokio::spawn({
        let control = control.clone();
        let first_started = first_started.clone();
        let release_first = release_first.clone();
        async move {
            control
                .validate(10, "192.0.2.40", "token-one", move || async move {
                    first_started.notify_one();
                    release_first.notified().await;
                    Ok(())
                })
                .await
        }
    });
    first_started.notified().await;
    let second = tokio::spawn({
        let control = control.clone();
        let second_started = second_started.clone();
        async move {
            control
                .validate(11, "192.0.2.41", "token-two", move || async move {
                    second_started.notify_one();
                    Ok(())
                })
                .await
        }
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(25), second_started.notified())
            .await
            .is_err(),
        "second upstream validation should wait for the shared permit"
    );
    release_first.notify_one();
    first
        .await
        .expect("first validation task should finish")
        .expect("first validation should succeed");
    second
        .await
        .expect("second validation task should finish")
        .expect("second validation should succeed after the permit is released");
}

#[tokio::test(start_paused = true)]
async fn fastest_provider_hedge_keeps_a_fast_real_debrid_hit_exclusive() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let attempts: Vec<BoxResolverAttempt<'_>> = vec![
        Box::pin(resolver_provider_attempt(
            started.clone(),
            0,
            Duration::from_millis(400),
            true,
        )),
        Box::pin(resolver_provider_attempt(
            started.clone(),
            1,
            Duration::from_millis(50),
            true,
        )),
    ];
    let (winner, _) = race_staggered_resolver_attempts(attempts, FASTEST_PROVIDER_HEDGE_STAGGER)
        .await
        .expect("RD should win");
    assert_eq!(winner, 0);
    assert_eq!(*started.lock().unwrap(), vec![0]);
}

#[tokio::test(start_paused = true)]
async fn fastest_provider_hedge_launches_local_after_cached_hit_window() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let attempts: Vec<BoxResolverAttempt<'_>> = vec![
        Box::pin(resolver_provider_attempt(
            started.clone(),
            0,
            Duration::from_secs(30),
            true,
        )),
        Box::pin(resolver_provider_attempt(
            started.clone(),
            1,
            Duration::from_millis(100),
            true,
        )),
    ];
    let (winner, _) = race_staggered_resolver_attempts(attempts, FASTEST_PROVIDER_HEDGE_STAGGER)
        .await
        .expect("local should win");
    assert_eq!(winner, 1);
    assert_eq!(*started.lock().unwrap(), vec![0, 1]);
}

#[tokio::test(start_paused = true)]
async fn hedge_returns_first_success_without_starting_redundant_attempts() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let futures = vec![
        hedge_attempt(started.clone(), 0, Duration::from_millis(500), Some("a")),
        hedge_attempt(started.clone(), 1, Duration::from_millis(100), Some("b")),
    ];
    let winner = race_staggered_first_success(
        futures,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await;
    // Candidate 0 succeeds at 500ms — a healthy resolve, inside the production
    // stagger — so candidate 1 is never started.
    assert_eq!(winner, Some((0, "a")));
    assert_eq!(*started.lock().unwrap(), vec![0]);
}

#[tokio::test(start_paused = true)]
async fn hedge_launches_next_immediately_on_fast_failure() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let futures = vec![
        hedge_attempt(started.clone(), 0, Duration::from_millis(100), None),
        hedge_attempt(started.clone(), 1, Duration::from_millis(100), Some("b")),
    ];
    let winner = race_staggered_first_success(
        futures,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await;
    // Candidate 0 fails at 100ms; candidate 1 starts then, not after the
    // stagger, and wins.
    assert_eq!(winner, Some((1, "b")));
    assert_eq!(*started.lock().unwrap(), vec![0, 1]);
}

#[tokio::test(start_paused = true)]
async fn hedge_races_next_when_current_stalls_past_stagger() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let futures = vec![
        hedge_attempt(
            started.clone(),
            0,
            Duration::from_millis(10_000),
            Some("slow"),
        ),
        hedge_attempt(started.clone(), 1, Duration::from_millis(500), Some("fast")),
    ];
    let winner = race_staggered_first_success(
        futures,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await;
    // Candidate 0 stalls; candidate 1 is hedged in at the stagger and
    // resolves first.
    assert_eq!(winner, Some((1, "fast")));
    assert_eq!(*started.lock().unwrap(), vec![0, 1]);
}

#[tokio::test(start_paused = true)]
async fn hedge_returns_none_when_all_attempts_fail() {
    let started = Arc::new(StdMutex::new(Vec::new()));
    let futures = vec![
        hedge_attempt(started.clone(), 0, Duration::from_millis(100), None),
        hedge_attempt(started.clone(), 1, Duration::from_millis(100), None),
        hedge_attempt(started.clone(), 2, Duration::from_millis(100), None),
    ];
    let winner: Option<(usize, &'static str)> = race_staggered_first_success(
        futures,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await;
    assert_eq!(winner, None);
    assert_eq!(*started.lock().unwrap(), vec![0, 1, 2]);
}

#[tokio::test(start_paused = true)]
async fn hedge_handles_empty_candidate_set() {
    let futures: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = Option<&'static str>>>>> =
        Vec::new();
    let winner = race_staggered_first_success(
        futures,
        Duration::from_millis(EXTERNAL_EMBED_HEDGE_STAGGER_MS),
    )
    .await;
    assert_eq!(winner, None);
}

fn sample_resolve_metadata(
    media_type: &str,
    tmdb: &str,
    season: i64,
    episode: i64,
) -> ResolveMetadata {
    ResolveMetadata {
        tmdb_id: tmdb.to_owned(),
        imdb_id: String::new(),
        display_title: String::new(),
        display_year: String::new(),
        runtime_seconds: 0,
        season_number: season,
        episode_number: episode,
        episode_title: String::new(),
        media_type: media_type.to_owned(),
    }
}

#[test]
fn provider_rank_health_caps_spotty_but_sinks_dead_providers() {
    // Spotty catalog (the real LordFlix aggregate: many wins, some fails) must be
    // clamped within-tier so it can't bury a higher base tier — per-title health
    // handles the specific titles it fails.
    let spotty = SourceHealthStats {
        success_count: 46,
        failure_count: 17,
        decode_failure_count: 0,
        ended_early_count: 0,
        playback_error_count: 17,
    };
    let score = compute_external_embed_provider_rank_health_score(&spotty);
    assert!(
        score.abs() <= 75,
        "spotty provider should clamp within-tier: {score}"
    );

    // A strongly-reliable provider clamps to the +cap.
    let strong = SourceHealthStats {
        success_count: 275,
        failure_count: 4,
        decode_failure_count: 0,
        ended_early_count: 0,
        playback_error_count: 0,
    };
    assert_eq!(
        compute_external_embed_provider_rank_health_score(&strong),
        75
    );

    // A broadly DEAD provider (zero successes) keeps the uncapped avoid penalty.
    let dead = SourceHealthStats {
        success_count: 0,
        failure_count: 5,
        decode_failure_count: 0,
        ended_early_count: 0,
        playback_error_count: 5,
    };
    assert!(
        compute_external_embed_provider_rank_health_score(&dead) <= SOURCE_HEALTH_AVOID_SCORE,
        "dead provider must stay sunk across tiers"
    );
}

fn external_embed_provider(id: &str) -> ExternalEmbedSource {
    ExternalEmbedSource {
        provider: *EXTERNAL_EMBED_PROVIDERS
            .iter()
            .find(|provider| provider.id == id)
            .expect("known provider"),
        server: None,
    }
}

#[test]
fn meridian_ranks_first_and_gallic_stays_a_lower_fallback() {
    let movie = sample_resolve_metadata("movie", "872585", 0, 0);
    let meridian = external_embed_provider("meridian");
    let gallic = external_embed_provider("gallic");

    for source in [meridian, gallic] {
        assert!(is_external_embed_hls_capable_source(source));
        assert!(is_default_external_embed_hls_fallback_source(source));
    }

    let health = HashMap::new();
    let meridian_rank = external_embed_source_rank_score(meridian, &movie, &health);
    let lordflix_rank =
        external_embed_source_rank_score(external_embed_provider("lordflix"), &movie, &health);
    let icefy_rank =
        external_embed_source_rank_score(external_embed_provider("icefy"), &movie, &health);
    assert!(meridian_rank > lordflix_rank);
    assert!(external_embed_source_rank_score(gallic, &movie, &health) < icefy_rank);
}

#[test]
fn meridian_builds_movie_and_tv_urls_gallic_is_movie_only() {
    let movie = sample_resolve_metadata("movie", "872585", 0, 0);
    let tv = sample_resolve_metadata("tv", "1399", 1, 1);
    let meridian = external_embed_provider("meridian");
    let gallic = external_embed_provider("gallic");

    assert_eq!(
        external_embed_url(meridian, &movie).as_deref(),
        Some("https://meridian.aether.bar/movie/872585")
    );
    assert_eq!(
        external_embed_url(meridian, &tv).as_deref(),
        Some("https://meridian.aether.bar/show/1399/1/1")
    );
    assert_eq!(
        external_embed_url(gallic, &movie).as_deref(),
        Some("https://gallic.aether.bar/movie/872585")
    );
    // Gallic's upstream (senpai-stream.club) is movie-only, so no TV candidate.
    assert_eq!(external_embed_url(gallic, &tv), None);
}

#[test]
fn extracts_upstream_origin_and_referer_from_aether_wrapper() {
    // Meridian-shaped body (top-level `url`, Origin + Referer headers).
    let meridian_body = r#"{"title":"Oppenheimer","url":"https://yield.aether.bar/m3u8-proxy?url=https%3A%2F%2Fcdn.neuronix.sbs%2Fsegment%2Fabc%2F%3Ftoken1%3D11%26token3%3D22&headers=%7B%22Origin%22%3A%22https%3A%2F%2Fcdn.neuronix.sbs%22%2C%22Referer%22%3A%22https%3A%2F%2Fcdn.neuronix.sbs%2F%22%7D","subtitles":[]}"#;
    let (url, referer) =
        extract_aether_proxied_origin(meridian_body).expect("meridian wrapper unwraps");
    assert_eq!(
        url,
        "https://cdn.neuronix.sbs/segment/abc/?token1=11&token3=22"
    );
    assert_eq!(referer.as_deref(), Some("https://cdn.neuronix.sbs/"));

    // Gallic-shaped body (nested `source.stream_url`, Referer only).
    let gallic_body = r#"{"source":{"stream_url":"https://field.aether.bar/m3u8-proxy?url=https%3A%2F%2Fzebi.senpai-stream.club%2Fmovie%2F872585%2Fpremium-x%2Fmaster.m3u8&headers=%7B%22Referer%22%3A%22https%3A%2F%2Fzebi.senpai-stream.club%2F%22%7D","format":"m3u8"}}"#;
    let (g_url, g_ref) =
        extract_aether_proxied_origin(gallic_body).expect("gallic wrapper unwraps");
    assert_eq!(
        g_url,
        "https://zebi.senpai-stream.club/movie/872585/premium-x/master.m3u8"
    );
    assert_eq!(g_ref.as_deref(), Some("https://zebi.senpai-stream.club/"));

    // A non-wrapper body (Cloudflare challenge / missing title) yields nothing.
    assert!(extract_aether_proxied_origin("<!DOCTYPE html><html>denied</html>").is_none());
}

#[test]
fn resolve_cache_key_is_stable_per_title_identity() {
    // Movie: season/episode are 0, tmdb trimmed — matches the handler-side params.
    assert_eq!(
        external_embed_resolve_cache_key(&sample_resolve_metadata("movie", " 27205 ", 0, 0)),
        "movie|27205|0|0"
    );
    assert_eq!(
        external_embed_resolve_cache_key(&sample_resolve_metadata("tv", "1396", 1, 2)),
        "tv|1396|1|2"
    );
}

#[test]
fn resolved_embed_cache_store_get_and_evict() {
    let cache = ResolvedEmbedCache::new();
    let source = super::external_embed_sources()
        .into_iter()
        .next()
        .expect("at least one embed source");
    let key = "movie|27205|0|0".to_owned();
    cache.store(
        key.clone(),
        CachedResolvedEmbed {
            source,
            playback_url: "https://up.example/p.m3u8?auth=tok".to_owned(),
            referer: Some("https://vidlink.pro/".to_owned()),
            embed_url: "https://vidlink.pro/movie/27205".to_owned(),
            cached_at_ms: now_ms(),
        },
    );
    let hit = cache.get_fresh(&key).expect("fresh entry");
    assert_eq!(hit.playback_url, "https://up.example/p.m3u8?auth=tok");
    cache.evict(&key);
    assert!(
        cache.get_fresh(&key).is_none(),
        "evicted entry must be gone"
    );
}

#[test]
fn resolved_embed_cache_expires_entries_past_ttl() {
    let cache = ResolvedEmbedCache::new();
    let source = super::external_embed_sources().into_iter().next().unwrap();
    // Stamp the entry well past the default 25-min TTL.
    cache.store(
        "k".to_owned(),
        CachedResolvedEmbed {
            source,
            playback_url: "u".to_owned(),
            referer: None,
            embed_url: "e".to_owned(),
            cached_at_ms: now_ms() - (26 * 60 * 1000),
        },
    );
    assert!(
        cache.get_fresh("k").is_none(),
        "entry older than the TTL must read as stale"
    );
}

#[test]
fn normalizes_source_hashes() {
    assert_eq!(
        normalize_source_hash("0123456789abcdef0123456789abcdef01234567"),
        "0123456789abcdef0123456789abcdef01234567"
    );
    assert!(normalize_source_hash("bad-hash").is_empty());
}

#[test]
fn curl_fetch_external_embed_host_covers_vixsrc_only() {
    assert!(super::is_curl_fetch_external_embed_host("vixsrc.to"));
    assert!(super::is_curl_fetch_external_embed_host("VixSrc.TO"));
    assert!(super::is_curl_fetch_external_embed_host("cdn.vixsrc.to"));
    // Other external-embed providers keep using the rustls client.
    assert!(!super::is_curl_fetch_external_embed_host(
        "streams.icefy.top"
    ));
    assert!(!super::is_curl_fetch_external_embed_host("vidrock.net"));
    assert!(!super::is_curl_fetch_external_embed_host(
        "notvixsrc.to.evil.com"
    ));
    // Resolve-side host list must agree with the playback-side curl matcher
    // so a host that resolves over curl also has its proxied playback fetched
    // over curl (and is never routed to the Worker).
    let playlist: url::Url = "https://vixsrc.to/playlist/231752?token=x".parse().unwrap();
    assert!(crate::live::is_curl_fetch_live_hls_upstream(&playlist));
}

#[test]
fn external_embed_sources_use_stable_hashes_and_hls_urls() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::new();
    let sources = build_external_embed_source_summaries(&metadata, &health_scores);

    // Meridian leads, then LordFlix / VidRock, ahead of the flaky providers
    // (VidLink/VixSrc/Icefy), with Gallic and the VidEasy variants trailing.
    assert_eq!(sources.len(), 16);
    assert_eq!(sources[0].primary, "Meridian");
    assert_eq!(sources[0].provider, "LivNet");
    assert_eq!(sources[0].filename, "Meridian embed");
    assert_eq!(sources[0].qualityLabel, "1080p");
    assert_eq!(sources[0].container, "hls");
    assert!(!sources[0].isTorrent);
    assert_eq!(sources[0].releaseGroup, "Native HLS, TV + movies");
    assert_eq!(
        normalize_source_hash(&sources[0].sourceHash),
        sources[0].sourceHash
    );

    let meridian = external_embed_source_for_source_hash(&metadata, &sources[0].sourceHash)
        .expect("matching external provider");
    assert_eq!(meridian.provider.id, "meridian");
    assert_eq!(meridian.server.map(|server| server.id), None);
    assert!(external_embed_url(meridian, &metadata).is_some_and(|url| !url.is_empty()));
    assert_eq!(
        external_embed_source_hash(meridian, &metadata),
        sources[0].sourceHash
    );
    // sources[1] is LordFlix; sources[2] VidRock (stable embed URL template).
    let lordflix = external_embed_source_for_source_hash(&metadata, &sources[1].sourceHash)
        .expect("matching lordflix provider");
    assert_eq!(lordflix.provider.id, "lordflix");
    let vidrock = external_embed_source_for_source_hash(&metadata, &sources[2].sourceHash)
        .expect("matching vidrock provider");
    assert_eq!(vidrock.provider.id, "vidrock");
    assert_eq!(
        external_embed_url(vidrock, &metadata).unwrap(),
        "https://vidrock.net/movie/1368166"
    );
    assert_eq!(sources[1].primary, "LordFlix");
    assert_eq!(sources[2].primary, "VidRock");
    assert_eq!(sources[3].primary, "NoTorrent");
    assert_eq!(sources[4].primary, "VidLink");
    assert_eq!(sources[5].primary, "VixSrc");
    assert_eq!(sources[6].primary, "VidEasy");
    assert_eq!(sources[6].provider, "LivNet");
    assert_eq!(sources[6].filename, "VidEasy embed");
    assert_eq!(sources[7].primary, "Icefy");
    assert_eq!(sources[7].provider, "LivNet");
    assert_eq!(sources[7].filename, "Icefy embed");
    assert_eq!(sources[7].qualityLabel, "1080p");
    assert_eq!(sources[7].releaseGroup, "Fast native HLS");

    let yoru_summary = sources
        .iter()
        .find(|source| source.primary == "Yoru")
        .expect("yoru source");
    assert_eq!(yoru_summary.provider, "VidEasy");
    assert_eq!(yoru_summary.qualityLabel, "4K");

    let notorrent_summary = sources
        .iter()
        .find(|source| source.primary == "NoTorrent")
        .expect("notorrent source");
    assert_eq!(notorrent_summary.provider, "LivNet");
    assert_eq!(notorrent_summary.releaseGroup, "Stremio addon HLS");

    let lordflix_summary = sources
        .iter()
        .find(|source| source.primary == "LordFlix")
        .expect("lordflix source");
    assert_eq!(lordflix_summary.provider, "LivNet");
    assert_eq!(lordflix_summary.releaseGroup, "Multi-server native HLS");

    // The aether-backed fallbacks appear (movie): Gallic advertises 4K, Meridian 1080p.
    let gallic_summary = sources
        .iter()
        .find(|source| source.primary == "Gallic")
        .expect("gallic source summary");
    assert_eq!(gallic_summary.provider, "LivNet");
    assert_eq!(gallic_summary.qualityLabel, "4K");
    assert_eq!(gallic_summary.releaseGroup, "Native HLS, up to 4K");
    let meridian_summary = sources
        .iter()
        .find(|source| source.primary == "Meridian")
        .expect("meridian source summary");
    assert_eq!(meridian_summary.qualityLabel, "1080p");
    assert_eq!(meridian_summary.releaseGroup, "Native HLS, TV + movies");

    let neon_source = sources
        .iter()
        .find(|source| source.primary == "Neon")
        .expect("neon source summary");
    let neon_source = external_embed_source_for_source_hash(&metadata, &neon_source.sourceHash)
        .expect("matching neon external provider");
    assert_eq!(neon_source.provider.id, "videasy");
    assert_eq!(neon_source.server.map(|server| server.id), Some("NEON"));

    let vidlink_source = external_embed_sources()
        .into_iter()
        .find(|source| source.provider.id == "vidlink" && source.server.is_none())
        .expect("vidlink fallback source");
    assert_eq!(
        external_embed_url(vidlink_source, &metadata).unwrap(),
        "https://vidlink.pro/movie/1368166"
    );

    let tv_metadata = sample_tv_metadata();
    let videasy_source = external_embed_sources()
        .into_iter()
        .find(|source| source.provider.id == "videasy" && source.server.is_none())
        .expect("videasy fallback source");
    assert_eq!(
        external_embed_url(videasy_source, &tv_metadata).unwrap(),
        "https://player.videasy.to/tv/76331/1/1?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=false&overlay=true&color=ffd700"
    );
    assert_eq!(
        external_embed_url(vidlink_source, &tv_metadata).unwrap(),
        "https://vidlink.pro/tv/76331/1/1"
    );

    // TV gains only Meridian (Gallic's upstream is movie-only), so 15 not 16.
    let tv_sources = build_external_embed_source_summaries(&tv_metadata, &health_scores);
    assert_eq!(tv_sources.len(), 15);
    assert!(tv_sources.iter().any(|source| source.primary == "Meridian"));
    assert!(!tv_sources.iter().any(|source| source.primary == "Gallic"));
    assert_eq!(tv_sources[0].primary, "Meridian");
    assert_eq!(tv_sources[0].provider, "LivNet");
    assert_eq!(tv_sources[1].primary, "LordFlix");
    assert_eq!(tv_sources[2].primary, "VidRock");
}

#[test]
fn default_external_embed_prefers_hls_sources() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::new();
    let source =
        default_external_embed_source(&metadata, &health_scores).expect("default embed source");
    assert_eq!(source.provider.id, "meridian");
    assert_eq!(source.server.map(|server| server.id), None);

    let tv_metadata = sample_tv_metadata();
    let tv_source = default_external_embed_source(&tv_metadata, &health_scores)
        .expect("default tv embed source");
    assert_eq!(tv_source.provider.id, "meridian");
    assert_eq!(tv_source.server.map(|server| server.id), None);

    let filters = ResolveFilters {
        source_hash: String::new(),
        preferred_container: String::new(),
        source_filters: sample_source_filters(),
    };
    assert!(should_prefer_default_external_embed(
        &filters,
        ResolverProvider::Fastest
    ));
    assert!(!should_prefer_default_external_embed(
        &filters,
        ResolverProvider::LocalTorrent
    ));
    assert!(!should_resolve_torrent_candidates(
        &filters,
        ResolverProvider::Fastest,
        false,
    ));
    assert!(should_resolve_torrent_candidates(
        &filters,
        ResolverProvider::Fastest,
        true,
    ));
}

#[test]
fn external_embed_payload_routes_playlists_via_worker_when_configured() {
    let metadata = sample_movie_metadata();
    let preferences = ResolvePreferences {
        audio_lang: "en".to_owned(),
        subtitle_lang: String::new(),
        quality: "auto".to_owned(),
    };
    // LordFlix is used here as a direct-segment HLS fixture; Meridian is the
    // current default embed, so construct the source explicitly.
    let lordflix = external_embed_provider("lordflix");
    assert_eq!(lordflix.provider.id, "lordflix");

    // Worker configured + direct-segment provider: worker URLs lead, the
    // zone-routed URLs stay as worker-outage fallbacks.
    let payload = finalize_external_embed_payload(
        &metadata,
        lordflix,
        &preferences,
        "https://tcloud.lordflix.club/tcloud?u=abc",
        Some("https://lordflix.org/"),
        "https://lordflix.org/embed".to_owned(),
        "test-secret",
        "https://live-proxy.example.workers.dev",
    );
    let playable = payload["playableUrl"].as_str().expect("playable url");
    let fallbacks: Vec<&str> = payload["fallbackUrls"]
        .as_array()
        .expect("fallback urls")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert!(playable.starts_with("https://live-proxy.example.workers.dev/api/live/hls.m3u8?"));
    assert!(playable.ends_with("&directSeg=1"));
    assert_eq!(fallbacks.len(), 3);
    assert!(fallbacks[0].starts_with("https://live-proxy.example.workers.dev/api/live/hls.m3u8?"));
    assert!(!fallbacks[0].contains("directSeg"));
    assert!(fallbacks[1].starts_with("/api/live/hls.m3u8?"));
    assert!(fallbacks[1].ends_with("&directSeg=1"));
    assert!(fallbacks[2].starts_with("/api/live/hls.m3u8?"));
    assert!(!fallbacks[2].contains("directSeg"));

    // No worker configured: the legacy zone-only queue shape is preserved.
    let zone_payload = finalize_external_embed_payload(
        &metadata,
        lordflix,
        &preferences,
        "https://tcloud.lordflix.club/tcloud?u=abc",
        Some("https://lordflix.org/"),
        "https://lordflix.org/embed".to_owned(),
        "test-secret",
        "",
    );
    let zone_playable = zone_payload["playableUrl"].as_str().expect("playable url");
    let zone_fallbacks = zone_payload["fallbackUrls"].as_array().expect("fallbacks");
    assert!(zone_playable.starts_with("/api/live/hls.m3u8?"));
    assert!(zone_playable.ends_with("&directSeg=1"));
    assert_eq!(zone_fallbacks.len(), 1);

    // Worker configured + relay-only provider: worker playlist first, zone second.
    let vidrock = external_embed_sources()
        .into_iter()
        .find(|source| source.provider.id == "vidrock" && source.server.is_none())
        .expect("vidrock source");
    let relay_payload = finalize_external_embed_payload(
        &metadata,
        vidrock,
        &preferences,
        "https://cdn.vidrock.example/stream.m3u8",
        None,
        "https://vidrock.example/embed".to_owned(),
        "test-secret",
        "https://live-proxy.example.workers.dev",
    );
    let relay_playable = relay_payload["playableUrl"].as_str().expect("playable url");
    let relay_fallbacks: Vec<&str> = relay_payload["fallbackUrls"]
        .as_array()
        .expect("fallback urls")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert!(
        relay_playable.starts_with("https://live-proxy.example.workers.dev/api/live/hls.m3u8?")
    );
    assert_eq!(relay_fallbacks.len(), 1);
    assert!(relay_fallbacks[0].starts_with("/api/live/hls.m3u8?"));
}

#[test]
fn default_external_embed_native_fallback_can_try_hls_sources() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::new();
    let source =
        default_external_embed_source(&metadata, &health_scores).expect("default embed source");
    assert_eq!(source.provider.id, "meridian");
    assert_eq!(source.server.map(|server| server.id), None);

    let candidates = external_embed_hls_candidate_sources(source, &metadata, true, &health_scores);
    let source_ids = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.provider.id,
                candidate
                    .server
                    .map(|server| server.id)
                    .unwrap_or("default"),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(source_ids.first(), Some(&("meridian", "default")));
    assert_eq!(source_ids.get(1), Some(&("lordflix", "default")));
    assert_eq!(source_ids.get(2), Some(&("vidrock", "default")));
    assert_eq!(source_ids.get(3), Some(&("notorrent", "default")));
    assert_eq!(source_ids.get(4), Some(&("vidlink", "default")));
    assert_eq!(source_ids.get(5), Some(&("vixsrc", "default")));
    assert_eq!(source_ids.get(6), Some(&("videasy", "default")));
    // Gallic (movie-only aether sibling) sits above the flaky VidEasy variants.
    assert_eq!(source_ids.get(7), Some(&("gallic", "default")));
    assert_eq!(source_ids.get(8), Some(&("videasy", "YORU")));
    assert_eq!(source_ids.len(), 9);

    let tv_metadata = sample_tv_metadata();
    let tv_source = default_external_embed_source(&tv_metadata, &health_scores)
        .expect("default tv embed source");
    let tv_candidates =
        external_embed_hls_candidate_sources(tv_source, &tv_metadata, true, &health_scores);
    let tv_source_ids = tv_candidates
        .iter()
        .map(|candidate| {
            (
                candidate.provider.id,
                candidate
                    .server
                    .map(|server| server.id)
                    .unwrap_or("default"),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(tv_source_ids.first(), Some(&("meridian", "default")));
    assert_eq!(tv_source_ids.get(1), Some(&("lordflix", "default")));
    assert_eq!(tv_source_ids.get(2), Some(&("vidrock", "default")));
    assert_eq!(tv_source_ids.get(3), Some(&("notorrent", "default")));
    assert_eq!(tv_source_ids.get(4), Some(&("vidlink", "default")));
    assert_eq!(tv_source_ids.get(5), Some(&("vixsrc", "default")));
    assert_eq!(tv_source_ids.get(6), Some(&("videasy", "default")));
    assert_eq!(tv_source_ids.get(7), Some(&("videasy", "YORU")));
    assert_eq!(tv_source_ids.len(), 8);

    let neon_source = external_embed_sources()
        .into_iter()
        .find(|source| {
            source.provider.id == "videasy"
                && source
                    .server
                    .map(|server| server.id == "NEON")
                    .unwrap_or(false)
        })
        .expect("neon source");
    let pinned_candidates =
        external_embed_hls_candidate_sources(neon_source, &metadata, false, &health_scores);
    assert_eq!(pinned_candidates, vec![neon_source]);
}

#[test]
fn external_embed_unhealthy_sources_skip_auto_fallback() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::from([(
        external_embed_source_hash(
            external_embed_sources()
                .into_iter()
                .find(|source| source.provider.id == "vidrock")
                .expect("vidrock source"),
            &metadata,
        ),
        SOURCE_HEALTH_AVOID_SCORE - 500,
    )]);
    let source =
        default_external_embed_source(&metadata, &health_scores).expect("default embed source");
    let candidates = external_embed_hls_candidate_sources(source, &metadata, true, &health_scores);
    let provider_ids = candidates
        .iter()
        .map(|candidate| candidate.provider.id)
        .collect::<Vec<_>>();
    assert!(!provider_ids.contains(&"vidrock"));

    let icefy_source = external_embed_sources()
        .into_iter()
        .find(|source| source.provider.id == "icefy")
        .expect("icefy source");
    let pinned_candidates =
        external_embed_hls_candidate_sources(icefy_source, &metadata, false, &health_scores);
    assert_eq!(pinned_candidates, vec![icefy_source]);
}

#[test]
fn external_embed_positive_health_does_not_override_reliable_baseline() {
    let metadata = sample_movie_metadata();
    let mut health_scores = HashMap::new();
    for source in external_embed_sources() {
        if source.provider.id == "meridian" {
            continue;
        }
        health_scores.insert(external_embed_source_hash(source, &metadata), 150);
    }

    // A max positive-health streak on every other provider still can't lift
    // one above the un-boosted top Meridian tier (gap 200 > +150).
    let source =
        default_external_embed_source(&metadata, &health_scores).expect("default embed source");
    assert_eq!(source.provider.id, "meridian");
    assert_eq!(source.server.map(|server| server.id), None);

    let capped = compute_external_embed_rank_health_score(&SourceHealthStats {
        success_count: 12,
        ..SourceHealthStats::default()
    });
    assert_eq!(capped, 75);

    let failed = compute_external_embed_rank_health_score(&SourceHealthStats {
        failure_count: 1,
        ..SourceHealthStats::default()
    });
    assert!(failed < SOURCE_HEALTH_AVOID_SCORE);
}

#[test]
fn selected_external_embed_sources_are_native_hls_only() {
    let metadata = sample_movie_metadata();
    let neon_source = external_embed_sources()
        .into_iter()
        .find(|source| {
            source.provider.id == "videasy"
                && source
                    .server
                    .map(|server| server.id == "NEON")
                    .unwrap_or(false)
        })
        .expect("neon source");

    let health_scores = HashMap::new();
    let pinned_candidates =
        external_embed_hls_candidate_sources(neon_source, &metadata, false, &health_scores);
    assert_eq!(pinned_candidates, vec![neon_source]);
    assert!(
        pinned_candidates
            .iter()
            .all(|source| is_external_embed_hls_capable_source(*source))
    );
}

#[test]
fn external_embed_hls_resolver_accepts_public_playlist_hosts() {
    let videasy_embed: url::Url = "https://player.videasy.to/movie/1368166?color=ffd700"
        .parse()
        .expect("videasy embed");
    let legacy_videasy_embed: url::Url = "https://player.videasy.net/movie/1368166?color=ffd700"
        .parse()
        .expect("legacy videasy embed");
    let vidlink_embed: url::Url = "https://vidlink.pro/movie/1368166"
        .parse()
        .expect("vidlink embed");
    let unsupported_embed: url::Url = "https://example.com/embed/movie/1368166"
        .parse()
        .expect("unsupported embed");
    let hls: url::Url = "https://easy.speedsterwave.app/example/index.m3u8"
        .parse()
        .expect("hls url");
    let yoru_hls: url::Url = "https://yoru.midwesteagle.com/video.m3u8"
        .parse()
        .expect("yoru hls url");
    let mousedoor_hls: url::Url = "https://hello.mousedoor.com/example/index.m3u8"
        .parse()
        .expect("mousedoor hls url");
    let vidlink_hls: url::Url = "https://storm.vodvidl.site/example/index.m3u8"
        .parse()
        .expect("vidlink hls url");
    let rotated_hls: url::Url = "https://new-videasy-cdn.example.com/example/index.m3u8"
        .parse()
        .expect("rotated hls url");
    let unsupported_local_hls: url::Url = "https://localhost/example/index.m3u8"
        .parse()
        .expect("unsupported local hls url");
    let unsupported_ip_hls: url::Url = "https://127.0.0.1/example/index.m3u8"
        .parse()
        .expect("unsupported ip hls url");
    let unsupported_non_hls: url::Url = "https://cdn.example.com/example/video.mp4"
        .parse()
        .expect("unsupported non-hls url");

    assert!(is_supported_external_embed_hls_embed_url(&videasy_embed));
    assert!(is_supported_external_embed_hls_embed_url(
        &legacy_videasy_embed
    ));
    assert!(is_supported_external_embed_hls_embed_url(&vidlink_embed));
    assert!(!is_supported_external_embed_hls_embed_url(
        &unsupported_embed
    ));
    assert!(is_supported_external_embed_hls_url(&hls));
    assert!(is_supported_external_embed_hls_url(&yoru_hls));
    assert!(is_supported_external_embed_hls_url(&mousedoor_hls));
    assert!(is_supported_external_embed_hls_url(&vidlink_hls));
    assert!(is_supported_external_embed_hls_url(&rotated_hls));
    assert!(!is_supported_external_embed_hls_url(&unsupported_local_hls));
    assert!(!is_supported_external_embed_hls_url(&unsupported_ip_hls));
    assert!(!is_supported_external_embed_hls_url(&unsupported_non_hls));
}

#[test]
fn external_embed_public_hls_hostname_rejects_local_or_malformed_hosts() {
    assert!(is_public_external_embed_hls_hostname("media.example.com"));
    assert!(is_public_external_embed_hls_hostname("cdn-1.example.net"));
    assert!(!is_public_external_embed_hls_hostname("localhost"));
    assert!(!is_public_external_embed_hls_hostname("media.local"));
    assert!(!is_public_external_embed_hls_hostname(
        "internal.service.internal"
    ));
    assert!(!is_public_external_embed_hls_hostname("127.0.0.1"));
    assert!(!is_public_external_embed_hls_hostname("example..com"));
    assert!(!is_public_external_embed_hls_hostname(
        "bad_host.example.com"
    ));
}

#[test]
fn parses_seed_counts() {
    assert_eq!(parse_seed_count("Torrent 👤 1,234"), 1234);
}

#[test]
fn parses_stream_size_labels() {
    assert_eq!(parse_size_label_bytes("2.5 GB"), 2_684_354_560);
    assert_eq!(parse_size_label_bytes("900 MB"), 943_718_400);
    assert_eq!(parse_size_label_bytes(""), 0);
}

#[test]
fn normalizes_allowed_formats_to_supported_video_containers() {
    assert_eq!(
        normalize_allowed_formats("mkv, mp4 avi"),
        vec!["mkv", "mp4"]
    );
}

#[test]
fn maps_real_debrid_provider_codes_to_readable_errors() {
    assert_eq!(
        user_facing_real_debrid_error("infringing_file"),
        "Real-Debrid blocked this source."
    );
    assert_eq!(
        user_facing_real_debrid_error("too_many_requests"),
        "Real-Debrid is rate limiting requests. Try again shortly."
    );
    assert_eq!(
        user_facing_real_debrid_error("an upstream message that must not be echoed"),
        "Real-Debrid request failed."
    );
}

#[test]
fn validates_real_debrid_account_without_exposing_identity() {
    assert!(
        validate_real_debrid_user_payload(&json!({
            "id": 42,
            "username": "private-user",
            "email": "private@example.com",
            "type": "premium"
        }))
        .is_ok()
    );
    let free = validate_real_debrid_user_payload(&json!({ "id": 42, "type": "free" }))
        .expect_err("free accounts cannot stream cached torrents");
    assert_eq!(free.status(), axum::http::StatusCode::FAILED_DEPENDENCY);
    assert!(!free.message().unwrap_or_default().contains("42"));
    let malformed = validate_real_debrid_user_payload(&json!({ "type": "premium" }))
        .expect_err("missing account id must fail closed");
    assert_eq!(malformed.status(), axum::http::StatusCode::BAD_GATEWAY);
}

#[test]
fn extracts_only_downloaded_real_debrid_hashes() {
    let downloaded = "abcdef0123456789abcdef0123456789abcdef01";
    let waiting = "1111111111111111111111111111111111111111";
    let hashes = parse_ready_real_debrid_hashes(&json!([
        { "id": "rd-ready", "hash": downloaded.to_uppercase(), "status": "downloaded" },
        { "id": "rd-waiting", "hash": waiting, "status": "downloading" },
        { "id": "rd-invalid", "hash": "not-a-hash", "status": "downloaded" }
    ]));
    assert_eq!(hashes.len(), 1);
    assert!(hashes.contains(downloaded));
    assert_eq!(
        parse_ready_real_debrid_torrents(&json!([
            { "id": "rd-ready", "hash": downloaded, "status": "downloaded" }
        ]))
        .get(downloaded)
        .map(String::as_str),
        Some("rd-ready")
    );

    let cached = parse_ready_real_debrid_hashes(&json!({
        "hashes": [downloaded],
        "torrents": { (downloaded): "rd-ready" }
    }));
    assert_eq!(cached, hashes);
}

#[test]
fn real_debrid_ready_sources_rank_ahead_of_uncached_torrents() {
    let mut cached = sample_stream(
        "Example.Movie.2024.1080p.WEB-DL.x264.mkv\n👤 1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    cached.real_debrid_cached = true;
    let uncached = sample_stream(
        "Example.Movie.2024.1080p.WEB-DL.x264.mkv\n👤 9999",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let mut metadata = sample_movie_metadata();
    metadata.display_title = "Example Movie".to_owned();
    metadata.display_year = "2024".to_owned();
    let streams = vec![uncached, cached];
    let selected = select_top_movie_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "",
        2,
        &sample_source_filters(),
        &HashMap::new(),
        false,
    );
    assert_eq!(
        selected.first().map(|stream| stream.infoHash.as_str()),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
}

#[test]
fn cached_real_debrid_movie_mkv_outranks_uncached_mp4_default() {
    let mut cached_mkv = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mkv\n👤 1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    cached_mkv.real_debrid_cached = true;
    let uncached_mp4 = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mp4\n👤 9999",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let streams = vec![uncached_mp4, cached_mkv];

    let selected = select_top_movie_candidates(
        &streams,
        &sample_movie_metadata(),
        "en",
        "1080p",
        "",
        1,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 1);
    assert!(selected[0].real_debrid_cached);
    assert!(selected[0].title.contains(".mkv"));
}

#[test]
fn cached_real_debrid_episode_mkv_outranks_uncached_mp4_default() {
    let mut cached_mkv = sample_stream(
        "Succession.S01E01.1080p.WEB-DL.mkv\n👤 1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    cached_mkv.real_debrid_cached = true;
    let uncached_mp4 = sample_stream(
        "Succession.S01E01.1080p.WEB-DL.mp4\n👤 9999",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let streams = vec![uncached_mp4, cached_mkv];

    let selected = select_top_episode_candidates(
        &streams,
        &sample_tv_metadata(),
        "en",
        "1080p",
        "auto",
        "",
        1,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 1);
    assert!(selected[0].real_debrid_cached);
    assert!(selected[0].title.contains(".mkv"));
}

#[test]
fn normalizes_resolver_provider_preference() {
    assert_eq!(normalize_resolver_provider(""), ResolverProvider::Fastest);
    assert_eq!(
        normalize_resolver_provider("fastest"),
        ResolverProvider::Fastest
    );
    assert_eq!(
        normalize_resolver_provider("local-torrent"),
        ResolverProvider::LocalTorrent
    );
    assert_eq!(
        normalize_resolver_provider("real-debrid"),
        ResolverProvider::RealDebrid
    );
    assert_eq!(
        normalize_resolver_provider("unexpected"),
        ResolverProvider::Fastest
    );
    assert!(ResolverProvider::RealDebrid.is_real_debrid());
    assert!(!ResolverProvider::LocalTorrent.is_real_debrid());
    assert!(ResolverProvider::Fastest.is_fastest());
}

#[test]
fn local_torrent_is_available_without_becoming_the_automatic_default() {
    assert!(!torrent_playback_enabled(None, false));
    assert!(torrent_playback_enabled(None, true));
    assert!(!prefer_mp4_default_candidates(
        ResolverProvider::Fastest,
        true,
        None
    ));
    assert!(!prefer_mp4_default_candidates(
        ResolverProvider::LocalTorrent,
        false,
        None
    ));
    let real_debrid =
        super::RealDebridRequestContext::for_user(7, "token").expect("real-debrid context");
    assert!(prefer_mp4_default_candidates(
        ResolverProvider::Fastest,
        true,
        Some(&real_debrid),
    ));
    assert_eq!(
        cache_reuse_provider_for_context(ResolverProvider::Fastest, false, true),
        ResolverProvider::LocalTorrent
    );
    assert_eq!(
        cache_reuse_provider_for_context(ResolverProvider::Fastest, true, true),
        ResolverProvider::RealDebrid
    );

    let unpinned = ResolveFilters {
        source_hash: String::new(),
        preferred_container: String::new(),
        source_filters: sample_source_filters(),
    };
    assert!(!should_resolve_torrent_candidates(
        &unpinned,
        ResolverProvider::Fastest,
        false,
    ));

    let pinned = ResolveFilters {
        source_hash: "a".repeat(40),
        ..unpinned.clone()
    };
    assert!(should_resolve_torrent_candidates(
        &pinned,
        ResolverProvider::Fastest,
        false,
    ));
    assert!(should_resolve_torrent_candidates(
        &unpinned,
        ResolverProvider::LocalTorrent,
        false,
    ));

    let real_debrid =
        super::RealDebridRequestContext::for_user(7, "token").expect("real-debrid context");
    assert!(torrent_playback_enabled(Some(&real_debrid), false));
}

#[test]
fn real_debrid_and_fastest_reuse_real_debrid_sessions() {
    assert_eq!(
        ResolverProvider::Fastest.cache_reuse_provider(),
        ResolverProvider::RealDebrid
    );
    assert_eq!(
        ResolverProvider::RealDebrid.cache_reuse_provider(),
        ResolverProvider::RealDebrid
    );
    assert_eq!(
        ResolverProvider::LocalTorrent.cache_reuse_provider(),
        ResolverProvider::LocalTorrent
    );
}

#[test]
fn real_debrid_cache_scope_changes_when_credentials_are_replaced() {
    let first = super::RealDebridRequestContext::for_user(42, "first-private-token")
        .expect("first context");
    let second = super::RealDebridRequestContext::for_user(42, "second-private-token")
        .expect("second context");
    let other_user = super::RealDebridRequestContext::for_user(7, "first-private-token")
        .expect("other user context");
    assert_ne!(first.cache_scope, second.cache_scope);
    assert_ne!(first.cache_scope, other_user.cache_scope);
    assert!(!first.cache_scope.contains("first-private-token"));
    assert!(!second.cache_scope.contains("second-private-token"));

    let direct = build_real_debrid_cache_scope(42, "first-private-token", false);
    let remote = build_real_debrid_cache_scope(42, "first-private-token", true);
    assert_ne!(direct, remote);
    assert!(direct.ends_with(":delivery:direct-v1"));
    assert!(remote.ends_with(":delivery:remote-hls-v1"));
    assert!(!remote.contains("first-private-token"));
}

#[test]
fn real_debrid_playback_sessions_are_private_to_the_credential_scope() {
    let first = super::RealDebridRequestContext::for_user(42, "first-private-token")
        .expect("first context");
    let second = super::RealDebridRequestContext::for_user(42, "second-private-token")
        .expect("second context");
    let session = PlaybackSession {
        metadata: json!({
            "resolverProvider": "real-debrid",
            (super::RD_CREDENTIAL_SCOPE_METADATA_KEY): first.cache_scope.clone()
        }),
        ..PlaybackSession::default()
    };

    assert!(super::playback_session_matches_real_debrid_scope(
        &session,
        ResolverProvider::RealDebrid,
        Some(&first)
    ));
    assert!(!super::playback_session_matches_real_debrid_scope(
        &session,
        ResolverProvider::RealDebrid,
        Some(&second)
    ));
    assert!(!super::playback_session_matches_real_debrid_scope(
        &session,
        ResolverProvider::RealDebrid,
        None
    ));
    assert!(super::playback_session_matches_real_debrid_scope(
        &session,
        ResolverProvider::LocalTorrent,
        None
    ));
    assert!(
        !super::build_playback_session_payload(&session)
            .to_string()
            .contains(&first.cache_scope),
        "private credential scope must never enter serialized session payloads"
    );
}

#[test]
fn reused_real_debrid_torrents_are_read_only_and_require_an_exact_ready_selection() {
    use super::RealDebridTorrentOwnership::{CreatedByRequest, ReusedFromAccount};

    assert!(!ReusedFromAccount.may_change_file_selection());
    assert!(CreatedByRequest.may_change_file_selection());

    let ready = json!({
        "status": "downloaded",
        "files": [
            {"id": 2, "path": "/Show.S01E01.mkv", "selected": 1},
            {"id": 3, "path": "/Show.S01E02.mkv", "selected": 0}
        ],
        "links": ["https://real-debrid.example/link"]
    });
    assert!(super::reusable_rd_torrent_ready_for_selected_file(
        &ready, 2
    ));
    assert!(!super::reusable_rd_torrent_ready_for_selected_file(
        &ready, 3
    ));

    let mut multiple_selected = ready.clone();
    multiple_selected["files"][1]["selected"] = json!(1);
    multiple_selected["links"] = json!(["first", "second"]);
    assert!(!super::reusable_rd_torrent_ready_for_selected_file(
        &multiple_selected,
        2
    ));

    let mut downloading = ready;
    downloading["status"] = json!("downloading");
    assert!(!super::reusable_rd_torrent_ready_for_selected_file(
        &downloading,
        2
    ));
}

#[test]
fn real_debrid_defers_track_enrichment_until_after_playable_url_delivery() {
    assert!(super::should_defer_resolved_track_enrichment(
        ResolverProvider::RealDebrid,
        "https://example.download.real-debrid.com/movie.mp4"
    ));
    assert!(super::should_defer_resolved_track_enrichment(
        ResolverProvider::LocalTorrent,
        "/api/local-torrent/stream?sourceHash=abc"
    ));
    assert!(!super::should_defer_resolved_track_enrichment(
        ResolverProvider::Fastest,
        "https://cdn.example/movie.mp4"
    ));
}

#[test]
fn real_debrid_resolve_does_not_head_verify_before_returning_unrestricted_url() {
    let source = include_str!("real_debrid.rs");
    let resolve_body = source
        .split("async fn resolve_from_torrent_id")
        .nth(1)
        .expect("resolve_from_torrent_id source")
        .split("async fn resolve_playable_url_from_rd_link")
        .next()
        .expect("resolve body boundary");
    assert!(
        !resolve_body.contains(".verify_playable_url("),
        "authoritative unrestrict URLs must be returned before CDN validation"
    );
}

#[test]
fn real_debrid_remote_traffic_is_explicit_on_unrestrict_requests() {
    assert_eq!(
        build_real_debrid_unrestrict_form("https://example.test/file", false),
        vec![("link", "https://example.test/file")]
    );
    assert_eq!(
        build_real_debrid_unrestrict_form("https://example.test/file", true),
        vec![("link", "https://example.test/file"), ("remote", "1")]
    );

    let valid = json!({
        "apple": {
            "full": "https://3.stream.real-debrid.com/t/download/audio/none/aac/full.m3u8"
        }
    });
    assert_eq!(
        real_debrid_apple_transcode_url(&valid).as_deref(),
        Some("https://3.stream.real-debrid.com/t/download/audio/none/aac/full.m3u8")
    );
    assert!(
        real_debrid_apple_transcode_url(&json!({
            "apple": { "full": "https://stream.real-debrid.com.evil.test/full.m3u8" }
        }))
        .is_none()
    );
}

#[test]
fn real_debrid_playback_does_not_repeat_the_background_account_list_request() {
    let source = include_str!("real_debrid.rs");
    let reusable_lookup = source
        .split("async fn find_reusable_rd_torrent_by_hash")
        .nth(1)
        .expect("reusable lookup source")
        .split("async fn mark_ready_real_debrid_sources")
        .next()
        .expect("lookup body boundary");
    assert!(
        !reusable_lookup.contains("/torrents?limit="),
        "cold and cached misses must go directly to addMagnet"
    );
}

#[test]
fn classifies_persistent_source_resolve_failures() {
    assert!(is_persistent_source_resolve_error(
        &ApiError::failed_dependency("Real-Debrid blocked this source.")
    ));
    assert!(is_persistent_source_resolve_error(&ApiError::bad_gateway(
        "Real-Debrid blocked this source."
    )));
    assert!(is_persistent_source_resolve_error(&ApiError::internal(
        RD_SELECTED_FILE_MISMATCH_ERROR
    )));
    assert!(!is_persistent_source_resolve_error(&ApiError::bad_gateway(
        "Real-Debrid is rate limiting requests. Try again shortly."
    )));
}

#[test]
fn normalizes_resolve_lock_keys() {
    assert_eq!(
        build_movie_resolve_lock_key(
            " 123 ",
            "EN",
            "1080",
            "Off",
            "bad",
            " local-torrent:123:en:1080p ",
            "5",
            "mkv mp4",
            "EN",
            "single",
            ResolverProvider::RealDebrid,
            false,
        ),
        "movie|provider:real-debrid|skipEmbed:0|tmdb:123|audio:en|sub:off|quality:1080p|session:local-torrent:123:en:1080p|hash:|min:5|formats:mkv,mp4|lang:en|profile:single"
    );
    assert_eq!(
        build_tv_resolve_lock_key(
            "123",
            "",
            "2",
            "",
            "7",
            "auto",
            "4k",
            "en",
            "mp4",
            "",
            "",
            "",
            "mp4",
            "auto",
            "multi",
            ResolverProvider::LocalTorrent,
            false,
        ),
        "tv|provider:local-torrent|skipEmbed:0|tmdb:123|s:2|e:7|audio:auto|sub:en|quality:2160p|container:mp4|session:|hash:|min:0|formats:mp4|lang:any|profile:any"
    );
}

#[test]
fn builds_episode_scoped_tv_playback_session_keys() {
    assert_eq!(
        build_playback_session_key_for_metadata(
            &sample_tv_metadata(),
            "EN",
            "1080",
            ResolverProvider::RealDebrid
        ),
        "tv:76331:s1:e1:en:1080p"
    );
    assert_eq!(
        build_playback_session_key_for_metadata(
            &sample_movie_metadata(),
            "EN",
            "1080",
            ResolverProvider::LocalTorrent
        ),
        "local-torrent:1368166:en:1080p"
    );
    assert_eq!(
        build_playback_session_key_for_metadata(
            &sample_movie_metadata(),
            "EN",
            "1080",
            ResolverProvider::RealDebrid
        ),
        "1368166:en:1080p"
    );
    assert_eq!(
        build_user_scoped_playback_session_key_for_metadata(
            &sample_movie_metadata(),
            "EN",
            "1080",
            ResolverProvider::RealDebrid,
            42
        ),
        "real-debrid:user:42:1368166:en:1080p"
    );
    assert!(playback_session_key_allowed_for_user(
        "real-debrid:user:42:1368166:en:1080p",
        ResolverProvider::RealDebrid,
        42
    ));
    assert!(!playback_session_key_allowed_for_user(
        "1368166:en:1080p",
        ResolverProvider::RealDebrid,
        42
    ));
}

#[test]
fn latest_playback_session_fallback_allows_unpinned_requests() {
    let mut filters = ResolveFilters {
        source_hash: String::new(),
        preferred_container: String::new(),
        source_filters: sample_source_filters(),
    };
    assert!(should_allow_latest_playback_session_fallback(&filters));

    filters.source_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert!(!should_allow_latest_playback_session_fallback(&filters));
}

#[test]
fn pinned_source_hash_can_reuse_matching_playback_session() {
    let filters = ResolveFilters {
        source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        preferred_container: String::new(),
        source_filters: sample_source_filters(),
    };
    let matching_session = PlaybackSession {
        source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        ..PlaybackSession::default()
    };
    let different_session = PlaybackSession {
        source_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        ..PlaybackSession::default()
    };

    assert!(!should_skip_playback_session_reuse(&filters));
    assert!(playback_session_matches_source_hash(
        &matching_session,
        &filters
    ));
    assert!(!playback_session_matches_source_hash(
        &different_session,
        &filters
    ));
}

#[test]
fn tracks_external_resolver_guard_lifecycle() {
    let metrics = Arc::new(ResolverMetrics::default());
    let semaphore = Arc::new(Semaphore::new(1));
    {
        let permit = semaphore
            .clone()
            .try_acquire_owned()
            .expect("acquire first resolver permit");
        let mut guard = ResolverExternalGuard::new(metrics.clone(), permit);
        assert_eq!(metrics.external_active.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.external_started.load(Ordering::Relaxed), 1);
        guard.mark_completed();
    }

    assert_eq!(metrics.external_active.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.external_completed.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.external_failed.load(Ordering::Relaxed), 0);

    {
        let permit = semaphore
            .try_acquire_owned()
            .expect("acquire second resolver permit");
        let _guard = ResolverExternalGuard::new(metrics.clone(), permit);
    }

    assert_eq!(metrics.external_active.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.external_started.load(Ordering::Relaxed), 2);
    assert_eq!(metrics.external_completed.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.external_failed.load(Ordering::Relaxed), 1);
}

#[test]
fn parses_runtime_labels() {
    assert_eq!(parse_runtime_from_label_seconds("2h 10m"), 7800);
    assert_eq!(parse_runtime_from_label_seconds("01:45:00"), 6300);
}

#[test]
fn collects_episode_signatures_from_common_labels() {
    assert_eq!(
        collect_episode_signatures("Show.S02E07.1080p", Some(2)),
        vec!["2x7"]
    );
}

#[test]
fn season_packs_score_below_generic_and_episode_matched_releases() {
    let make_stream = |title: &str, filename: &str| DiscoveryStream {
        infoHash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
        name: "Torrentio".to_owned(),
        title: title.to_owned(),
        description: String::new(),
        behaviorHints: DiscoveryBehaviorHints {
            filename: filename.to_owned(),
        },
        sources: Vec::new(),
        ..DiscoveryStream::default()
    };

    let episode = make_stream(
        "Game Of Thrones S02E03 What Is Dead May Never Die",
        "Game Of Thrones S02E03 What Is Dead May Never Die.mp4",
    );
    let pack = make_stream(
        "Game of Thrones Season 2 Complete 1080p",
        "Game.of.Thrones.S02.Complete.1080p",
    );
    let bare_pack = make_stream(
        "Game.Of.Thrones.S02.1080p.BluRay.x264",
        "Game.Of.Thrones.S02.1080p.BluRay.x264",
    );
    let generic = make_stream(
        "What Is Dead May Never Die 1080p",
        "What.Is.Dead.May.Never.Die.1080p.mp4",
    );
    let wrong_episode = make_stream(
        "Game Of Thrones S02E04 Garden of Bones",
        "Game Of Thrones S02E04 Garden of Bones.mp4",
    );

    assert_eq!(score_stream_episode_match(&episode, 2, 3), 2800);
    assert_eq!(score_stream_episode_match(&pack, 2, 3), -1800);
    assert_eq!(score_stream_episode_match(&bare_pack, 2, 3), -1800);
    assert_eq!(score_stream_episode_match(&generic, 2, 3), 0);
    assert_eq!(score_stream_episode_match(&wrong_episode, 2, 3), -3400);
}

#[test]
fn extracts_stream_filename() {
    let stream = DiscoveryStream {
        infoHash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
        name: "Torrentio".to_owned(),
        title: String::new(),
        description: String::new(),
        behaviorHints: DiscoveryBehaviorHints {
            filename: "Movie.2024.mp4".to_owned(),
        },
        sources: Vec::new(),
        ..DiscoveryStream::default()
    };
    assert_eq!(stream.behaviorHints.filename, "Movie.2024.mp4");
}

#[test]
fn normalizes_torrentio_stream_cache_keys() {
    assert_eq!(
        build_torrentio_stream_cache_key("https://torrentio.strem.fun/", "/stream/movie/tt1.json"),
        "torrentio:https://torrentio.strem.fun/stream/movie/tt1.json"
    );
}

#[test]
fn parses_torrentio_file_index_for_local_playback() {
    let payload = json!({
        "streams": [{
            "infoHash": "0123456789abcdef0123456789abcdef01234567",
            "fileIdx": 7,
            "name": "Torrentio",
            "behaviorHints": { "filename": "Show.S01E08.mkv" }
        }]
    });
    let streams = parse_torrentio_streams_payload(&payload).expect("torrentio streams");
    assert_eq!(streams.len(), 1);
    assert_eq!(streams[0].fileIdx, Some(7));
    assert_eq!(streams[0].discoveryProvider, "torrentio");
}

#[test]
fn builds_torznab_urls_without_leaking_api_keys_to_cache_keys() {
    let params = vec![
        ("t", "movie".to_owned()),
        ("imdbid", "tt1234567".to_owned()),
        ("cat", "2000,2040".to_owned()),
        ("limit", "50".to_owned()),
        ("extended", "1".to_owned()),
    ];
    let request_url = build_torznab_request_url(
        "http://127.0.0.1:9696/1/api?apikey=old-key&profile=default",
        "new-key",
        &params,
    )
    .expect("build torznab url");
    assert!(request_url.contains("profile=default"));
    assert!(request_url.contains("apikey=new-key"));
    assert!(!request_url.contains("old-key"));
    assert!(request_url.contains("t=movie"));
    assert!(request_url.contains("imdbid=tt1234567"));

    let cache_key = build_torznab_stream_cache_key(
        "http://127.0.0.1:9696/1/api?apikey=old-key&profile=default",
        &params,
    );
    assert!(cache_key.starts_with("torznab:http://127.0.0.1:9696/1/api?"));
    assert!(cache_key.contains("profile=default"));
    assert!(cache_key.contains("imdbid=tt1234567"));
    assert!(!cache_key.contains("apikey"));
    assert!(!cache_key.contains("old-key"));

    let download_cache_key = build_torznab_download_cache_key(
        "http://127.0.0.1:9117/dl/rutracker/?jackett_apikey=secret&path=topic",
    );
    assert!(download_cache_key.contains("path=topic"));
    assert!(!download_cache_key.contains("jackett_apikey"));
    assert!(!download_cache_key.contains("secret"));
}

#[test]
fn limits_torznab_download_hydration_to_the_configured_origin() {
    let api_url = "http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api";
    assert!(torznab_download_url_allowed(
        api_url,
        "http://127.0.0.1:9117/dl/rutracker/123?path=topic"
    ));
    assert!(!torznab_download_url_allowed(
        api_url,
        "http://127.0.0.1:9696/dl/rutracker/123"
    ));
    assert!(!torznab_download_url_allowed(
        api_url,
        "https://attacker.example/dl/rutracker/123"
    ));
}

#[test]
fn extracts_info_hash_from_magnet_urls() {
    assert_eq!(
        extract_info_hash_from_magnet(
            "magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Movie"
        ),
        "abcdef0123456789abcdef0123456789abcdef01"
    );
    assert!(extract_info_hash_from_magnet("https://example.com/file.torrent").is_empty());
}

#[test]
fn parses_torznab_xml_into_discovery_streams() {
    let xml = r#"
        <rss>
          <channel>
            <item>
              <title>The Housemaid 2025 1080p WEB-DL x264-GROUP</title>
              <link>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=The.Housemaid</link>
              <jackettindexer>ExampleIndexer</jackettindexer>
              <torznab:attr name="seeders" value="321" />
              <torznab:attr name="size" value="1610612736" />
              <torznab:attr name="team" value="GROUP" />
            </item>
            <item>
              <title>No usable hash</title>
              <link>https://example.com/file.torrent</link>
            </item>
          </channel>
        </rss>
    "#;
    let streams = parse_torznab_xml(xml).expect("parse torznab");
    assert_eq!(streams.len(), 2);
    let stream = &streams[0];
    assert_eq!(stream.infoHash, "abcdef0123456789abcdef0123456789abcdef01");
    assert_eq!(stream.name, "Torznab - ExampleIndexer");
    assert_eq!(stream.discoveryProvider, "torznab");
    assert!(stream.magnetUrl.starts_with("magnet:?"));
    assert_eq!(parse_seed_count(&stream.title), 321);
    assert!(stream.title.contains("💾 1.5 GB"));
    assert!(stream.title.contains("⚙ GROUP"));
    assert_eq!(streams[1].downloadUrl, "https://example.com/file.torrent");
    assert!(streams[1].infoHash.is_empty());
}

#[test]
fn merges_supplementary_discovery_sources_without_duplicate_hashes() {
    let shared_hash = "abcdef0123456789abcdef0123456789abcdef01";
    let torrentio = sample_stream("Torrentio copy", shared_hash);
    let mut torznab_duplicate = sample_stream("Torznab copy", &shared_hash.to_uppercase());
    torznab_duplicate.discoveryProvider = "torznab".to_owned();
    let mut torznab_unique = sample_stream(
        "BitSearch unique",
        "1111111111111111111111111111111111111111",
    );
    torznab_unique.discoveryProvider = "torznab".to_owned();

    let streams = merge_discovery_streams(vec![torrentio], vec![torznab_duplicate, torznab_unique]);

    assert_eq!(streams.len(), 2);
    assert_eq!(streams[0].title, "Torrentio copy");
    assert_eq!(streams[1].title, "BitSearch unique");
}

#[test]
fn combines_torznab_id_and_title_queries() {
    let primary = sample_stream("IMDb match", "2222222222222222222222222222222222222222");
    let search = sample_stream("Title match", "3333333333333333333333333333333333333333");

    let streams = merge_discovery_query_results(Ok(vec![primary]), Ok(vec![search]))
        .expect("merge query results");

    assert_eq!(streams.len(), 2);
}

#[test]
fn normalizes_rd_torrent_cache_keys() {
    assert_eq!(
        build_rd_torrent_cache_key("ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
        "rd-torrent:abcdef0123456789abcdef0123456789abcdef01"
    );
    assert_eq!(
        build_scoped_rd_torrent_cache_key("user:42", "ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
        "rd-torrent:user:42:abcdef0123456789abcdef0123456789abcdef01"
    );
}

#[test]
fn detects_real_debrid_selected_file_mismatch() {
    let ready_info = json!({
        "status": "downloaded",
        "files": [
            {"id": 2, "path": "/Succession.S01E01.mp4", "selected": 1},
            {"id": 3, "path": "/Succession.S01E02.mp4", "selected": 0}
        ],
        "links": ["https://real-debrid.example/file"]
    });

    assert!(!ready_info_has_selected_file_id(&ready_info, 3));
    assert!(ready_info_has_selected_file_id(&ready_info, 2));
}

#[test]
fn prefers_direct_for_browser_safe_real_debrid_mp4_sources() {
    assert!(!should_prefer_software_decode_source(
        "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4",
        "The.Matrix.1999.1080p.mp4"
    ));

    let normalized = normalize_resolved_source_for_software_decode(
        &ResolvedSource {
            playable_url: "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4"
                .to_owned(),
            filename: "The.Matrix.1999.1080p.mp4".to_owned(),
            ..ResolvedSource::default()
        },
        -1,
        -1,
    );

    assert_eq!(
        normalized.playable_url,
        "https://126-4.download.real-debrid.com/path/The.Matrix.1999.1080p.mp4"
    );
    assert_eq!(
        normalized.fallback_urls,
        vec![
            "/api/remux?input=https%3A%2F%2F126-4.download.real-debrid.com%2Fpath%2FThe.Matrix.1999.1080p.mp4"
        ]
    );
}

#[test]
fn real_debrid_transcode_hls_stays_direct_with_safe_remux_recovery() {
    let hls = "https://3.stream.real-debrid.com/t/download/audio/none/aac/full.m3u8";
    let download = "https://126-4.download.real-debrid.com/path/Parasite.2019.mkv";
    let normalized = normalize_resolved_source_for_software_decode(
        &ResolvedSource {
            playable_url: hls.to_owned(),
            fallback_urls: vec![download.to_owned()],
            filename: "Parasite.2019.mkv".to_owned(),
            ..ResolvedSource::default()
        },
        -1,
        -1,
    );

    assert_eq!(normalized.playable_url, hls);
    assert_eq!(normalized.fallback_urls.len(), 1);
    assert!(normalized.fallback_urls[0].starts_with("/api/remux?input="));
    assert!(!normalized.fallback_urls.iter().any(|url| url == download));
}

#[test]
fn keeps_direct_local_mp4_with_remux_recovery_fallback() {
    let raw =
        "/api/local-torrent/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=7";
    let normalized = normalize_resolved_source_for_software_decode(
        &ResolvedSource {
            playable_url: raw.to_owned(),
            filename: "Movie.2026.mp4".to_owned(),
            ..ResolvedSource::default()
        },
        -1,
        -1,
    );

    assert_eq!(normalized.playable_url, raw);
    assert_eq!(normalized.fallback_urls.len(), 1);
    assert!(normalized.fallback_urls[0].starts_with("/api/remux?input="));
    assert!(normalized.fallback_urls[0].contains("local-torrent%2Fstream"));
}

#[test]
fn local_cache_upgrade_requests_deferred_track_enrichment() {
    let playable_url =
        "/api/local-torrent/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=7";
    let payload = local_cache_upgrade_payload(LocalTorrentResolvedSource {
        playable_url: playable_url.to_owned(),
        filename: "Show.S01E08.mkv".to_owned(),
        source_hash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
        selected_file: "7".to_owned(),
        selected_file_path: "Show.S01E08.mkv".to_owned(),
    });

    assert_eq!(payload["ready"], true);
    assert_eq!(payload["tracksPending"], true);
    assert_eq!(payload["sourceInput"], playable_url);
}

#[test]
fn cached_probe_routes_browser_unsafe_audio_to_remux_immediately() {
    let preferences = ResolvePreferences {
        audio_lang: "auto".to_owned(),
        subtitle_lang: "off".to_owned(),
        quality: "auto".to_owned(),
    };
    let ac3_probe = MediaProbe {
        videoCodec: "h264".to_owned(),
        audioTracks: vec![AudioTrack {
            streamIndex: 1,
            language: "ko".to_owned(),
            codec: "ac3".to_owned(),
            channels: 6,
            isDefault: true,
            ..AudioTrack::default()
        }],
        ..MediaProbe::default()
    };
    assert_eq!(
        select_resolved_track_indexes(&ac3_probe, &preferences),
        (1, -1),
        "a cached AC-3 default track must select remux before playback starts",
    );

    let aac_probe = MediaProbe {
        audioTracks: vec![AudioTrack {
            streamIndex: 1,
            language: "ko".to_owned(),
            codec: "aac".to_owned(),
            isDefault: true,
            ..AudioTrack::default()
        }],
        ..MediaProbe::default()
    };
    assert_eq!(
        select_resolved_track_indexes(&aac_probe, &preferences),
        (-1, -1),
        "browser-safe default audio must preserve the direct RD fast path",
    );
}

#[test]
fn omits_raw_mkv_fallback_when_remux_is_required() {
    let raw = "https://126-4.download.real-debrid.com/path/Succession.S01E01.mkv";

    let normalized = normalize_resolved_source_for_software_decode(
        &ResolvedSource {
            playable_url: raw.to_owned(),
            filename: "Succession.S01E01.mkv".to_owned(),
            fallback_urls: vec![raw.to_owned()],
            ..ResolvedSource::default()
        },
        1,
        -1,
    );

    assert!(normalized.playable_url.starts_with("/api/remux?"));
    assert!(normalized.fallback_urls.is_empty());
}

#[test]
fn computes_torrentio_cache_deadlines_from_payload() {
    let before = now_ms();
    let payload = json!({
        "cacheMaxAge": 60,
        "staleRevalidate": 120,
        "staleError": 300
    });
    let (expires_at, next_validation_at) = compute_torrentio_cache_deadlines(&payload);
    assert!(next_validation_at >= before + 60_000);
    assert!(expires_at >= next_validation_at + 300_000);
}

fn sample_movie_metadata() -> ResolveMetadata {
    ResolveMetadata {
        tmdb_id: "1368166".to_owned(),
        imdb_id: "tt0000001".to_owned(),
        display_title: "The Housemaid".to_owned(),
        display_year: "2025".to_owned(),
        runtime_seconds: 6_720,
        season_number: 0,
        episode_number: 0,
        episode_title: String::new(),
        media_type: "movie".to_owned(),
    }
}

fn sample_tv_metadata() -> ResolveMetadata {
    ResolveMetadata {
        tmdb_id: "76331".to_owned(),
        imdb_id: "tt7660850".to_owned(),
        display_title: "Succession".to_owned(),
        display_year: "2018".to_owned(),
        runtime_seconds: 3_840,
        season_number: 1,
        episode_number: 1,
        episode_title: "Celebration".to_owned(),
        media_type: "tv".to_owned(),
    }
}

#[test]
fn nebula_addon_base_normalizes_and_requires_https() {
    assert_eq!(
        normalize_nebula_addon_base("https://nebula.work.gd/private/abc123/"),
        Some("https://nebula.work.gd/private/abc123".to_owned())
    );
    // Pasting the full manifest URL is tolerated.
    assert_eq!(
        normalize_nebula_addon_base("  https://nebula.work.gd/private/abc123/manifest.json  "),
        Some("https://nebula.work.gd/private/abc123".to_owned())
    );
    // Blank / non-https / scheme-only => inert (no provider sources).
    assert_eq!(normalize_nebula_addon_base(""), None);
    assert_eq!(normalize_nebula_addon_base("   "), None);
    assert_eq!(normalize_nebula_addon_base("http://nebula.work.gd/x"), None);
    assert_eq!(normalize_nebula_addon_base("https://"), None);
}

#[test]
fn stremio_addon_stream_url_builds_movie_and_series_endpoints() {
    let movie = sample_movie_metadata();
    assert_eq!(
        stremio_addon_stream_url("https://nebula.work.gd/private/abc", &movie),
        Some("https://nebula.work.gd/private/abc/stream/movie/tt0000001.json".to_owned())
    );
    // Trailing slash on the base is collapsed.
    assert_eq!(
        stremio_addon_stream_url("https://nebula.work.gd/private/abc/", &movie),
        Some("https://nebula.work.gd/private/abc/stream/movie/tt0000001.json".to_owned())
    );
    let tv = sample_tv_metadata();
    assert_eq!(
        stremio_addon_stream_url("https://addon-osvh.onrender.com", &tv),
        Some("https://addon-osvh.onrender.com/stream/series/tt7660850:1:1.json".to_owned())
    );
    // No IMDb id => no endpoint (these addons key on tt…, not TMDB).
    let mut no_imdb = sample_movie_metadata();
    no_imdb.imdb_id = String::new();
    assert_eq!(
        stremio_addon_stream_url("https://nebula.work.gd", &no_imdb),
        None
    );
}

#[test]
fn nebula_is_a_hls_capable_fallback_embed_provider() {
    let nebula = EXTERNAL_EMBED_PROVIDERS
        .iter()
        .copied()
        .find(|provider| provider.id == "nebula")
        .map(|provider| ExternalEmbedSource {
            provider,
            server: None,
        })
        .expect("nebula provider registered");
    assert!(is_external_embed_hls_capable_source(nebula));
    assert!(is_default_external_embed_hls_fallback_source(nebula));
    // Registered in the shared registry with a positive default rank weight,
    // and inert until NEBULA_ADDON_BASE is configured (no URL without a base).
    assert!(crate::provider_registry::embed_default_rank("nebula") > 0);
    assert!(external_embed_url(nebula, &sample_movie_metadata()).is_none());
}

fn sample_stream(title: &str, info_hash: &str) -> DiscoveryStream {
    DiscoveryStream {
        infoHash: info_hash.to_owned(),
        name: "Torrentio".to_owned(),
        title: title.to_owned(),
        description: "English audio • 1h 52m • 👤 950".to_owned(),
        behaviorHints: DiscoveryBehaviorHints::default(),
        sources: Vec::new(),
        ..DiscoveryStream::default()
    }
}

fn sample_source_filters() -> SourceFilters {
    SourceFilters {
        min_seeders: 0,
        allowed_formats: Vec::new(),
        source_language: "en".to_owned(),
        source_audio_profile: "single".to_owned(),
    }
}

#[test]
fn local_torrent_first_wave_includes_its_swarm_optimized_candidate() {
    let ranked_huge = sample_stream(
        "The Matrix 1999 2160p Remux.mkv\n💾 76 GB\n👤 300",
        "1111111111111111111111111111111111111111",
    );
    let ranked_large = sample_stream(
        "The Matrix 1999 2160p WEB-DL.mkv\n💾 24 GB\n👤 180",
        "2222222222222222222222222222222222222222",
    );
    let small_mp4 = sample_stream(
        "The Matrix 1999 1080p BluRay.x264.mp4\n💾 2.2 GB\n👤 2,400",
        "3333333333333333333333333333333333333333",
    );
    let medium_mkv = sample_stream(
        "The Matrix 1999 1080p BluRay.mkv\n💾 8 GB\n👤 650",
        "4444444444444444444444444444444444444444",
    );
    let candidates = vec![&ranked_huge, &ranked_large, &medium_mkv, &small_mp4];

    let selected = prioritize_local_torrent_first_wave(candidates);

    assert_eq!(selected.len(), 4);
    assert_eq!(selected[0].infoHash, ranked_huge.infoHash);
    assert_eq!(selected[1].infoHash, small_mp4.infoHash);
    assert_eq!(selected[2].infoHash, ranked_large.infoHash);
}

#[test]
fn local_torrent_first_wave_prefers_h264_copy_over_x265_transcode() {
    let ranked_first = sample_stream(
        "Example 2160p Remux.mkv\n💾 76 GB\n👤 300",
        "1111111111111111111111111111111111111111",
    );
    let ranked_second = sample_stream(
        "Example 2160p WEB-DL.mkv\n💾 24 GB\n👤 180",
        "2222222222222222222222222222222222222222",
    );
    let x265_mp4 = sample_stream(
        "Example 1080p WEB-DL.x265.mp4\n💾 2.2 GB\n👤 2,400",
        "3333333333333333333333333333333333333333",
    );
    let h264_mkv = sample_stream(
        "Example 1080p WEB-DL.H.264.mkv\n💾 2.2 GB\n👤 2,400",
        "4444444444444444444444444444444444444444",
    );

    let selected = prioritize_local_torrent_first_wave(vec![
        &ranked_first,
        &ranked_second,
        &x265_mp4,
        &h264_mkv,
    ]);

    assert_eq!(selected[0].infoHash, ranked_first.infoHash);
    assert_eq!(selected[1].infoHash, h264_mkv.infoHash);
    assert_ne!(selected[1].infoHash, x265_mp4.infoHash);
}

#[test]
fn deprioritizes_ts_releases_against_comparable_web_sources() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::from([
        ("1111111111111111111111111111111111111111".to_owned(), 1200),
        ("2222222222222222222222222222222222222222".to_owned(), 0),
    ]);
    let ts = sample_stream(
        "The Housemaid 2025 1080p TS EN-RGB\n⚙ TS-GROUP",
        "1111111111111111111111111111111111111111",
    );
    let web = sample_stream(
        "The Housemaid 2025 1080p AMZN WEB-DL DDP5.1 H.264-BYNDR\n⚙ BYNDR",
        "2222222222222222222222222222222222222222",
    );

    let ranked = sort_movie_candidates(
        vec![&ts, &web],
        &metadata,
        "en",
        "auto",
        &sample_source_filters(),
        &health_scores,
    );

    assert_eq!(ranked[0].infoHash, web.infoHash);
    assert_eq!(ranked[1].infoHash, ts.infoHash);
}

#[test]
fn prefers_single_audio_release_over_explicit_multi_audio_pack() {
    let metadata = sample_movie_metadata();
    let health_scores = HashMap::new();
    let single_audio = sample_stream(
        "The Housemaid 2025 1080p AMZN WEB-DL English\n⚙ BYNDR",
        "3333333333333333333333333333333333333333",
    );
    let multi_audio = sample_stream(
        "The Housemaid 2025 1080p AMZN WEB-DL Multi Audio English\n⚙ PACK",
        "4444444444444444444444444444444444444444",
    );

    let ranked = sort_movie_candidates(
        vec![&multi_audio, &single_audio],
        &metadata,
        "auto",
        "auto",
        &sample_source_filters(),
        &health_scores,
    );

    assert_eq!(ranked[0].infoHash, single_audio.infoHash);
    assert_eq!(ranked[1].infoHash, multi_audio.infoHash);
}

#[test]
fn filename_match_does_not_treat_webrip_suffix_as_title_match() {
    assert!(does_filename_likely_match_movie(
        "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4",
        "The Rip",
        "2026"
    ));
    assert!(!does_filename_likely_match_movie(
        r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4"#,
        "The Rip",
        "2026"
    ));
}

#[test]
fn filters_unrelated_sources_for_short_movie_titles() {
    let mut metadata = sample_movie_metadata();
    metadata.display_title = "The Rip".to_owned();
    metadata.display_year = "2026".to_owned();

    let good = sample_stream(
        "The.Rip.2026.1080p.WEBRip.x265.10bit.AAC5.1-[YTS.BZ].mp4\n👤 604",
        "5555555555555555555555555555555555555555",
    );
    let unrelated = sample_stream(
        r#"2024-10-10 - "Multiple Alien Groups May Be Visiting Earth!" (Lue Elizondo Documentary).mp4
👤 999"#,
        "6666666666666666666666666666666666666666",
    );

    let streams = vec![good.clone(), unrelated.clone()];
    let selected = select_top_movie_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "",
        5,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].infoHash, good.infoHash);
}

#[test]
fn avoids_failed_mp4_default_candidate_when_health_is_bad() {
    let metadata = sample_movie_metadata();
    let bad_mp4 = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mp4\n👤 1000",
        "9999999999999999999999999999999999999999",
    );
    let good_mkv = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mkv\n👤 5",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    let streams = vec![bad_mp4.clone(), good_mkv.clone()];
    let health_scores = HashMap::from([(
        "9999999999999999999999999999999999999999".to_owned(),
        SOURCE_HEALTH_AVOID_SCORE - 1_000,
    )]);

    let selected = select_top_movie_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "",
        1,
        &sample_source_filters(),
        &health_scores,
        true,
    );

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].infoHash, good_mkv.infoHash);
}

#[test]
fn prefers_mp4_for_tv_episode_auto_container_when_unpinned() {
    let metadata = sample_tv_metadata();
    let high_seed_mkv = sample_stream(
        "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let direct_mp4 = sample_stream(
        "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 5",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    let streams = vec![high_seed_mkv.clone(), direct_mp4.clone()];

    let selected = select_top_episode_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "auto",
        "",
        2,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].infoHash, direct_mp4.infoHash);
    assert_eq!(selected[1].infoHash, high_seed_mkv.infoHash);
}

#[test]
fn keeps_mp4_alternates_ahead_of_mkv_for_tv_default() {
    let metadata = sample_tv_metadata();
    let high_seed_mkv = sample_stream(
        "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let first_mp4 = sample_stream(
        "Succession S01E01 1080p.mp4\n👤 42",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    let second_mp4 = sample_stream(
        "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 9",
        "dddddddddddddddddddddddddddddddddddddddd",
    );
    let streams = vec![high_seed_mkv.clone(), first_mp4.clone(), second_mp4.clone()];

    let selected = select_top_episode_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "auto",
        "",
        3,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 3);
    assert_eq!(selected[0].infoHash, first_mp4.infoHash);
    assert_eq!(selected[1].infoHash, second_mp4.infoHash);
    assert_eq!(selected[2].infoHash, high_seed_mkv.infoHash);
}

#[test]
fn ranks_high_seeder_mkv_first_when_local_torrent_skips_mp4_default() {
    let metadata = sample_tv_metadata();
    let high_seed_mkv = sample_stream(
        "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let weak_mp4 = sample_stream(
        "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 5",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    let streams = vec![weak_mp4.clone(), high_seed_mkv.clone()];

    let selected = select_top_episode_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "auto",
        "",
        2,
        &sample_source_filters(),
        &HashMap::new(),
        false,
    );

    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].infoHash, high_seed_mkv.infoHash);
    assert_eq!(selected[1].infoHash, weak_mp4.infoHash);
}

#[test]
fn ranks_high_seeder_movie_mkv_first_when_local_torrent_skips_mp4_default() {
    let metadata = sample_movie_metadata();
    let high_seed_mkv = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mkv\n👤 900",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let weak_mp4 = sample_stream(
        "The Housemaid 2025 1080p BluRay x265-GROUP.mp4\n👤 5",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    let streams = vec![weak_mp4.clone(), high_seed_mkv.clone()];

    let selected = select_top_movie_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "",
        2,
        &sample_source_filters(),
        &HashMap::new(),
        false,
    );

    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].infoHash, high_seed_mkv.infoHash);
    assert_eq!(selected[1].infoHash, weak_mp4.infoHash);
}

#[test]
fn keeps_pinned_tv_episode_source_ahead_of_default_mp4() {
    let metadata = sample_tv_metadata();
    let pinned_mkv = sample_stream(
        "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
        "dddddddddddddddddddddddddddddddddddddddd",
    );
    let direct_mp4 = sample_stream(
        "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4\n👤 5",
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );
    let streams = vec![direct_mp4.clone(), pinned_mkv.clone()];

    let selected = select_top_episode_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "auto",
        &pinned_mkv.infoHash,
        2,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    // Pinned selection is exclusive — no race substitutes.
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].infoHash, pinned_mkv.infoHash);
}

#[test]
fn pinned_missing_hash_does_not_return_substitute_candidates() {
    let metadata = sample_tv_metadata();
    let available = sample_stream(
        "Succession S01E01 Celebration 1080p AMZN WEB-DL DDP5.1 H.264-NTb.mkv\n👤 900",
        "dddddddddddddddddddddddddddddddddddddddd",
    );
    let streams = vec![available];

    let selected = select_top_episode_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "auto",
        "ffffffffffffffffffffffffffffffffffffffff",
        3,
        &sample_source_filters(),
        &HashMap::new(),
        true,
    );

    assert!(selected.is_empty());
}

#[test]
fn skips_non_mp4_playback_session_for_mp4_container_preference() {
    let filters = ResolveFilters {
        source_hash: String::new(),
        preferred_container: "mp4".to_owned(),
        source_filters: sample_source_filters(),
    };
    let mkv_session = PlaybackSession {
        filename: "Succession.S01E01.1080p.WEB-DL.mkv".to_owned(),
        playable_url:
            "/api/remux?input=https%3A%2F%2Fdownload.real-debrid.com%2FSuccession.S01E01.mkv"
                .to_owned(),
        metadata: json!({
            "subtitleTargetFilePath": "/Succession.S01E01.1080p.WEB-DL.mkv"
        }),
        ..PlaybackSession::default()
    };
    let mp4_session = PlaybackSession {
        filename: "Succession.S01E01.1080p.BluRay.x265-RARBG.mp4".to_owned(),
        playable_url:
            "https://download.real-debrid.com/Succession.S01E01.1080p.BluRay.x265-RARBG.mp4"
                .to_owned(),
        ..PlaybackSession::default()
    };

    assert!(!playback_session_matches_preferred_container(
        &mkv_session,
        &filters
    ));
    assert!(playback_session_matches_preferred_container(
        &mp4_session,
        &filters
    ));
}

#[test]
fn skips_heavy_unpinned_session_for_mobile_quality_preference() {
    let filters = ResolveFilters {
        source_hash: String::new(),
        preferred_container: String::new(),
        source_filters: sample_source_filters(),
    };
    let preferences = ResolvePreferences {
        audio_lang: "auto".to_owned(),
        subtitle_lang: "off".to_owned(),
        quality: "720p".to_owned(),
    };
    let session = PlaybackSession {
        preferred_quality: "auto".to_owned(),
        filename: "Off.Campus.S01E02.1080p.HEVC.x265-MeGusta.mkv".to_owned(),
        playable_url:
            "/api/remux?input=https%3A%2F%2Fdownload.real-debrid.com%2FOff.Campus.S01E02.1080p.HEVC.x265-MeGusta.mkv"
                .to_owned(),
        ..PlaybackSession::default()
    };

    assert!(!playback_session_matches_preferred_quality(
        &session,
        &preferences,
        &filters
    ));

    let pinned_filters = ResolveFilters {
        source_hash: "1111111111111111111111111111111111111111".to_owned(),
        ..filters
    };
    assert!(playback_session_matches_preferred_quality(
        &session,
        &preferences,
        &pinned_filters
    ));
}

#[test]
fn strongly_penalizes_persistent_source_resolve_failures() {
    let score = compute_source_health_score(&SourceHealthStats {
        success_count: 0,
        failure_count: 1,
        playback_error_count: 1,
        ..SourceHealthStats::default()
    });

    assert!(score < SOURCE_HEALTH_AVOID_SCORE);
}

#[test]
fn torznab_candidates_use_existing_filters_and_hash_pinning() {
    let metadata = sample_movie_metadata();
    let torznab = DiscoveryStream {
        infoHash: "7777777777777777777777777777777777777777".to_owned(),
        name: "Torznab - ExampleIndexer".to_owned(),
        title: "The Housemaid 2025 1080p WEB-DL x264-GROUP\n💾 1.5 GB\n⚙ GROUP\n👤 80".to_owned(),
        behaviorHints: DiscoveryBehaviorHints {
            filename: "The Housemaid 2025 1080p WEB-DL x264-GROUP".to_owned(),
        },
        discoveryProvider: "torznab".to_owned(),
        ..DiscoveryStream::default()
    };
    let low_seed = DiscoveryStream {
        infoHash: "8888888888888888888888888888888888888888".to_owned(),
        name: "Torznab - ExampleIndexer".to_owned(),
        title: "The Housemaid 2025 1080p WEB-DL x264-LOW\n👤 3".to_owned(),
        behaviorHints: DiscoveryBehaviorHints {
            filename: "The Housemaid 2025 1080p WEB-DL x264-LOW".to_owned(),
        },
        discoveryProvider: "torznab".to_owned(),
        ..DiscoveryStream::default()
    };
    let streams = vec![low_seed, torznab];
    let filters = SourceFilters {
        min_seeders: 50,
        allowed_formats: vec!["mkv".to_owned()],
        source_language: "en".to_owned(),
        source_audio_profile: "single".to_owned(),
    };
    let selected = select_top_movie_candidates(
        &streams,
        &metadata,
        "en",
        "1080p",
        "7777777777777777777777777777777777777777",
        5,
        &filters,
        &HashMap::new(),
        true,
    );

    assert_eq!(selected.len(), 1);
    let summary = summarize_stream_candidate_for_client(
        selected[0],
        &metadata,
        "en",
        "1080p",
        &filters,
        &HashMap::new(),
    )
    .expect("torrent source summary");
    assert!(summary.isTorrent);
    assert_eq!(summary.seeders, 80);
    assert_eq!(
        selected[0].infoHash,
        "7777777777777777777777777777777777777777"
    );
    assert!(stream_list_contains_hash(
        &streams,
        "7777777777777777777777777777777777777777"
    ));
    assert!(!stream_list_contains_hash(
        &streams,
        "9999999999999999999999999999999999999999"
    ));
}

#[test]
fn normalizes_source_audio_profile_to_single_by_default() {
    assert_eq!(normalize_source_audio_profile_filter(""), "single");
    assert_eq!(
        normalize_source_audio_profile_filter("single-audio"),
        "single"
    );
    assert_eq!(normalize_source_audio_profile_filter("multi-audio"), "any");
}

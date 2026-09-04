use super::*;

const BENCHMARK_EXACT_SESSION_MIN_FRESH_MS: i64 = 15_000;

pub(super) struct BenchmarkExactSessionRequest<'a> {
    pub(super) user_id: i64,
    pub(super) media_type: &'a str,
    pub(super) tmdb_id: &'a str,
    pub(super) title: &'a str,
    pub(super) year: &'a str,
    pub(super) season_number: i64,
    pub(super) episode_number: i64,
    pub(super) audio_lang: &'a str,
    pub(super) quality: &'a str,
    pub(super) subtitle_lang: &'a str,
    pub(super) source_hash: &'a str,
    pub(super) session_key: &'a str,
}

impl ResolverService {
    pub(super) fn benchmark_exact_session_is_fresh(
        session: &PlaybackSession,
        checked_at_ms: i64,
    ) -> bool {
        session.health_state == "healthy"
            && session.health_fail_count == 0
            && session.last_error.trim().is_empty()
            && session.next_validation_at
                > checked_at_ms.saturating_add(BENCHMARK_EXACT_SESSION_MIN_FRESH_MS)
    }

    /// Serve the Real-Debrid benchmark only from one exact, already-fresh
    /// persisted session. This path intentionally runs before TMDB lookup and
    /// never revalidates, invalidates, discovers, or persists anything.
    pub(super) async fn resolve_benchmark_exact_session(
        &self,
        request: BenchmarkExactSessionRequest<'_>,
        real_debrid: Option<&RealDebridRequestContext>,
    ) -> AppResult<Value> {
        let unavailable =
            || ApiError::failed_dependency("The exact benchmark playback session is unavailable.");
        let requested_source_hash = normalize_source_hash(request.source_hash);
        if !self.config.playback_sessions_enabled
            || !request.subtitle_lang.trim().eq_ignore_ascii_case("off")
            || request.session_key.trim().is_empty()
            || requested_source_hash.len() != 40
            || !requested_playback_session_key_allowed(
                request.session_key,
                ResolverProvider::RealDebrid,
                request.user_id,
            )
        {
            return Err(unavailable());
        }
        let real_debrid = real_debrid.ok_or_else(unavailable)?;
        let session = self
            .db
            .get_playback_session(request.user_id, request.session_key.trim().to_owned())
            .await?
            .ok_or_else(unavailable)?;
        if !Self::benchmark_exact_session_is_fresh(&session, now_ms())
            || session.tmdb_id != request.tmdb_id.trim()
            || session.playable_url.trim().is_empty()
            || normalize_source_hash(&session.source_hash) != requested_source_hash
            || !playback_session_matches_resolver_provider(&session, ResolverProvider::RealDebrid)
            || !playback_session_matches_real_debrid_scope(
                &session,
                ResolverProvider::RealDebrid,
                Some(real_debrid),
            )
        {
            return Err(unavailable());
        }

        let metadata = ResolveMetadata {
            tmdb_id: stringify_json(session.metadata.get("tmdbId")),
            imdb_id: stringify_json(session.metadata.get("imdbId")),
            display_title: stringify_json(session.metadata.get("displayTitle")),
            display_year: stringify_json(session.metadata.get("displayYear")),
            runtime_seconds: session
                .metadata
                .get("runtimeSeconds")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            season_number: session
                .metadata
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            episode_number: session
                .metadata
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            episode_title: stringify_json(session.metadata.get("episodeTitle")),
            media_type: stringify_json(session.metadata.get("mediaType")),
        };
        let preferences = ResolvePreferences {
            audio_lang: normalize_preferred_audio_lang(request.audio_lang),
            subtitle_lang: normalize_subtitle_preference(request.subtitle_lang),
            quality: normalize_preferred_stream_quality(request.quality),
        };
        let expected_session_key = build_user_scoped_playback_session_key_for_metadata(
            &metadata,
            &preferences.audio_lang,
            &preferences.quality,
            ResolverProvider::RealDebrid,
            request.user_id,
        );
        let request_matches = metadata.tmdb_id == request.tmdb_id.trim()
            && metadata.media_type == request.media_type
            && normalize_whitespace(&metadata.display_title) == normalize_whitespace(request.title)
            && metadata.display_year.trim() == request.year.trim()
            && metadata.season_number == request.season_number
            && metadata.episode_number == request.episode_number
            && session.audio_lang == preferences.audio_lang
            && normalize_preferred_stream_quality(&session.preferred_quality)
                == preferences.quality
            && session.session_key == expected_session_key;
        let match_name = playback_session_match_name(&session);
        let filename_matches = if metadata.media_type == "tv" {
            does_filename_likely_match_tv_episode(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
                metadata.season_number,
                metadata.episode_number,
            )
        } else {
            does_filename_likely_match_movie(
                &match_name,
                &metadata.display_title,
                &metadata.display_year,
            )
        };
        if !request_matches || !filename_matches {
            return Err(unavailable());
        }

        let resolved = ResolvedSource {
            playable_url: session.playable_url.clone(),
            fallback_urls: session.fallback_urls.clone(),
            filename: session.filename.clone(),
            source_hash: session.source_hash.clone(),
            selected_file: session.selected_file.clone(),
            selected_file_path: playback_session_selected_file_path(&session),
            real_debrid_cached: session
                .metadata
                .get("realDebridCached")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let mut payload = self
            .build_resolved_response(
                resolved,
                metadata,
                preferences,
                ResolverProvider::RealDebrid,
                request.user_id,
                Some(real_debrid),
                false,
                false,
            )
            .await?;
        payload["session"] = build_playback_session_payload(&session);
        payload["benchmarkExactSessionReuse"] = Value::Bool(true);
        Ok(payload)
    }
}

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

#[derive(Debug, Clone, Default)]
pub(super) struct ContinueWatchingSourceMetadata {
    pub(super) source_hash: String,
    pub(super) session_key: String,
    pub(super) resolver_provider: String,
    pub(super) source_input: String,
    pub(super) filename: String,
    pub(super) updated_at: i64,
    pub(super) last_accessed_at: i64,
}

pub(super) fn continue_watching_target_episode(
    source_identity: &str,
    episode_index: i64,
    entry: Option<&Value>,
) -> (i64, i64) {
    let mut season_number = entry
        .and_then(|value| value.get("seasonNumber"))
        .and_then(|value| json_number_to_i64(Some(value)))
        .unwrap_or(0);
    let mut episode_number = entry
        .and_then(|value| value.get("episodeNumber"))
        .and_then(|value| json_number_to_i64(Some(value)))
        .unwrap_or(0);

    if let Some((_, parsed_season, parsed_episode)) = parse_tmdb_tv_source_identity(source_identity)
    {
        if season_number <= 0 {
            season_number = parsed_season;
        }
        if episode_number <= 0 {
            episode_number = parsed_episode;
        }
    }
    if season_number <= 0 {
        season_number = 1;
    }
    if episode_number <= 0 && episode_index >= 0 {
        episode_number = episode_index + 1;
    }
    (season_number, episode_number)
}

pub(super) struct ContinueWatchingReconcileInput<'a> {
    pub(super) user_id: i64,
    pub(super) tmdb_id: &'a str,
    pub(super) media_type: &'a str,
    pub(super) season_number: i64,
    pub(super) episode_number: i64,
    pub(super) source_hash: &'a str,
    pub(super) session_key: &'a str,
    pub(super) resolver_provider: &'a str,
    pub(super) source_input: &'a str,
}

pub(super) fn reconcile_continue_watching_source_metadata(
    connection: &Connection,
    input: ContinueWatchingReconcileInput<'_>,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let normalized_tmdb_id = input.tmdb_id.trim();
    if normalized_tmdb_id.is_empty() {
        return Ok(None);
    }

    let Some(candidate) = latest_continue_watching_playback_session_metadata(
        connection,
        input.user_id,
        normalized_tmdb_id,
        input.media_type,
        input.season_number,
        input.episode_number,
    )?
    else {
        return Ok(None);
    };

    let incoming_source_hash = input.source_hash.trim().to_lowercase();
    let incoming_session_key = input.session_key.trim();
    let incoming_provider = input.resolver_provider.trim().to_lowercase();
    if incoming_provider == "external-embed" && candidate.resolver_provider != "external-embed" {
        return Ok(None);
    }

    if incoming_source_hash.is_empty()
        && incoming_session_key.is_empty()
        && incoming_provider.is_empty()
    {
        return Ok(Some(candidate));
    }

    if !incoming_session_key.is_empty() && candidate.session_key == incoming_session_key {
        return Ok(Some(candidate));
    }
    if !incoming_source_hash.is_empty() && candidate.source_hash == incoming_source_hash {
        return Ok(Some(candidate));
    }

    let current = continue_watching_playback_session_metadata_for_input(
        connection,
        input.user_id,
        incoming_session_key,
        &incoming_source_hash,
    )?;
    if let Some(current) = current {
        if continue_watching_session_timestamp(&candidate)
            > continue_watching_session_timestamp(&current)
        {
            return Ok(Some(candidate));
        }
        return Ok(None);
    }

    let incoming_looks_local = incoming_provider == "local-torrent"
        || incoming_session_key.starts_with("local-torrent:")
        || input.source_input.contains("/api/local-cache/")
        || input.source_input.contains("/api/local-torrent/");
    if incoming_looks_local && candidate.resolver_provider == "real-debrid" {
        return Ok(Some(candidate));
    }

    Ok(None)
}

fn latest_continue_watching_playback_session_metadata(
    connection: &Connection,
    user_id: i64,
    tmdb_id: &str,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE user_id = ?
          AND tmdb_id = ?
          AND health_state != 'invalid'
          AND playable_url != ''
        ORDER BY last_accessed_at DESC, updated_at DESC
        LIMIT 80
        ",
    )?;
    let rows = statement.query_map(params![user_id, tmdb_id.trim()], |row| {
        let session_key: String = row.get(0)?;
        let source_hash: String = row.get(1)?;
        let filename: String = row.get(2)?;
        let playable_url: String = row.get(3)?;
        let metadata_raw: String = row.get(4)?;
        let metadata = serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
        Ok((
            session_key,
            source_hash,
            filename,
            playable_url,
            metadata,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;

    let normalized_media_type = media_type.trim().to_lowercase();
    for row in rows {
        let (
            session_key,
            source_hash,
            filename,
            playable_url,
            metadata,
            updated_at,
            last_accessed_at,
        ) = row?;
        if !playback_session_matches_continue_target(
            &session_key,
            &metadata,
            &normalized_media_type,
            season_number,
            episode_number,
        ) {
            continue;
        }
        return Ok(Some(ContinueWatchingSourceMetadata {
            source_hash: source_hash.trim().to_lowercase(),
            session_key,
            resolver_provider: continue_watching_resolver_provider(&metadata, &playable_url),
            source_input: extract_continue_watching_source_input(&playable_url),
            filename,
            updated_at,
            last_accessed_at,
        }));
    }

    Ok(None)
}

fn continue_watching_playback_session_metadata_for_input(
    connection: &Connection,
    user_id: i64,
    session_key: &str,
    source_hash: &str,
) -> Result<Option<ContinueWatchingSourceMetadata>, rusqlite::Error> {
    let lookup_by_session_key = !session_key.trim().is_empty();
    if !lookup_by_session_key && source_hash.trim().is_empty() {
        return Ok(None);
    }

    let sql = if lookup_by_session_key {
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE user_id = ? AND session_key = ?
        LIMIT 1
        "
    } else {
        "
        SELECT session_key, source_hash, filename, playable_url, metadata_json,
               updated_at, last_accessed_at
        FROM playback_sessions
        WHERE user_id = ? AND source_hash = ?
        ORDER BY last_accessed_at DESC, updated_at DESC
        LIMIT 1
        "
    };
    let mut statement = connection.prepare(sql)?;
    let param = if lookup_by_session_key {
        session_key.trim()
    } else {
        source_hash.trim()
    };
    let row = statement
        .query_row(params![user_id, param], |row| {
            let metadata_raw: String = row.get(4)?;
            let metadata =
                serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
            let playable_url: String = row.get(3)?;
            Ok(ContinueWatchingSourceMetadata {
                session_key: row.get(0)?,
                source_hash: row.get::<_, String>(1)?.trim().to_lowercase(),
                filename: row.get(2)?,
                resolver_provider: continue_watching_resolver_provider(&metadata, &playable_url),
                source_input: extract_continue_watching_source_input(&playable_url),
                updated_at: row.get(5)?,
                last_accessed_at: row.get(6)?,
            })
        })
        .optional()?;

    if row.is_none() && lookup_by_session_key && !source_hash.trim().is_empty() {
        return continue_watching_playback_session_metadata_for_input(
            connection,
            user_id,
            "",
            source_hash,
        );
    }

    Ok(row)
}

fn continue_watching_session_timestamp(metadata: &ContinueWatchingSourceMetadata) -> i64 {
    metadata.updated_at.max(metadata.last_accessed_at)
}

fn playback_session_matches_continue_target(
    session_key: &str,
    metadata: &Value,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> bool {
    if media_type == "tv" {
        let (parsed_season, parsed_episode) =
            parse_tv_episode_from_session_key(session_key).unwrap_or((0, 0));
        let candidate_season =
            json_number_to_i64(metadata.get("seasonNumber")).unwrap_or(parsed_season);
        let candidate_episode =
            json_number_to_i64(metadata.get("episodeNumber")).unwrap_or(parsed_episode);
        return season_number > 0
            && episode_number > 0
            && candidate_season == season_number
            && candidate_episode == episode_number;
    }

    let session_media_type = metadata
        .get("mediaType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    session_media_type != "tv"
}

fn continue_watching_resolver_provider(metadata: &Value, playable_url: &str) -> String {
    let explicit = metadata
        .get("resolverProvider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if matches!(
        explicit.as_str(),
        "real-debrid" | "local-torrent" | "external-embed"
    ) {
        return explicit;
    }

    let url = playable_url.trim().to_lowercase();
    if url.contains("download.real-debrid.com") {
        return "real-debrid".to_owned();
    }
    if url.contains("/api/local-cache/") || url.contains("/api/local-torrent/") {
        return "local-torrent".to_owned();
    }
    if url.contains("/api/live/iframe") || url.contains("/api/embed/") {
        return "external-embed".to_owned();
    }
    String::new()
}

fn extract_continue_watching_source_input(playable_url: &str) -> String {
    let trimmed = playable_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some((path, query)) = trimmed.split_once('?')
        && (path.ends_with("/api/remux") || path == "/api/remux")
    {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if key == "input" {
                return value.into_owned();
            }
        }
    }
    trimmed.to_owned()
}

fn json_number_to_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64()
        && number.is_finite()
    {
        return Some(number.floor() as i64);
    }
    value.as_str()?.trim().parse::<i64>().ok()
}

fn parse_tmdb_tv_source_identity(value: &str) -> Option<(String, i64, i64)> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() < 5 || parts.first()? != &"tmdb" || parts.get(1)? != &"tv" {
        return None;
    }
    let tmdb_id = parts.get(2)?.trim();
    let season = parts
        .get(3)?
        .trim()
        .strip_prefix('s')?
        .parse::<i64>()
        .ok()?;
    let episode = parts
        .get(4)?
        .trim()
        .strip_prefix('e')?
        .parse::<i64>()
        .ok()?;
    if tmdb_id.is_empty() || season <= 0 || episode <= 0 {
        return None;
    }
    Some((tmdb_id.to_owned(), season, episode))
}

fn parse_tv_episode_from_session_key(value: &str) -> Option<(i64, i64)> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() < 4 || parts.first()? != &"tv" {
        return None;
    }
    let season = parts
        .get(2)?
        .trim()
        .strip_prefix('s')?
        .parse::<i64>()
        .ok()?;
    let episode = parts
        .get(3)?
        .trim()
        .strip_prefix('e')?
        .parse::<i64>()
        .ok()?;
    if season <= 0 || episode <= 0 {
        return None;
    }
    Some((season, episode))
}

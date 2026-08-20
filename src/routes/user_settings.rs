use super::*;

pub(super) fn normalize_bool_preference(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on" | "enabled"
    )
}

pub(super) fn normalize_bool_json_value(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::String(value) => normalize_bool_preference(value),
        Value::Number(value) => value.as_i64().unwrap_or_default() != 0,
        _ => false,
    }
}

pub(super) fn normalize_real_debrid_api_key(value: &str) -> String {
    value.trim().to_owned()
}

pub(super) fn is_valid_real_debrid_api_key(value: &str) -> bool {
    let normalized = normalize_real_debrid_api_key(value);
    if normalized.len() < 16 || normalized.len() > 512 || !normalized.is_ascii() {
        return false;
    }
    if normalized.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = normalized.to_lowercase();
    !matches!(
        lower.as_str(),
        "your_real_debrid_api_token_here" | "real_debrid_token" | "test" | "demo"
    )
}

pub(super) fn mask_real_debrid_api_key(value: &str) -> String {
    let normalized = normalize_real_debrid_api_key(value);
    if normalized.is_empty() {
        return String::new();
    }
    if normalized.len() <= 10 {
        return "****".to_owned();
    }
    format!(
        "{}****{}",
        &normalized[..4],
        &normalized[normalized.len().saturating_sub(4)..]
    )
}

pub(super) async fn real_debrid_api_key_for_user(
    state: &AppState,
    user_id: i64,
) -> AppResult<String> {
    let stored_value = state
        .db
        .get_user_preference(user_id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
        .await?;
    let configured = stored_value.is_some();
    if !real_debrid_enabled_for_user(&state.db, user_id, configured).await? {
        // Do not decrypt a disabled credential on ordinary resolver requests.
        return Ok(String::new());
    }
    decrypt_real_debrid_api_key(state, user_id, stored_value).await
}

pub(super) async fn configured_real_debrid_api_key_for_user(
    state: &AppState,
    user_id: i64,
) -> AppResult<String> {
    let stored_value = state
        .db
        .get_user_preference(user_id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
        .await?;
    decrypt_real_debrid_api_key(state, user_id, stored_value).await
}

pub(super) async fn decrypt_real_debrid_api_key(
    state: &AppState,
    user_id: i64,
    stored_value: Option<String>,
) -> AppResult<String> {
    let Some(stored_value) = stored_value else {
        return Ok(String::new());
    };
    let value = state
        .real_debrid_token_cipher
        .decrypt_for_user(user_id, &stored_value)?;
    let normalized = normalize_real_debrid_api_key(&value);
    Ok(if is_valid_real_debrid_api_key(&normalized) {
        normalized
    } else {
        String::new()
    })
}

pub(super) async fn real_debrid_enabled_for_user(
    db: &Db,
    user_id: i64,
    configured: bool,
) -> AppResult<bool> {
    let stored = db
        .get_user_preference(user_id, REAL_DEBRID_ENABLED_PREF_KEY.to_owned())
        .await?;
    Ok(configured && effective_real_debrid_enabled(stored.as_deref(), configured))
}

pub(super) fn effective_real_debrid_enabled(stored: Option<&str>, configured: bool) -> bool {
    configured
        && stored
            .map(normalize_bool_preference)
            // Existing users who saved a token before this separate toggle was
            // introduced keep their working configuration. New users with no token
            // remain opted out.
            .unwrap_or(true)
}

pub(super) fn plan_real_debrid_update(
    configured_before: bool,
    api_key_configured_update: Option<bool>,
    requested_enabled: Option<bool>,
) -> AppResult<(bool, bool)> {
    let configured_after = api_key_configured_update.unwrap_or(configured_before);
    let enabled_after = requested_enabled.unwrap_or(configured_after);
    if enabled_after && !configured_after {
        return Err(real_debrid_api_key_required_error());
    }
    Ok((configured_after, enabled_after))
}

pub(super) async fn local_torrent_enabled_for_user(db: &Db, user_id: i64) -> AppResult<bool> {
    Ok(db
        .get_user_preference(user_id, LOCAL_TORRENT_ENABLED_PREF_KEY.to_owned())
        .await?
        .map(|value| normalize_bool_preference(&value))
        .unwrap_or(false))
}

pub(super) fn real_debrid_api_key_required_error() -> ApiError {
    ApiError::failed_dependency(
        "Enable Real-Debrid and add an API token in Settings to use cached streaming.",
    )
}

pub(super) fn local_torrent_required_error() -> ApiError {
    ApiError::failed_dependency("Enable Torrent streaming in Settings to use magnet sources.")
}

pub(super) async fn user_preferences_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let prefs = state.db.get_user_preferences(user.id).await?;
            let mut obj = serde_json::Map::new();
            for (key, value) in prefs {
                if is_secret_user_preference_key(&key) {
                    continue;
                }
                obj.insert(key, Value::String(value));
            }
            Ok(json_response(Value::Object(obj)))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let entries: Vec<(String, String)> = match payload.as_object() {
                Some(obj) => user_preference_entries_from_object(obj),
                None => {
                    return Err(ApiError::bad_request("Body must be a JSON object."));
                }
            };
            state.db.upsert_user_preferences(user.id, entries).await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

pub(super) async fn user_real_debrid_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let api_key = configured_real_debrid_api_key_for_user(&state, user.id).await?;
            let configured = !api_key.is_empty();
            let enabled = real_debrid_enabled_for_user(&state.db, user.id, configured).await?;
            let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
            Ok(json_response(json!({
                "configured": configured,
                "enabled": enabled,
                "realDebridEnabled": enabled,
                "maskedApiKey": mask_real_debrid_api_key(&api_key),
                "localTorrentEnabled": local_torrent_enabled
            })))
        }
        Method::PUT => {
            // Preserve the request-derived client identity before consuming
            // the body; credential validation is bounded per account and IP.
            let client_ip = extract_client_ip(&request);
            let payload = parse_json_body(request).await?;
            let api_key_value = payload
                .get("apiKey")
                .or_else(|| payload.get("token"))
                .or_else(|| payload.get("realDebridApiKey"));
            let has_api_key_field = api_key_value.is_some();
            let api_key = match api_key_value {
                Some(Value::String(value)) => normalize_real_debrid_api_key(value),
                Some(_) => {
                    return Err(ApiError::bad_request(
                        "Real-Debrid apiKey must be a string; use an empty string to clear it.",
                    ));
                }
                None => String::new(),
            };

            let requested_enabled = payload
                .get("enabled")
                .or_else(|| payload.get("realDebridEnabled"))
                .map(normalize_bool_json_value);
            let configured_before_update = state
                .db
                .get_user_preference(user.id, REAL_DEBRID_TOKEN_PREF_KEY.to_owned())
                .await?
                .is_some();
            // Plan and reject contradictory updates before any credential or
            // preference write occurs.
            let (_, enabled_after_update) = plan_real_debrid_update(
                configured_before_update,
                has_api_key_field.then_some(!api_key.is_empty()),
                requested_enabled,
            )?;

            let token_change = if has_api_key_field {
                if api_key.is_empty() {
                    Some(None)
                } else {
                    if !is_valid_real_debrid_api_key(&api_key) {
                        return Err(ApiError::bad_request(
                            "Enter a valid Real-Debrid API token from Settings > API token.",
                        ));
                    }

                    // Validate before encrypting or mutating any stored setting
                    // so a typo, revoked token, or non-premium account leaves
                    // the previous credential/toggle state intact.
                    state
                        .resolver
                        .validate_real_debrid_api_key(user.id, &client_ip, &api_key)
                        .await?;
                    Some(Some(
                        state
                            .real_debrid_token_cipher
                            .encrypt_for_user(user.id, &api_key)?,
                    ))
                }
            } else {
                None
            };

            // Invalidate reusable cloud URLs before changing credential state.
            // Losing a cache entry if the following durable transaction fails
            // is safe; keeping an old-account session after replacement is not.
            if has_api_key_field {
                state
                    .db
                    .delete_real_debrid_playback_sessions_for_user(user.id)
                    .await?;
            }

            let mut preference_changes = Vec::new();
            if let Some(token_change) = token_change {
                preference_changes.push((REAL_DEBRID_TOKEN_PREF_KEY.to_owned(), token_change));
            }
            if requested_enabled.is_some() || has_api_key_field {
                preference_changes.push((
                    REAL_DEBRID_ENABLED_PREF_KEY.to_owned(),
                    Some(if enabled_after_update { "1" } else { "0" }.to_owned()),
                ));
            }

            if let Some(value) = payload.get("localTorrentEnabled") {
                let enabled = match value {
                    Value::Bool(value) => *value,
                    Value::String(value) => normalize_bool_preference(value),
                    Value::Number(value) => value.as_i64().unwrap_or_default() != 0,
                    _ => false,
                };
                preference_changes.push((
                    LOCAL_TORRENT_ENABLED_PREF_KEY.to_owned(),
                    Some(if enabled { "1" } else { "0" }.to_owned()),
                ));
            }
            state
                .db
                .apply_real_debrid_preference_changes(
                    user.id,
                    preference_changes,
                    REAL_DEBRID_TOKEN_PREF_KEY.to_owned(),
                    REAL_DEBRID_ENABLED_PREF_KEY.to_owned(),
                )
                .await?;

            let saved_api_key = configured_real_debrid_api_key_for_user(&state, user.id).await?;
            let configured = !saved_api_key.is_empty();
            let enabled = real_debrid_enabled_for_user(&state.db, user.id, configured).await?;
            let local_torrent_enabled = local_torrent_enabled_for_user(&state.db, user.id).await?;
            Ok(json_response(json!({
                "ok": true,
                "configured": configured,
                "enabled": enabled,
                "realDebridEnabled": enabled,
                "maskedApiKey": mask_real_debrid_api_key(&saved_api_key),
                "localTorrentEnabled": local_torrent_enabled
            })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET or PUT.",
        )),
    }
}

pub(super) async fn user_watch_progress_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    request: Request<Body>,
) -> AppResult<Response<Body>> {
    let user = auth::require_auth(&state.db, &headers).await?;
    match method {
        Method::GET => {
            let progress = state.db.get_user_watch_progress(user.id).await?;
            let entries: Vec<Value> = progress
                .into_iter()
                .map(|(source_identity, resume_seconds, updated_at)| {
                    json!({
                        "sourceIdentity": source_identity,
                        "resumeSeconds": resume_seconds,
                        "updatedAt": updated_at
                    })
                })
                .collect();
            Ok(json_response(json!({ "entries": entries })))
        }
        Method::PUT => {
            let payload = parse_json_body(request).await?;
            let source_identity =
                require_bounded_string_field(&payload, "sourceIdentity", USER_IDENTITY_MAX_BYTES)?;
            let resume_seconds = normalize_resume_seconds_value(payload.get("resumeSeconds"));
            let updated_at = normalize_user_updated_at(payload.get("updatedAt"));
            state
                .db
                .upsert_user_watch_progress(user.id, source_identity, resume_seconds, updated_at)
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        Method::DELETE => {
            let payload = parse_json_body(request).await?;
            let source_identity =
                require_bounded_string_field(&payload, "sourceIdentity", USER_IDENTITY_MAX_BYTES)?;
            let series_id = payload
                .get("seriesId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| extract_series_id_from_source_identity(&source_identity));
            let deleted_at = normalize_user_updated_at(payload.get("updatedAt"));
            if !series_id.is_empty() {
                state
                    .db
                    .delete_user_watch_progress_for_series(user.id, series_id, deleted_at)
                    .await?;
                return Ok(json_response(json!({ "ok": true })));
            }
            state
                .db
                .delete_user_watch_progress(user.id, source_identity, deleted_at)
                .await?;
            Ok(json_response(json!({ "ok": true })))
        }
        _ => Err(ApiError::method_not_allowed(
            "Method not allowed. Use GET, PUT, or DELETE.",
        )),
    }
}

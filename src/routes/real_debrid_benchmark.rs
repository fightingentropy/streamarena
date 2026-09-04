use super::*;

pub(super) async fn provider_benchmark_capability_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> AppResult<Response<Body>> {
    if !provider_benchmark_capability_method_supported(&method) {
        return Err(ApiError::method_not_allowed("Method not allowed. Use GET."));
    }
    let user = auth::require_admin(&state.db, &headers).await?;
    let real_debrid_exact_session_reuse =
        real_debrid_benchmark_exact_reuse_for_request(&headers, &user)?;
    let attestations = if real_debrid_exact_session_reuse {
        let real_debrid_api_key = real_debrid_api_key_for_user(&state, user.id).await?;
        let real_debrid_playback_session_scope_identity = (!real_debrid_api_key.is_empty())
            .then(|| {
                build_real_debrid_cache_scope(
                    user.id,
                    &real_debrid_api_key,
                    config::real_debrid_remote_traffic_enabled(),
                )
            })
            .and_then(|scope| provider_benchmark_real_debrid_scope_identity(&scope));
        let (resolver_cache_identity, users_db_identity, server_instance_identity) =
            provider_benchmark_instance_identities(&state)?;
        Some(ProviderBenchmarkAttestations {
            real_debrid_playback_session_scope_identity,
            resolver_cache_identity,
            users_db_identity,
            server_instance_identity,
            real_debrid_exact_session_reuse,
        })
    } else {
        None
    };
    provider_benchmark_capability_response(&headers, &user, attestations.as_ref())
}

fn provider_benchmark_instance_identities(state: &AppState) -> AppResult<(String, String, String)> {
    let (resolver_cache_file, users_db_file) = state.db.benchmark_database_file_identities()?;
    let resolver_cache_identity =
        provider_benchmark_database_file_identity(&resolver_cache_file, "resolver-cache")?;
    let users_db_identity = provider_benchmark_database_file_identity(&users_db_file, "users")?;
    let server_instance_identity = provider_benchmark_server_instance_identity(
        state.started_at_ms,
        &resolver_cache_identity,
        &users_db_identity,
    );
    Ok((
        resolver_cache_identity,
        users_db_identity,
        server_instance_identity,
    ))
}

pub(super) fn exact_single_query_value(query: &str, key: &str) -> Option<String> {
    let mut values = url::form_urlencoded::parse(query.as_bytes())
        .filter_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()));
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

pub(super) fn benchmark_query_matches_cardinality(
    query: &str,
    required: &[&str],
    optional: &[&str],
) -> bool {
    let allowed = required
        .iter()
        .chain(optional.iter())
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let mut counts = BTreeMap::<String, usize>::new();
    for (key, _) in url::form_urlencoded::parse(query.as_bytes()) {
        if !allowed.contains(key.as_ref()) {
            return false;
        }
        *counts.entry(key.into_owned()).or_default() += 1;
    }
    required
        .iter()
        .all(|key| counts.get(*key).copied() == Some(1))
        && optional
            .iter()
            .all(|key| counts.get(*key).copied().unwrap_or_default() <= 1)
}

pub(super) async fn real_debrid_benchmark_instance_for_request(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<Option<String>> {
    if !headers.contains_key(REAL_DEBRID_BENCHMARK_HEADER_NAME) {
        if headers.contains_key(BENCHMARK_EXPECTED_SERVER_INSTANCE_HEADER) {
            return Err(ApiError::bad_request(
                "Benchmark server binding requires benchmark mode.",
            ));
        }
        return Ok(None);
    }
    let user = auth::require_admin(&state.db, headers).await?;
    if !real_debrid_benchmark_exact_reuse_for_request(headers, &user)? {
        return Err(ApiError::bad_request(
            "Real-Debrid benchmark mode is required.",
        ));
    }
    let (_, _, server_instance_identity) = provider_benchmark_instance_identities(state)?;
    let mut expected_values = headers
        .get_all(BENCHMARK_EXPECTED_SERVER_INSTANCE_HEADER)
        .iter();
    let expected = expected_values
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 43)
        .filter(|value| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
    if expected_values.next().is_some() || expected != Some(server_instance_identity.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "Benchmark server instance changed before the request.",
        ));
    }
    Ok(Some(server_instance_identity))
}

pub(super) fn attach_benchmark_server_instance(
    response: &mut Response<Body>,
    server_instance_identity: Option<&str>,
) -> AppResult<()> {
    if let Some(identity) = server_instance_identity {
        let value = HeaderValue::from_str(identity)
            .map_err(|_| ApiError::internal("Benchmark server identity unavailable."))?;
        response
            .headers_mut()
            .insert(BENCHMARK_SERVER_INSTANCE_HEADER, value);
        apply_private_no_store(response.headers_mut());
    }
    Ok(())
}

pub(super) async fn provider_benchmark_probe_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> AppResult<Response<Body>> {
    let user = auth::require_admin(&state.db, &headers).await?;
    if !real_debrid_benchmark_exact_reuse_for_request(&headers, &user)? {
        return Err(ApiError::bad_request(
            "Real-Debrid benchmark mode is required.",
        ));
    }
    let server_instance_identity = real_debrid_benchmark_instance_for_request(&state, &headers)
        .await?
        .ok_or_else(|| ApiError::bad_request("Real-Debrid benchmark mode is required."))?;
    let run_nonce = exact_single_query_value(uri.query().unwrap_or_default(), "run")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| ApiError::bad_request("A single valid benchmark run is required."))?;
    let status = state
        .media
        .benchmark_media_probe_status(user.id, &run_nonce)
        .ok_or_else(|| ApiError::not_found("Benchmark media-probe run not found."))?;
    Ok(provider_resolve_response(
        json!({
            "probe": status,
            "serverInstanceIdentity": server_instance_identity,
        }),
        false,
    ))
}

pub(super) fn validate_real_debrid_benchmark_resolve_request(
    params: &BTreeMap<String, String>,
    raw_query: &str,
    media_type: &str,
    user_id: i64,
    skip_external_embed: bool,
    refresh_resolve: bool,
) -> AppResult<()> {
    let mut required = vec![
        "tmdbId",
        "title",
        "sourceHash",
        "sessionKey",
        "resolverProvider",
        "skipExternalEmbed",
        "audioLang",
        "quality",
        "subtitleLang",
        REAL_DEBRID_BENCHMARK_QUERY_FLAG,
    ];
    if media_type == "tv" {
        required.extend(["seasonNumber", "episodeNumber"]);
    }
    if !benchmark_query_matches_cardinality(raw_query, &required, &["year"]) {
        return Err(ApiError::bad_request(
            "Real-Debrid benchmark query parameters must be exact and single-valued.",
        ));
    }
    let source_hash = params
        .get("sourceHash")
        .map(|value| value.trim())
        .unwrap_or_default();
    let expected_session_prefix = format!("real-debrid:user:{}:", user_id.max(0));
    let session_key = params
        .get("sessionKey")
        .map(|value| value.trim())
        .unwrap_or_default();
    let exact_request = params
        .get("resolverProvider")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("real-debrid"))
        && skip_external_embed
        && !refresh_resolve
        && !truthy_query_flag(params, "async")
        && params
            .get(REAL_DEBRID_BENCHMARK_QUERY_FLAG)
            .is_some_and(|value| value.trim() == "1")
        && source_hash.len() == 40
        && source_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        && session_key.starts_with(&expected_session_prefix)
        && params
            .get("subtitleLang")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("off"));
    if exact_request {
        return Ok(());
    }
    Err(ApiError::bad_request(
        "Real-Debrid benchmark requests must pin one exact playback session.",
    ))
}

pub(super) fn playback_intent_requested(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(PLAYBACK_INTENT_HEADER).iter();
    matches!(values.next(), Some(value) if value.as_bytes() == b"1") && values.next().is_none()
}

fn real_debrid_remux_input_for_prewarm(payload: &Value) -> Option<String> {
    if payload.get("resolverProvider").and_then(Value::as_str) != Some("real-debrid")
        || payload
            .get("metadata")
            .and_then(|metadata| metadata.get("resolverProvider"))
            .and_then(Value::as_str)
            != Some("real-debrid")
    {
        return None;
    }
    let playable_url = payload.get("playableUrl")?.as_str()?.trim();
    if !playable_url.starts_with('/') {
        return None;
    }
    let url = Url::parse(&format!("http://localhost{playable_url}")).ok()?;
    if url.path() != "/api/remux" || url.fragment().is_some() {
        return None;
    }
    let mut inputs = url
        .query_pairs()
        .filter_map(|(key, value)| (key == "input").then(|| value.into_owned()));
    let input = inputs.next()?.trim().to_owned();
    if input.is_empty() || inputs.next().is_some() {
        return None;
    }
    let source_input = payload.get("sourceInput")?.as_str()?.trim();
    if source_input != input {
        return None;
    }
    Some(input)
}

pub(super) fn prewarm_real_debrid_playback(
    media: &MediaService,
    playback_intent: bool,
    payload: &Value,
) -> bool {
    playback_intent
        && real_debrid_remux_input_for_prewarm(payload)
            .is_some_and(|input| media.prewarm_media_probe(&input))
}

pub(super) async fn prepare_real_debrid_benchmark_probe(
    state: &AppState,
    user_id: i64,
    payload: &mut Value,
) -> AppResult<()> {
    let input = real_debrid_remux_input_for_prewarm(payload).ok_or_else(|| {
        ApiError::failed_dependency("The exact benchmark media probe is unavailable.")
    })?;
    let (_, _, server_instance_identity) = provider_benchmark_instance_identities(state)?;
    let start = state
        .media
        .start_benchmark_media_probe(user_id, &input)
        .await?;
    payload["benchmarkProbeRun"] = json!({
        "runNonce": start.run_nonce,
        "probeKeyIdentity": start.probe_key_identity,
        "serverInstanceIdentity": server_instance_identity,
        "scheduled": true,
    });
    Ok(())
}

fn finalize_real_debrid_benchmark_response(
    response: &mut Response<Body>,
    exact_reuse: bool,
    resolver_elapsed: Duration,
) {
    acknowledge_real_debrid_exact_reuse(response, exact_reuse);
    if exact_reuse {
        let timing = format!(
            "resolve-response;dur={:.3}",
            resolver_elapsed.as_secs_f64() * 1_000.0
        );
        if let Ok(value) = HeaderValue::from_str(&timing) {
            response.headers_mut().insert("server-timing", value);
        }
    }
}

pub(super) fn provider_resolve_result_with_benchmark_headers(
    result: AppResult<Value>,
    record_external_health_events: bool,
    exact_reuse: bool,
    resolver_elapsed: Duration,
) -> AppResult<Response<Body>> {
    let mut response = provider_resolve_result(result, record_external_health_events)?;
    finalize_real_debrid_benchmark_response(&mut response, exact_reuse, resolver_elapsed);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_debrid_benchmark_route_requires_an_exact_safe_session_request() {
        let valid = query_pairs(
            "tmdbId=27205&title=Inception&sourceHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&sessionKey=real-debrid%3Auser%3A7%3A27205%3Aauto%3A1080p&resolverProvider=real-debrid&skipExternalEmbed=1&audioLang=auto&quality=1080p&subtitleLang=off&benchmarkExactSession=1",
        );
        let valid_query = "tmdbId=27205&title=Inception&sourceHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&sessionKey=real-debrid%3Auser%3A7%3A27205%3Aauto%3A1080p&resolverProvider=real-debrid&skipExternalEmbed=1&audioLang=auto&quality=1080p&subtitleLang=off&benchmarkExactSession=1";
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &valid,
                valid_query,
                "movie",
                7,
                true,
                false,
            )
            .is_ok()
        );
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &valid,
                valid_query,
                "movie",
                8,
                true,
                false,
            )
            .is_err()
        );
        let mut missing_marker = valid.clone();
        missing_marker.remove(REAL_DEBRID_BENCHMARK_QUERY_FLAG);
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &missing_marker,
                valid_query,
                "movie",
                7,
                true,
                false,
            )
            .is_err()
        );
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &valid,
                valid_query,
                "movie",
                7,
                true,
                true,
            )
            .is_err()
        );
        let mut async_request = valid.clone();
        async_request.insert("async".to_owned(), "1".to_owned());
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &async_request,
                valid_query,
                "movie",
                7,
                true,
                false,
            )
            .is_err()
        );
        assert!(
            validate_real_debrid_benchmark_resolve_request(
                &valid,
                &format!("{valid_query}&sourceHash={}", "b".repeat(40)),
                "movie",
                7,
                true,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn benchmark_status_query_requires_one_exact_run_value() {
        assert_eq!(
            exact_single_query_value("run=abc", "run").as_deref(),
            Some("abc")
        );
        assert!(exact_single_query_value("run=abc&run=def", "run").is_none());
        assert!(exact_single_query_value("other=abc", "run").is_none());
    }

    #[test]
    fn benchmark_query_cardinality_rejects_duplicates_and_unknown_keys() {
        assert!(benchmark_query_matches_cardinality(
            "input=one&subtitleStream=-1",
            &["input"],
            &["subtitleStream"]
        ));
        assert!(!benchmark_query_matches_cardinality(
            "input=one&input=two",
            &["input"],
            &[]
        ));
        assert!(!benchmark_query_matches_cardinality(
            "input=one&unexpected=1",
            &["input"],
            &[]
        ));
    }

    #[test]
    fn playback_intent_header_is_exact_and_single_valued() {
        let mut headers = HeaderMap::new();
        assert!(!playback_intent_requested(&headers));
        headers.insert(PLAYBACK_INTENT_HEADER, HeaderValue::from_static("1"));
        assert!(playback_intent_requested(&headers));
        headers.append(PLAYBACK_INTENT_HEADER, HeaderValue::from_static("1"));
        assert!(!playback_intent_requested(&headers));
        headers.remove(PLAYBACK_INTENT_HEADER);
        headers.insert(PLAYBACK_INTENT_HEADER, HeaderValue::from_static("true"));
        assert!(!playback_intent_requested(&headers));
    }

    #[test]
    fn exact_benchmark_response_attests_enforcement_and_resolver_timing() {
        let mut exact = json_response(json!({ "ok": true }));
        finalize_real_debrid_benchmark_response(&mut exact, true, Duration::from_micros(12_345));
        assert_eq!(
            exact
                .headers()
                .get("x-streamarena-real-debrid-exact-reuse")
                .and_then(|value| value.to_str().ok()),
            Some("enforced")
        );
        assert_eq!(
            exact
                .headers()
                .get("server-timing")
                .and_then(|value| value.to_str().ok()),
            Some("resolve-response;dur=12.345")
        );
        let mut ordinary = json_response(json!({ "ok": true }));
        finalize_real_debrid_benchmark_response(&mut ordinary, false, Duration::ZERO);
        assert!(!ordinary.headers().contains_key("server-timing"));
    }

    #[test]
    fn prewarm_input_requires_an_exact_real_debrid_remux_payload() {
        let input = "https://example.download.real-debrid.com/d/stream.mkv";
        let valid = json!({
            "resolverProvider": "real-debrid",
            "metadata": { "resolverProvider": "real-debrid" },
            "playableUrl": format!(
                "/api/remux?input={}",
                url::form_urlencoded::byte_serialize(input.as_bytes()).collect::<String>()
            ),
            "sourceInput": input,
        });
        assert_eq!(
            real_debrid_remux_input_for_prewarm(&valid).as_deref(),
            Some(input)
        );
        for invalid in [
            json!({
                "resolverProvider": "external",
                "metadata": { "resolverProvider": "external" },
                "playableUrl": valid["playableUrl"],
                "sourceInput": input,
            }),
            json!({
                "resolverProvider": "real-debrid",
                "metadata": { "resolverProvider": "real-debrid" },
                "playableUrl": input,
                "sourceInput": input,
            }),
            json!({
                "resolverProvider": "real-debrid",
                "metadata": { "resolverProvider": "real-debrid" },
                "playableUrl": format!("{}&input=duplicate", valid["playableUrl"].as_str().unwrap()),
                "sourceInput": input,
            }),
            json!({
                "resolverProvider": "real-debrid",
                "metadata": { "resolverProvider": "real-debrid" },
                "playableUrl": valid["playableUrl"],
                "sourceInput": "https://example.invalid/other.mkv",
            }),
        ] {
            assert!(real_debrid_remux_input_for_prewarm(&invalid).is_none());
        }
    }
}

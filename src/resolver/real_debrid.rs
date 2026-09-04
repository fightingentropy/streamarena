use super::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

type HmacSha256 = Hmac<Sha256>;

const RD_VALIDATION_USER_MAX_ATTEMPTS: usize = 5;
const RD_VALIDATION_IP_MAX_ATTEMPTS: usize = 20;
const RD_VALIDATION_WINDOW_MS: i64 = 15 * 60 * 1000;
const RD_VALIDATION_MAX_CONCURRENT: usize = 2;
const RD_VALIDATION_QUEUE_TIMEOUT_MS: u64 = 2_000;
const RD_VALIDATION_SUCCESS_TTL_MS: i64 = 5 * 60 * 1000;
const RD_LAZY_HLS_TICKET_TTL_SECONDS: i64 = 10 * 60;
const RD_LAZY_HLS_TICKET_MAX_FUTURE_SECONDS: i64 = RD_LAZY_HLS_TICKET_TTL_SECONDS + 5;
const RD_LAZY_HLS_SIGNATURE_CONTEXT: &[u8] = b"streamarena-rd-lazy-hls-v1";
const RD_LAZY_HLS_TICKET_PREFIX: &str = "streamarena-rd-hls-v1.";
const RD_LAZY_HLS_CACHE_MAX_ENTRIES: usize = 512;
const RD_LAZY_HLS_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const RD_LAZY_HLS_FAILURE_TTL_MS: i64 = 5 * 1000;
const RD_LAZY_HLS_MAX_CONCURRENT: usize = 4;
const RD_LAZY_HLS_USER_MAX_ATTEMPTS: usize = 30;
const RD_LAZY_HLS_USER_WINDOW_MS: i64 = 60 * 1000;

#[derive(Clone)]
pub(super) struct RealDebridRequestContext {
    pub(super) api_key: String,
    pub(super) cache_scope: String,
    user_id: i64,
    credential_binding: [u8; 32],
    remote_traffic: bool,
}

#[derive(Clone)]
pub(super) struct RealDebridLazyHlsControl {
    entries: Arc<DashMap<String, CachedRealDebridLazyHls>>,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    permits: Arc<Semaphore>,
    user_rate_limiter: Arc<RateLimiter>,
}

#[derive(Clone)]
struct CachedRealDebridLazyHls {
    upstream_url: Option<String>,
    expires_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AuthorizedRealDebridLazyHlsTicket {
    pub(super) download_id: String,
    pub(super) expires_at: i64,
}

#[derive(Clone)]
pub(super) struct RealDebridValidationControl {
    user_rate_limiter: Arc<RateLimiter>,
    ip_rate_limiter: Arc<RateLimiter>,
    permits: Arc<Semaphore>,
    successful_tokens: Arc<DashMap<String, i64>>,
    token_locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    queue_timeout: Duration,
    success_ttl_ms: i64,
}

pub(super) struct OwnedRealDebridTorrentLease {
    torrent_id: String,
    decision_tx: Option<oneshot::Sender<OwnedTorrentDecision>>,
}

pub(super) struct RealDebridResolvedStream {
    pub(super) resolved: ResolvedSource,
    pub(super) owned_torrent: Option<OwnedRealDebridTorrentLease>,
}

enum OwnedTorrentDecision {
    Commit,
    Cleanup(oneshot::Sender<()>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RealDebridTorrentOwnership {
    ReusedFromAccount,
    CreatedByRequest,
}

impl RealDebridTorrentOwnership {
    pub(super) fn may_change_file_selection(self) -> bool {
        self == Self::CreatedByRequest
    }
}

impl RealDebridValidationControl {
    pub(super) fn new() -> Self {
        Self {
            user_rate_limiter: Arc::new(RateLimiter::new(
                RD_VALIDATION_USER_MAX_ATTEMPTS,
                RD_VALIDATION_WINDOW_MS,
            )),
            ip_rate_limiter: Arc::new(RateLimiter::new(
                RD_VALIDATION_IP_MAX_ATTEMPTS,
                RD_VALIDATION_WINDOW_MS,
            )),
            permits: Arc::new(Semaphore::new(RD_VALIDATION_MAX_CONCURRENT)),
            successful_tokens: Arc::new(DashMap::new()),
            token_locks: Arc::new(DashMap::new()),
            queue_timeout: Duration::from_millis(RD_VALIDATION_QUEUE_TIMEOUT_MS),
            success_ttl_ms: RD_VALIDATION_SUCCESS_TTL_MS,
        }
    }

    #[cfg(test)]
    pub(super) fn with_limits(
        user_max_attempts: usize,
        ip_max_attempts: usize,
        max_concurrent: usize,
    ) -> Self {
        Self {
            user_rate_limiter: Arc::new(RateLimiter::new(user_max_attempts, 60_000)),
            ip_rate_limiter: Arc::new(RateLimiter::new(ip_max_attempts, 60_000)),
            permits: Arc::new(Semaphore::new(max_concurrent.max(1))),
            successful_tokens: Arc::new(DashMap::new()),
            token_locks: Arc::new(DashMap::new()),
            queue_timeout: Duration::from_secs(1),
            success_ttl_ms: 60_000,
        }
    }

    pub(super) async fn validate<F, Fut>(
        &self,
        user_id: i64,
        client_ip: &str,
        api_key: &str,
        validate: F,
    ) -> AppResult<()>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let token_fingerprint = real_debrid_token_fingerprint(api_key);
        if self.has_recent_success(&token_fingerprint) {
            return Ok(());
        }

        let user_key = format!("real-debrid-validation:user:{}", user_id.max(0));
        let normalized_ip = client_ip
            .trim()
            .chars()
            .take(128)
            .collect::<String>()
            .to_ascii_lowercase();
        let ip_key = format!(
            "real-debrid-validation:ip:{}",
            if normalized_ip.is_empty() {
                "unknown"
            } else {
                normalized_ip.as_str()
            }
        );
        if !self.user_rate_limiter.check_and_record(&user_key)
            || !self.ip_rate_limiter.check_and_record(&ip_key)
        {
            return Err(ApiError::too_many_requests(
                "Too many Real-Debrid token checks. Try again later.",
            ));
        }

        let token_lock = self
            .token_locks
            .entry(token_fingerprint.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _token_guard = token_lock.lock().await;
        if self.has_recent_success(&token_fingerprint) {
            return Ok(());
        }

        let _permit = match timeout(self.queue_timeout, self.permits.acquire()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => {
                return Err(ApiError::service_unavailable(
                    "Real-Debrid token validation is temporarily unavailable.",
                ));
            }
            Err(_) => {
                return Err(ApiError::too_many_requests(
                    "Real-Debrid token validation is busy. Try again shortly.",
                ));
            }
        };

        validate().await?;
        self.successful_tokens.insert(
            token_fingerprint,
            now_ms().saturating_add(self.success_ttl_ms),
        );
        Ok(())
    }

    pub(super) fn prune(&self) {
        let now = now_ms();
        self.successful_tokens
            .retain(|_, expires_at| *expires_at > now);
        self.token_locks
            .retain(|_, lock| Arc::strong_count(lock) > 1);
        self.user_rate_limiter.prune();
        self.ip_rate_limiter.prune();
    }

    fn has_recent_success(&self, token_fingerprint: &str) -> bool {
        self.successful_tokens
            .get(token_fingerprint)
            .is_some_and(|expires_at| *expires_at > now_ms())
    }
}

impl RealDebridLazyHlsControl {
    pub(super) fn new() -> Self {
        Self {
            entries: Arc::new(DashMap::new()),
            locks: Arc::new(DashMap::new()),
            permits: Arc::new(Semaphore::new(RD_LAZY_HLS_MAX_CONCURRENT)),
            user_rate_limiter: Arc::new(RateLimiter::new(
                RD_LAZY_HLS_USER_MAX_ATTEMPTS,
                RD_LAZY_HLS_USER_WINDOW_MS,
            )),
        }
    }

    pub(super) fn prune(&self) {
        let now = now_ms();
        self.entries.retain(|_, entry| entry.expires_at_ms > now);
        self.locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        self.user_rate_limiter.prune();
        while self.entries.len() > RD_LAZY_HLS_CACHE_MAX_ENTRIES {
            self.evict_earliest_expiring_entry();
        }
    }

    fn fresh(&self, key: &str) -> Option<Option<String>> {
        self.entries
            .get(key)
            .filter(|entry| entry.expires_at_ms > now_ms())
            .map(|entry| entry.upstream_url.clone())
    }

    fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        if self.locks.len() >= RD_LAZY_HLS_CACHE_MAX_ENTRIES {
            self.locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        self.locks
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn store(&self, key: String, upstream_url: Option<String>, expires_at_ms: i64) {
        if self.entries.len() >= RD_LAZY_HLS_CACHE_MAX_ENTRIES {
            let now = now_ms();
            self.entries.retain(|_, entry| entry.expires_at_ms > now);
            while self.entries.len() >= RD_LAZY_HLS_CACHE_MAX_ENTRIES {
                self.evict_earliest_expiring_entry();
            }
        }
        self.entries.insert(
            key,
            CachedRealDebridLazyHls {
                upstream_url,
                expires_at_ms,
            },
        );
    }

    fn evict_earliest_expiring_entry(&self) {
        let earliest_key = self
            .entries
            .iter()
            .min_by_key(|entry| entry.expires_at_ms)
            .map(|entry| entry.key().clone());
        if let Some(key) = earliest_key {
            self.entries.remove(&key);
        }
    }

    fn try_acquire_provider_permit(&self) -> AppResult<OwnedSemaphorePermit> {
        self.permits.clone().try_acquire_owned().map_err(|_| {
            ApiError::too_many_requests("Real-Debrid HLS fallback is busy. Try again shortly.")
        })
    }

    fn check_user_provider_budget(&self, user_id: i64) -> AppResult<()> {
        let key = format!("real-debrid-lazy-hls:user:{}", user_id.max(0));
        self.user_rate_limiter
            .check_and_record(&key)
            .then_some(())
            .ok_or_else(|| {
                ApiError::too_many_requests(
                    "Too many Real-Debrid HLS fallback requests. Try again later.",
                )
            })
    }

    async fn resolve<F, Fut>(
        &self,
        cache_key: &str,
        user_id: i64,
        success_expires_at_ms: i64,
        fetch: F,
    ) -> AppResult<Option<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Option<String>>,
    {
        if let Some(cached) = self.fresh(cache_key) {
            return Ok(cached);
        }

        // Lock before taking a global provider permit: retries for the same
        // ticket wait for the first request and then reuse its cache entry
        // without consuming the limited slots for distinct provider calls.
        let flight = self.lock(cache_key);
        let _guard = flight.lock().await;
        if let Some(cached) = self.fresh(cache_key) {
            return Ok(cached);
        }

        let _provider_permit = self.try_acquire_provider_permit()?;
        self.check_user_provider_budget(user_id)?;
        let upstream_url = fetch().await;
        let now = now_ms();
        let expires_at_ms = if upstream_url.is_some() {
            success_expires_at_ms.min(now.saturating_add(RD_LAZY_HLS_CACHE_TTL_MS))
        } else {
            now.saturating_add(RD_LAZY_HLS_FAILURE_TTL_MS)
        };
        self.store(cache_key.to_owned(), upstream_url.clone(), expires_at_ms);
        Ok(upstream_url)
    }
}

impl OwnedRealDebridTorrentLease {
    pub(super) fn torrent_id(&self) -> &str {
        &self.torrent_id
    }

    pub(super) fn commit(mut self) {
        if let Some(decision_tx) = self.decision_tx.take() {
            let _ = decision_tx.send(OwnedTorrentDecision::Commit);
        }
    }

    pub(super) async fn cleanup(mut self) {
        let Some(decision_tx) = self.decision_tx.take() else {
            return;
        };
        let (cleanup_complete_tx, cleanup_complete_rx) = oneshot::channel();
        if decision_tx
            .send(OwnedTorrentDecision::Cleanup(cleanup_complete_tx))
            .is_ok()
        {
            let _ = cleanup_complete_rx.await;
        }
    }
}

/// Run the externally mutating `addMagnet` call in a task that owns cleanup.
///
/// If the request future is canceled before the provider response arrives, the
/// result receiver and decision sender are dropped. The owned task still waits
/// for the response and deletes any accepted torrent before it exits. Once the
/// caller has a lease, dropping it has the same cleanup behavior. Explicit
/// cleanup is acknowledged only after the delete attempt completes, preserving
/// delete-before-retry ordering.
pub(super) async fn acquire_owned_real_debrid_torrent_lease<AddFut, Cleanup, CleanupFut>(
    add_future: AddFut,
    cleanup: Cleanup,
) -> AppResult<OwnedRealDebridTorrentLease>
where
    AddFut: Future<Output = AppResult<String>> + Send + 'static,
    Cleanup: FnOnce(String) -> CleanupFut + Send + 'static,
    CleanupFut: Future<Output = ()> + Send + 'static,
{
    let (result_tx, result_rx) = oneshot::channel();
    let (decision_tx, decision_rx) = oneshot::channel();
    tokio::spawn(async move {
        let torrent_id = match add_future.await {
            Ok(torrent_id) => torrent_id,
            Err(error) => {
                let _ = result_tx.send(Err(error));
                return;
            }
        };
        if result_tx.send(Ok(torrent_id.clone())).is_err() {
            cleanup(torrent_id).await;
            return;
        }
        match decision_rx.await {
            Ok(OwnedTorrentDecision::Commit) => {}
            Ok(OwnedTorrentDecision::Cleanup(cleanup_complete_tx)) => {
                cleanup(torrent_id).await;
                let _ = cleanup_complete_tx.send(());
            }
            Err(_) => cleanup(torrent_id).await,
        }
    });

    let torrent_id = result_rx
        .await
        .map_err(|_| ApiError::internal("Real-Debrid add task stopped unexpectedly."))??;
    Ok(OwnedRealDebridTorrentLease {
        torrent_id,
        decision_tx: Some(decision_tx),
    })
}

/// Retain ownership while the provider finishes validation, response building,
/// and session persistence. Commit only after that work succeeds and directly
/// before returning the ready payload to the provider race.
pub(super) async fn complete_real_debrid_attempt_with_lease<T, Fut>(
    owned_torrent: Option<OwnedRealDebridTorrentLease>,
    completion: Fut,
) -> AppResult<T>
where
    Fut: Future<Output = AppResult<T>>,
{
    let completed = completion.await?;
    if let Some(owned_torrent) = owned_torrent {
        owned_torrent.commit();
    }
    Ok(completed)
}

impl RealDebridRequestContext {
    pub(super) fn for_user(user_id: i64, api_key: &str) -> Option<Self> {
        Self::for_user_with_delivery(
            user_id,
            api_key,
            crate::config::real_debrid_remote_traffic_enabled(),
        )
    }

    pub(super) fn for_user_with_delivery(
        user_id: i64,
        api_key: &str,
        remote_traffic: bool,
    ) -> Option<Self> {
        let normalized_api_key = api_key.trim();
        if normalized_api_key.is_empty() {
            return None;
        }
        let user_id = user_id.max(0);
        let credential_binding = Sha256::digest(normalized_api_key.as_bytes()).into();
        Some(Self {
            api_key: normalized_api_key.to_owned(),
            cache_scope: build_real_debrid_cache_scope(user_id, normalized_api_key, remote_traffic),
            user_id,
            credential_binding,
            remote_traffic,
        })
    }
}

fn real_debrid_token_fingerprint(api_key: &str) -> String {
    let digest = Sha256::digest(api_key.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn build_real_debrid_cache_scope(
    user_id: i64,
    api_key: &str,
    remote_traffic: bool,
) -> String {
    let delivery = real_debrid_delivery_scope(remote_traffic);
    format!(
        "user:{}:credential:{}:delivery:{delivery}",
        user_id.max(0),
        real_debrid_token_fingerprint(api_key.trim())
    )
}

fn real_debrid_delivery_scope(remote_traffic: bool) -> &'static str {
    if remote_traffic {
        "remote-hls-v1"
    } else {
        "direct-v1"
    }
}

pub(super) fn build_rd_torrent_cache_key(info_hash: &str) -> String {
    format!("rd-torrent:{}", normalize_source_hash(info_hash))
}

pub(super) fn build_scoped_rd_torrent_cache_key(cache_scope: &str, info_hash: &str) -> String {
    let normalized_hash = normalize_source_hash(info_hash);
    let normalized_scope = cache_scope.trim();
    if normalized_scope.is_empty() {
        build_rd_torrent_cache_key(&normalized_hash)
    } else {
        format!("rd-torrent:{normalized_scope}:{normalized_hash}")
    }
}

pub(super) fn build_real_debrid_unrestrict_form(
    rd_link: &str,
    remote_traffic: bool,
) -> Vec<(&str, &str)> {
    let mut form = vec![("link", rd_link)];
    if remote_traffic {
        form.push(("remote", "1"));
    }
    form
}

fn valid_real_debrid_download_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn sign_real_debrid_lazy_hls_ticket(
    download_id: &str,
    expires_at: i64,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(RD_LAZY_HLS_SIGNATURE_CONTEXT);
    mac.update(b"\0");
    mac.update(download_id.as_bytes());
    mac.update(b"\0");
    mac.update(expires_at.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(real_debrid.user_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(&real_debrid.credential_binding);
    mac.update(b"\0");
    mac.update(real_debrid_delivery_scope(real_debrid.remote_traffic).as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn verify_real_debrid_lazy_hls_ticket_signature(
    download_id: &str,
    expires_at: i64,
    signature: &str,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
) -> bool {
    if secret.is_empty()
        || signature.len() != 43
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    if signature_bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&signature_bytes) != signature {
        return false;
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(RD_LAZY_HLS_SIGNATURE_CONTEXT);
    mac.update(b"\0");
    mac.update(download_id.as_bytes());
    mac.update(b"\0");
    mac.update(expires_at.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(real_debrid.user_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(&real_debrid.credential_binding);
    mac.update(b"\0");
    mac.update(real_debrid_delivery_scope(real_debrid.remote_traffic).as_bytes());
    mac.verify_slice(&signature_bytes).is_ok()
}

fn parse_real_debrid_lazy_hls_ticket(input: &str) -> Option<(&str, i64, &str)> {
    let payload = input.strip_prefix(RD_LAZY_HLS_TICKET_PREFIX)?;
    let mut pieces = payload.split('.');
    let download_id = pieces.next()?;
    let expiry = pieces.next()?;
    let signature = pieces.next()?;
    if pieces.next().is_some()
        || !valid_real_debrid_download_id(download_id)
        || expiry.is_empty()
        || expiry.len() > 19
        || expiry.len() > 1 && expiry.starts_with('0')
        || !expiry.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((download_id, expiry.parse::<i64>().ok()?, signature))
}

pub(super) fn authorize_real_debrid_lazy_hls_ticket(
    input: &str,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
    now_seconds: i64,
) -> Option<AuthorizedRealDebridLazyHlsTicket> {
    if !real_debrid.remote_traffic || secret.trim().is_empty() {
        return None;
    }
    let (download_id, expires_at, signature) = parse_real_debrid_lazy_hls_ticket(input)?;
    if expires_at <= now_seconds
        || expires_at > now_seconds.saturating_add(RD_LAZY_HLS_TICKET_MAX_FUTURE_SECONDS)
        || !verify_real_debrid_lazy_hls_ticket_signature(
            download_id,
            expires_at,
            signature,
            real_debrid,
            secret,
        )
    {
        return None;
    }
    Some(AuthorizedRealDebridLazyHlsTicket {
        download_id: download_id.to_owned(),
        expires_at,
    })
}

pub(super) fn build_real_debrid_lazy_hls_playback_source_at(
    download_id: &str,
    streamable: bool,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
    now_seconds: i64,
) -> Option<String> {
    if !streamable
        || !real_debrid.remote_traffic
        || !valid_real_debrid_download_id(download_id)
        || secret.trim().is_empty()
    {
        return None;
    }
    let expires_at = now_seconds.saturating_add(RD_LAZY_HLS_TICKET_TTL_SECONDS);
    let signature = sign_real_debrid_lazy_hls_ticket(download_id, expires_at, real_debrid, secret);
    let ticket = format!("{RD_LAZY_HLS_TICKET_PREFIX}{download_id}.{expires_at}.{signature}");
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("input", &ticket);
    Some(format!("/api/hls/master.m3u8?{}", serializer.finish()))
}

fn build_real_debrid_lazy_hls_playback_source(
    download_id: &str,
    streamable: bool,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
) -> Option<String> {
    build_real_debrid_lazy_hls_playback_source_at(
        download_id,
        streamable,
        real_debrid,
        secret,
        now_ms().div_euclid(1_000),
    )
}

pub(crate) fn is_real_debrid_lazy_hls_input(input: &str) -> bool {
    input.starts_with(RD_LAZY_HLS_TICKET_PREFIX)
}

pub(super) fn parse_strict_real_debrid_lazy_hls_query(query: &str) -> Option<String> {
    let mut pairs = url::form_urlencoded::parse(query.as_bytes());
    let (key, value) = pairs.next()?;
    if key != "input" || pairs.next().is_some() {
        return None;
    }
    let value = value.into_owned();
    is_real_debrid_lazy_hls_input(&value).then_some(value)
}

fn real_debrid_lazy_hls_cache_key(
    download_id: &str,
    real_debrid: &RealDebridRequestContext,
) -> String {
    let mut digest = Sha256::new();
    digest.update(RD_LAZY_HLS_SIGNATURE_CONTEXT);
    digest.update(b"\0cache\0");
    digest.update(download_id.as_bytes());
    digest.update(b"\0");
    digest.update(real_debrid.user_id.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(real_debrid.credential_binding);
    digest.update(b"\0");
    digest.update(real_debrid_delivery_scope(real_debrid.remote_traffic).as_bytes());
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn refresh_real_debrid_lazy_hls_playback_source(
    value: &str,
    real_debrid: &RealDebridRequestContext,
    secret: &str,
) -> Option<String> {
    let url = Url::parse(value)
        .or_else(|_| Url::parse(&format!("http://localhost{value}")))
        .ok()?;
    if url.path() != "/api/hls/master.m3u8" {
        return None;
    }
    let query = url.query()?;
    let input = parse_strict_real_debrid_lazy_hls_query(query)?;
    let (download_id, expires_at, signature) = parse_real_debrid_lazy_hls_ticket(&input)?;
    if !real_debrid.remote_traffic
        || !verify_real_debrid_lazy_hls_ticket_signature(
            download_id,
            expires_at,
            signature,
            real_debrid,
            secret,
        )
    {
        return None;
    }
    build_real_debrid_lazy_hls_playback_source(download_id, true, real_debrid, secret)
}

pub(super) fn refresh_real_debrid_lazy_hls_fallbacks(
    source: &ResolvedSource,
    real_debrid: Option<&RealDebridRequestContext>,
    secret: &str,
) -> ResolvedSource {
    let Some(real_debrid) = real_debrid else {
        return source.clone();
    };
    let mut refreshed = source.clone();
    if let Some(next) =
        refresh_real_debrid_lazy_hls_playback_source(&refreshed.playable_url, real_debrid, secret)
    {
        refreshed.playable_url = next;
    }
    refreshed.fallback_urls = refreshed
        .fallback_urls
        .iter()
        .map(|value| {
            refresh_real_debrid_lazy_hls_playback_source(value, real_debrid, secret)
                .unwrap_or_else(|| value.clone())
        })
        .collect();
    refreshed
}

pub(super) fn is_real_debrid_transcode_hls_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return false;
    };
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    url.scheme() == "https"
        && (host == "stream.real-debrid.com" || host.ends_with(".stream.real-debrid.com"))
        && url.path().to_ascii_lowercase().ends_with(".m3u8")
}

pub(super) fn real_debrid_apple_transcode_url(payload: &Value) -> Option<String> {
    let url = stringify_json(payload.get("apple").and_then(|value| value.get("full")));
    is_real_debrid_transcode_hls_url(&url).then_some(url)
}

fn build_real_debrid_private_hls_relay(
    upstream_url: &str,
    live_hls_proxy_secret: &str,
    session_token: &str,
) -> AppResult<String> {
    if session_token.trim().is_empty() {
        return Err(ApiError::unauthorized("Not authenticated."));
    }
    crate::live::build_private_real_debrid_hls_playback_source(
        upstream_url,
        live_hls_proxy_secret,
        session_token,
    )
    .ok_or_else(|| {
        ApiError::service_unavailable("Real-Debrid HLS fallback signing is unavailable.")
    })
}

fn real_debrid_playback_url_priority(value: &str) -> u8 {
    if is_real_debrid_transcode_hls_url(value) {
        2
    } else if value.contains("download.real-debrid.com") {
        1
    } else {
        0
    }
}

pub(super) fn validate_real_debrid_user_payload(payload: &Value) -> AppResult<()> {
    let has_account_id = payload.get("id").is_some_and(|value| {
        value.as_i64().is_some() || value.as_str().is_some_and(|id| !id.is_empty())
    });
    if !has_account_id {
        return Err(ApiError::bad_gateway(
            "Real-Debrid returned an invalid account response.",
        ));
    }
    let account_type = stringify_json(payload.get("type")).to_ascii_lowercase();
    if account_type != "premium" {
        return Err(ApiError::failed_dependency(
            "An active Real-Debrid Premium account is required for cached streaming.",
        ));
    }
    Ok(())
}

pub(super) fn parse_ready_real_debrid_hashes(payload: &Value) -> HashSet<String> {
    if let Some(hashes) = payload.get("hashes").and_then(Value::as_array) {
        return hashes
            .iter()
            .filter_map(Value::as_str)
            .map(normalize_source_hash)
            .filter(|hash| !hash.is_empty())
            .collect();
    }
    parse_ready_real_debrid_torrents(payload)
        .into_keys()
        .collect()
}

pub(super) fn parse_ready_real_debrid_torrents(payload: &Value) -> HashMap<String, String> {
    if let Some(torrents) = payload.get("torrents").and_then(Value::as_object) {
        return torrents
            .iter()
            .filter_map(|(hash, torrent_id)| {
                let hash = normalize_source_hash(hash);
                let torrent_id = torrent_id.as_str().unwrap_or_default().trim().to_owned();
                (!hash.is_empty() && !torrent_id.is_empty()).then_some((hash, torrent_id))
            })
            .collect();
    }
    payload
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| stringify_json(item.get("status")).eq_ignore_ascii_case("downloaded"))
        .filter_map(|item| {
            let hash = normalize_source_hash(&stringify_json(item.get("hash")));
            let torrent_id = stringify_json(item.get("id"));
            (!hash.is_empty() && !torrent_id.is_empty()).then_some((hash, torrent_id))
        })
        .collect()
}

pub(super) fn user_facing_real_debrid_error(message: &str) -> String {
    match message.trim().to_ascii_lowercase().as_str() {
        "infringing_file" => "Real-Debrid blocked this source.".to_owned(),
        "too_many_requests" => {
            "Real-Debrid is rate limiting requests. Try again shortly.".to_owned()
        }
        "bad_token" | "bad token" => "Real-Debrid rejected this API token.".to_owned(),
        "permission_denied" | "permission denied" => {
            "Real-Debrid denied access. Check that the account is active and premium.".to_owned()
        }
        "" => "Real-Debrid request failed.".to_owned(),
        _ => "Real-Debrid request failed.".to_owned(),
    }
}

pub(super) fn real_debrid_api_key_required_error() -> ApiError {
    ApiError::failed_dependency(
        "Enable Real-Debrid and add an API token in Settings to use cached streaming.",
    )
}
pub(super) fn is_real_debrid_blocked_source_message(message: &str) -> bool {
    message.trim() == "Real-Debrid blocked this source."
}
pub(crate) fn pick_video_file_ids(
    files: &[Value],
    preferred_filename: &str,
    fallback_name: &str,
) -> Vec<i64> {
    let list = files
        .iter()
        .filter_map(|file| {
            let id = file.get("id").and_then(Value::as_i64)?;
            let path = stringify_json(file.get("path"));
            let bytes = file
                .get("bytes")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            Some((id, path, bytes))
        })
        .collect::<Vec<_>>();
    if list.is_empty() {
        return Vec::new();
    }
    let video_files = list
        .iter()
        .filter(|(_, path, _)| is_supported_resolved_container_path(path))
        .cloned()
        .collect::<Vec<_>>();
    if video_files.is_empty() {
        return Vec::new();
    }
    let preferred_needle = preferred_filename.trim().to_lowercase();
    if !preferred_needle.is_empty()
        && let Some((id, _, _)) = video_files
            .iter()
            .find(|(_, path, _)| path.to_lowercase().contains(&preferred_needle))
    {
        return vec![*id];
    }

    let fallback_episode_signatures = collect_episode_signatures(fallback_name, None);
    let fallback_season_hint = fallback_episode_signatures
        .first()
        .and_then(|signature| signature.split('x').next())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    if !fallback_episode_signatures.is_empty()
        && let Some((id, _, _)) = video_files.iter().find(|(_, path, _)| {
            let file_signatures = collect_episode_signatures(
                path,
                (fallback_season_hint > 0).then_some(fallback_season_hint),
            );
            !file_signatures.is_empty()
                && fallback_episode_signatures
                    .iter()
                    .any(|signature| file_signatures.contains(signature))
        })
    {
        return vec![*id];
    }

    video_files
        .iter()
        .max_by_key(|(_, path, bytes)| (container_preference_rank(path), *bytes))
        .map(|(id, _, _)| vec![*id])
        .unwrap_or_default()
}

pub(super) fn ready_info_has_selected_file_id(info: &Value, selected_file_id: i64) -> bool {
    if selected_file_id <= 0 {
        return true;
    }
    let Some(files) = info.get("files").and_then(Value::as_array) else {
        return true;
    };
    if files.is_empty() {
        return true;
    }
    files.iter().any(|file| {
        file.get("id").and_then(Value::as_i64) == Some(selected_file_id)
            && file
                .get("selected")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                != 0
    })
}

pub(super) fn reusable_rd_torrent_ready_for_selected_file(
    info: &Value,
    selected_file_id: i64,
) -> bool {
    if selected_file_id <= 0
        || stringify_json(info.get("status")) != "downloaded"
        || info
            .get("links")
            .and_then(Value::as_array)
            .is_none_or(|links| links.len() != 1)
    {
        return false;
    }
    let Some(files) = info.get("files").and_then(Value::as_array) else {
        return false;
    };
    let selected = files
        .iter()
        .filter(|file| {
            file.get("selected")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                != 0
        })
        .collect::<Vec<_>>();
    selected.len() == 1 && selected[0].get("id").and_then(Value::as_i64) == Some(selected_file_id)
}

pub(super) fn is_rd_selected_file_mismatch_error(error: &ApiError) -> bool {
    error.message() == Some(RD_SELECTED_FILE_MISMATCH_ERROR)
}

impl ResolverService {
    async fn add_real_debrid_magnet_owned(
        &self,
        real_debrid: &RealDebridRequestContext,
        magnet: &str,
        info_hash: &str,
    ) -> AppResult<OwnedRealDebridTorrentLease> {
        let add_service = self.clone();
        let add_context = real_debrid.clone();
        let owned_magnet = magnet.to_owned();
        let cleanup_service = self.clone();
        let cleanup_context = real_debrid.clone();
        let cleanup_info_hash = info_hash.to_owned();
        acquire_owned_real_debrid_torrent_lease(
            async move {
                let add_magnet = add_service
                    .rd_fetch_form(
                        &add_context,
                        "/torrents/addMagnet",
                        reqwest::Method::POST,
                        &[("magnet", owned_magnet.as_str())],
                        12_000,
                    )
                    .await?;
                let torrent_id = stringify_json(add_magnet.get("id"));
                if torrent_id.is_empty() {
                    return Err(ApiError::internal(
                        "Real-Debrid did not return a torrent id.",
                    ));
                }
                Ok(torrent_id)
            },
            move |torrent_id| async move {
                let _ = cleanup_service
                    .safe_delete_torrent(&cleanup_context, &torrent_id)
                    .await;
                let _ = cleanup_service
                    .delete_cached_rd_torrent_id(&cleanup_context, &cleanup_info_hash)
                    .await;
            },
        )
        .await
    }

    pub(super) async fn resolve_real_debrid_candidate_stream(
        &self,
        stream: &DiscoveryStream,
        fallback_name: &str,
        real_debrid: &RealDebridRequestContext,
    ) -> AppResult<RealDebridResolvedStream> {
        let magnet = build_magnet_uri(stream, fallback_name)?;
        let info_hash = get_stream_info_hash(stream);
        if let Ok(Some(reusable_torrent_id)) = self
            .find_reusable_rd_torrent_by_hash(real_debrid, &info_hash)
            .await
        {
            match self
                .resolve_from_torrent_id(
                    real_debrid,
                    &reusable_torrent_id,
                    &info_hash,
                    stream,
                    fallback_name,
                    RealDebridTorrentOwnership::ReusedFromAccount,
                )
                .await
            {
                Ok(resolved) => {
                    let _ = self
                        .set_cached_rd_torrent_id(real_debrid, &info_hash, &reusable_torrent_id)
                        .await;
                    return Ok(RealDebridResolvedStream {
                        resolved,
                        owned_torrent: None,
                    });
                }
                Err(_) => {
                    // A list-discovered or cached id may belong to another app
                    // or a user-created cloud torrent. Never mutate or delete it.
                    let _ = self
                        .delete_cached_rd_torrent_id(real_debrid, &info_hash)
                        .await;
                }
            }
        }

        let mut last_error = None;
        for attempt in 0..2 {
            let owned_torrent = self
                .add_real_debrid_magnet_owned(real_debrid, &magnet, &info_hash)
                .await?;
            let torrent_id = owned_torrent.torrent_id().to_owned();

            let result = self
                .resolve_from_torrent_id(
                    real_debrid,
                    &torrent_id,
                    &info_hash,
                    stream,
                    fallback_name,
                    RealDebridTorrentOwnership::CreatedByRequest,
                )
                .await;
            match result {
                Ok(resolved) => {
                    let _ = self
                        .set_cached_rd_torrent_id(real_debrid, &info_hash, &torrent_id)
                        .await;
                    return Ok(RealDebridResolvedStream {
                        resolved,
                        owned_torrent: Some(owned_torrent),
                    });
                }
                Err(error) => {
                    let retry_after_stale_selected_file =
                        attempt == 0 && is_rd_selected_file_mismatch_error(&error);
                    // Wait for deletion before retrying so a stale cloud entry
                    // cannot be returned by the next addMagnet call.
                    owned_torrent.cleanup().await;
                    if retry_after_stale_selected_file {
                        last_error = Some(error);
                        continue;
                    }
                    return Err(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| ApiError::internal("Unable to resolve this source.")))
    }

    pub(super) async fn resolve_from_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
        info_hash: &str,
        stream: &DiscoveryStream,
        fallback_name: &str,
        ownership: RealDebridTorrentOwnership,
    ) -> AppResult<ResolvedSource> {
        let info = self
            .rd_fetch_json(
                real_debrid,
                &format!("/torrents/info/{torrent_id}"),
                reqwest::Method::GET,
                12_000,
            )
            .await?;
        let files = info
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let file_ids = pick_video_file_ids(&files, &stream.behaviorHints.filename, fallback_name);
        if file_ids.is_empty() {
            return Err(ApiError::internal(
                "No supported video file was found in this torrent.",
            ));
        }
        let selected_file = file_ids[0].to_string();
        let selected_file_path = files
            .iter()
            .find(|file| file.get("id").and_then(Value::as_i64) == Some(file_ids[0]))
            .map(|file| stringify_json(file.get("path")))
            .unwrap_or_default();
        let (ready_info, real_debrid_cached) = if ownership.may_change_file_selection() {
            self.rd_fetch_form(
                real_debrid,
                &format!("/torrents/selectFiles/{torrent_id}"),
                reqwest::Method::POST,
                &[(
                    "files",
                    &file_ids
                        .iter()
                        .map(|value| value.to_string())
                        .collect::<Vec<_>>()
                        .join(","),
                )],
                12_000,
            )
            .await?;
            self.wait_for_torrent_to_be_ready(real_debrid, torrent_id)
                .await?
        } else {
            if !reusable_rd_torrent_ready_for_selected_file(&info, file_ids[0]) {
                return Err(ApiError::internal(
                    "The reusable Real-Debrid torrent has a different file selection.",
                ));
            }
            (info, true)
        };
        if !ready_info_has_selected_file_id(&ready_info, file_ids[0]) {
            return Err(ApiError::internal(RD_SELECTED_FILE_MISMATCH_ERROR));
        }
        let download_links = ready_info
            .get("links")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        if download_links.is_empty() {
            return Err(ApiError::internal(
                "No Real-Debrid download link was generated.",
            ));
        }

        let mut filename = String::new();
        let mut ranked_candidates = Vec::new();
        let mut last_error = None;
        for download_link in download_links {
            match self
                .resolve_playable_url_from_rd_link(real_debrid, &download_link)
                .await
            {
                Ok((playable_urls, resolved_filename)) => {
                    if filename.is_empty() {
                        filename = resolved_filename.clone();
                    }
                    let filename_hint = if !filename.is_empty() {
                        filename.clone()
                    } else if !selected_file_path.is_empty() {
                        selected_file_path.clone()
                    } else {
                        resolved_filename
                    };
                    let mut ranked_urls = playable_urls
                        .into_iter()
                        .filter(|url| !url.trim().is_empty())
                        .collect::<Vec<_>>();
                    ranked_urls.sort_by(|left, right| {
                        real_debrid_playback_url_priority(right)
                            .cmp(&real_debrid_playback_url_priority(left))
                    });
                    if ranked_urls.is_empty()
                        && is_supported_resolved_container_path(&filename_hint)
                    {
                        last_error = Some(ApiError::internal(
                            "No playable Real-Debrid stream URL was available.",
                        ));
                    }
                    for playable_url in ranked_urls {
                        // `/unrestrict/link` is the authoritative control-plane
                        // response. A synchronous CDN HEAD here added up to 8s
                        // before first frame; normal playback fallback and the
                        // persisted-session validator handle later failures.
                        push_unique_url(&mut ranked_candidates, &playable_url);
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }

        if ranked_candidates.is_empty() {
            return Err(last_error.unwrap_or_else(|| {
                ApiError::internal("No playable Real-Debrid stream URL was available.")
            }));
        }
        ranked_candidates.sort_by(|left, right| {
            real_debrid_playback_url_priority(right).cmp(&real_debrid_playback_url_priority(left))
        });

        let playable_url = ranked_candidates[0].clone();
        let resolved = ResolvedSource {
            playable_url,
            fallback_urls: ranked_candidates.into_iter().skip(1).collect(),
            filename: if filename.is_empty() {
                selected_file_path.clone()
            } else {
                filename
            },
            source_hash: info_hash.to_owned(),
            selected_file,
            selected_file_path,
            real_debrid_cached,
        };
        Ok(resolved)
    }

    pub(super) async fn find_reusable_rd_torrent_by_hash(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<Option<String>> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(None);
        }

        if let Some(cached_torrent_id) = self
            .get_cached_rd_torrent_id(real_debrid, &normalized_hash)
            .await?
        {
            return Ok(Some(cached_torrent_id));
        }

        let ready_cache_key = format!("rd-ready-hashes:{}", real_debrid.cache_scope);
        if let Some((payload, _)) = self.db.get_movie_quick_start_cache(ready_cache_key).await? {
            let torrent_id = parse_ready_real_debrid_torrents(&payload)
                .get(&normalized_hash)
                .cloned();
            if let Some(torrent_id) = torrent_id.as_deref() {
                let _ = self
                    .set_cached_rd_torrent_id(real_debrid, &normalized_hash, torrent_id)
                    .await;
            }
            // A present ready-map is authoritative for its short TTL, including
            // misses. A cold/in-flight map also falls through immediately: do
            // not duplicate the background account-list request on playback's
            // critical path; addMagnet can use RD's cache directly.
            return Ok(torrent_id);
        }
        Ok(None)
    }

    pub(super) async fn mark_ready_real_debrid_sources(
        &self,
        streams: &mut [DiscoveryStream],
        real_debrid: Option<&RealDebridRequestContext>,
    ) {
        let Some(real_debrid) = real_debrid else {
            return;
        };
        let Ok(Some(ready_hashes)) = self.cached_ready_real_debrid_hashes(real_debrid).await else {
            // Badges are advisory, so a cold cache never delays the source
            // menu. Refresh once per user in the background and let this
            // request proceed with normal ranking.
            let candidate_hashes = streams
                .iter()
                .map(get_stream_info_hash)
                .filter(|hash| !hash.is_empty())
                .collect();
            self.spawn_ready_real_debrid_hash_refresh((*real_debrid).clone(), candidate_hashes);
            return;
        };
        for stream in streams {
            stream.real_debrid_cached = ready_hashes.contains(&get_stream_info_hash(stream));
        }
    }

    pub(super) async fn cached_ready_real_debrid_hashes(
        &self,
        real_debrid: &RealDebridRequestContext,
    ) -> AppResult<Option<HashSet<String>>> {
        let cache_key = format!("rd-ready-hashes:{}", real_debrid.cache_scope);
        if let Some((payload, _)) = self
            .db
            .get_movie_quick_start_cache(cache_key.clone())
            .await?
        {
            return Ok(Some(parse_ready_real_debrid_hashes(&payload)));
        }
        Ok(None)
    }

    fn spawn_ready_real_debrid_hash_refresh(
        &self,
        real_debrid: RealDebridRequestContext,
        candidate_hashes: HashSet<String>,
    ) {
        let scope = real_debrid.cache_scope.clone();
        if self.rd_ready_refreshes.insert(scope.clone(), ()).is_some() {
            return;
        }
        let service = self.clone();
        tokio::spawn(async move {
            if service
                .refresh_ready_real_debrid_hashes(&real_debrid, &candidate_hashes)
                .await
                .is_err()
            {
                // Brief negative cache prevents a provider outage or revoked
                // token from causing a request storm. It affects badges only.
                let _ = service
                    .db
                    .set_movie_quick_start_cache(
                        format!("rd-ready-hashes:{scope}"),
                        json!({ "hashes": [] }),
                        now_ms() + 5_000,
                    )
                    .await;
            }
            service.rd_ready_refreshes.remove(&scope);
        });
    }

    pub(super) async fn refresh_ready_real_debrid_hashes(
        &self,
        real_debrid: &RealDebridRequestContext,
        candidate_hashes: &HashSet<String>,
    ) -> AppResult<()> {
        let cache_key = format!("rd-ready-hashes:{}", real_debrid.cache_scope);
        let payload = self
            .rd_fetch_json(
                real_debrid,
                &format!("/torrents?limit={RD_TORRENT_LIST_LIMIT}"),
                reqwest::Method::GET,
                3_000,
            )
            .await?;
        let ready_torrents = parse_ready_real_debrid_torrents(&payload);
        let hashes = ready_torrents.keys().cloned().collect::<HashSet<_>>();
        for (hash, torrent_id) in &ready_torrents {
            if candidate_hashes.contains(hash) {
                let _ = self
                    .set_cached_rd_torrent_id(real_debrid, hash, torrent_id)
                    .await;
            }
        }
        let _ = self
            .db
            .set_movie_quick_start_cache(
                cache_key,
                json!({
                    "hashes": hashes.iter().collect::<Vec<_>>(),
                    "torrents": ready_torrents
                }),
                now_ms() + RD_READY_HASH_CACHE_TTL_MS,
            )
            .await;
        Ok(())
    }

    pub(super) async fn get_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<Option<String>> {
        let cache_key = build_scoped_rd_torrent_cache_key(&real_debrid.cache_scope, info_hash);
        let Some((payload, _)) = self.db.get_movie_quick_start_cache(cache_key).await? else {
            return Ok(None);
        };
        let torrent_id = stringify_json(payload.get("torrentId"));
        if torrent_id.is_empty() {
            return Ok(None);
        }
        Ok(Some(torrent_id))
    }

    pub(super) async fn set_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
        torrent_id: &str,
    ) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        let normalized_torrent_id = torrent_id.trim();
        if normalized_hash.is_empty() || normalized_torrent_id.is_empty() {
            return Ok(());
        }
        self.db
            .set_movie_quick_start_cache(
                build_scoped_rd_torrent_cache_key(&real_debrid.cache_scope, &normalized_hash),
                json!({
                    "infoHash": normalized_hash,
                    "torrentId": normalized_torrent_id
                }),
                now_ms() + RD_TORRENT_CACHE_TTL_MS,
            )
            .await
    }

    pub(super) async fn delete_cached_rd_torrent_id(
        &self,
        real_debrid: &RealDebridRequestContext,
        info_hash: &str,
    ) -> AppResult<()> {
        let normalized_hash = normalize_source_hash(info_hash);
        if normalized_hash.is_empty() {
            return Ok(());
        }
        self.db
            .delete_movie_quick_start_cache(build_scoped_rd_torrent_cache_key(
                &real_debrid.cache_scope,
                &normalized_hash,
            ))
            .await
    }

    pub(super) async fn record_source_resolve_failure(
        &self,
        stream: &DiscoveryStream,
        error: &ApiError,
    ) {
        if !is_persistent_source_resolve_error(error) {
            return;
        }
        let source_hash = get_stream_info_hash(stream);
        if source_hash.is_empty() {
            return;
        }
        let message = error
            .message()
            .unwrap_or("Source failed during resolve.")
            .to_owned();
        let _ = self
            .db
            .record_source_health_event(source_hash, "playback_error".to_owned(), message)
            .await;
    }

    pub(super) async fn wait_for_torrent_to_be_ready(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
    ) -> AppResult<(Value, bool)> {
        let started_at = now_ms();
        let mut last_status = "pending".to_owned();
        let mut poll_count = 0_u32;
        while now_ms() - started_at < 18_000 {
            let info = self
                .rd_fetch_json(
                    real_debrid,
                    &format!("/torrents/info/{torrent_id}"),
                    reqwest::Method::GET,
                    12_000,
                )
                .await?;
            let status = stringify_json(info.get("status")).to_lowercase();
            if !status.is_empty() {
                last_status = status.clone();
            }
            let has_links = info
                .get("links")
                .and_then(Value::as_array)
                .map(|values| !values.is_empty())
                .unwrap_or(false);
            if status == "downloaded" && has_links {
                // Allow a short control-plane transition after file selection;
                // cached torrents can briefly report queued before the CDN link
                // appears. Later readiness can represent a real cloud download
                // and must not be badged as cached.
                return Ok((info, now_ms() - started_at <= 2_000));
            }
            if TORRENT_FATAL_STATUSES.contains(&status.as_str()) {
                return Err(ApiError::internal(format!(
                    "Real-Debrid torrent failed ({status})."
                )));
            }
            poll_count += 1;
            // Cached torrents normally transition in a few hundred
            // milliseconds. Poll tightly at first, then back off so an
            // uncached download does not burn the user's API allowance.
            let delay_ms = if poll_count <= 4 { 250 } else { 1_000 };
            sleep(Duration::from_millis(delay_ms)).await;
        }
        Err(ApiError::internal(format!(
            "Timed out waiting for cached source ({last_status})."
        )))
    }

    pub(super) async fn resolve_playable_url_from_rd_link(
        &self,
        real_debrid: &RealDebridRequestContext,
        rd_link: &str,
    ) -> AppResult<(Vec<String>, String)> {
        let remote_traffic = real_debrid.remote_traffic;
        let form = build_real_debrid_unrestrict_form(rd_link, remote_traffic);
        let unrestricted = self
            .rd_fetch_form(
                real_debrid,
                "/unrestrict/link",
                reqwest::Method::POST,
                &form,
                12_000,
            )
            .await?;
        let download = stringify_json(unrestricted.get("download"));
        if download.is_empty() {
            return Err(ApiError::internal(
                "Real-Debrid returned no downloadable link.",
            ));
        }
        let mut playable_urls = Vec::new();
        let streamable = unrestricted
            .get("streamable")
            .and_then(Value::as_i64)
            .is_some_and(|value| value != 0)
            || unrestricted
                .get("streamable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let download_id = stringify_json(unrestricted.get("id"));
        playable_urls.push(download);
        if let Some(lazy_hls) = build_real_debrid_lazy_hls_playback_source(
            &download_id,
            streamable,
            real_debrid,
            &self.config.live_hls_proxy_secret,
        ) {
            playable_urls.push(lazy_hls);
        }
        Ok((playable_urls, stringify_json(unrestricted.get("filename"))))
    }

    pub(crate) async fn resolve_real_debrid_lazy_hls_fallback(
        &self,
        query: &str,
        user_id: i64,
        api_key: &str,
        session_token: &str,
    ) -> AppResult<String> {
        let real_debrid =
            RealDebridRequestContext::for_user(user_id, api_key).ok_or_else(|| {
                ApiError::failed_dependency(
                    "Enable Real-Debrid and add an API token in Settings to use HLS fallback.",
                )
            })?;
        let input = parse_strict_real_debrid_lazy_hls_query(query)
            .ok_or_else(|| ApiError::forbidden("Invalid Real-Debrid HLS fallback ticket."))?;
        let ticket = authorize_real_debrid_lazy_hls_ticket(
            &input,
            &real_debrid,
            &self.config.live_hls_proxy_secret,
            now_ms().div_euclid(1_000),
        )
        .ok_or_else(|| {
            ApiError::forbidden("Invalid or expired Real-Debrid HLS fallback ticket.")
        })?;
        let cache_key = real_debrid_lazy_hls_cache_key(&ticket.download_id, &real_debrid);
        // A ticket is replayable until its short expiry so a browser retry can
        // recover, but concurrent retries must cost only one provider call.
        // A global fail-fast cap bounds distinct-ID fanout while a per-user
        // window caps sequential valid-ticket replays. The small negative cache
        // also prevents a failing ticket from burning the account's API quota
        // in a tight retry loop.
        let upstream_url = self
            .rd_lazy_hls
            .resolve(
                &cache_key,
                user_id,
                ticket.expires_at.saturating_mul(1_000),
                || async {
                    self.rd_fetch_json(
                        &real_debrid,
                        &format!("/streaming/transcode/{}", ticket.download_id),
                        reqwest::Method::GET,
                        6_000,
                    )
                    .await
                    .ok()
                    .and_then(|payload| real_debrid_apple_transcode_url(&payload))
                },
            )
            .await?;
        upstream_url
            .ok_or_else(|| {
                ApiError::bad_gateway("Real-Debrid HLS fallback is temporarily unavailable.")
            })
            .and_then(|upstream| {
                build_real_debrid_private_hls_relay(
                    &upstream,
                    &self.config.live_hls_proxy_secret,
                    session_token,
                )
            })
    }

    pub(super) async fn verify_playable_url(
        &self,
        playable_url: &str,
        timeout_ms: u64,
    ) -> AppResult<PlayableUrlVerification> {
        if playable_url.trim().is_empty() {
            return Err(ApiError::internal("Resolved stream URL is empty."));
        }
        let response = self
            .client
            .head(playable_url)
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => Ok(PlayableUrlVerification::Verified),
            Ok(response)
                if matches!(response.status().as_u16(), 401 | 403 | 404)
                    || response.status().is_server_error() =>
            {
                Err(ApiError::internal(format!(
                    "Resolved stream is unavailable ({}).",
                    response.status().as_u16()
                )))
            }
            Ok(_) => Ok(PlayableUrlVerification::Uncertain),
            Err(error) if error.is_timeout() => Ok(PlayableUrlVerification::Uncertain),
            Err(_) => Ok(PlayableUrlVerification::Uncertain),
        }
    }

    pub(super) async fn rd_fetch_json(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(real_debrid, path, method, None, timeout_ms)
            .await
    }

    pub(super) async fn rd_fetch_form(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        form: &[(&str, &str)],
        timeout_ms: u64,
    ) -> AppResult<Value> {
        self.rd_fetch(real_debrid, path, method, Some(form), timeout_ms)
            .await
    }

    pub(super) async fn rd_fetch(
        &self,
        real_debrid: &RealDebridRequestContext,
        path: &str,
        method: reqwest::Method,
        form: Option<&[(&str, &str)]>,
        timeout_ms: u64,
    ) -> AppResult<Value> {
        if real_debrid.api_key.trim().is_empty() {
            return Err(ApiError::internal("Real-Debrid API key is not configured."));
        }
        let mut builder = self
            .client
            .request(method, format!("{REAL_DEBRID_API_BASE}{path}"))
            .bearer_auth(real_debrid.api_key.clone())
            .timeout(Duration::from_millis(timeout_ms));
        if let Some(form) = form {
            builder = builder.form(form);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "Real-Debrid request timed out."))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|_| ApiError::bad_gateway("Real-Debrid response could not be read."))?;
        let payload = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| {
            json!({
                "message": body
            })
        });
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .unwrap_or("Real-Debrid request failed.");
            let user_message = user_facing_real_debrid_error(message);
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(ApiError::bad_request(
                    "Real-Debrid rejected this API token.",
                ));
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(ApiError::failed_dependency(
                    "Real-Debrid denied access. Check that the account is active and premium.",
                ));
            }
            if is_real_debrid_blocked_source_message(&user_message) {
                return Err(ApiError::failed_dependency(user_message));
            }
            return Err(ApiError::bad_gateway(user_message));
        }
        Ok(payload)
    }

    pub(super) async fn safe_delete_torrent(
        &self,
        real_debrid: &RealDebridRequestContext,
        torrent_id: &str,
    ) -> AppResult<()> {
        if torrent_id.trim().is_empty() {
            return Ok(());
        }
        let _ = self
            .rd_fetch_json(
                real_debrid,
                &format!("/torrents/delete/{torrent_id}"),
                reqwest::Method::DELETE,
                5_000,
            )
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod lazy_hls_control_tests {
    use super::*;

    #[test]
    fn lazy_hls_control_bounds_distinct_provider_calls_and_user_replays() {
        let control = RealDebridLazyHlsControl::new();
        let first_lock = control.lock("same-ticket");
        let second_lock = control.lock("same-ticket");
        assert!(Arc::ptr_eq(&first_lock, &second_lock));

        let permits = (0..RD_LAZY_HLS_MAX_CONCURRENT)
            .map(|_| {
                control
                    .try_acquire_provider_permit()
                    .expect("provider permit")
            })
            .collect::<Vec<_>>();
        let busy = control
            .try_acquire_provider_permit()
            .expect_err("distinct request beyond the cap must fail fast");
        assert_eq!(busy.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        drop(permits);
        assert!(control.try_acquire_provider_permit().is_ok());

        for _ in 0..RD_LAZY_HLS_USER_MAX_ATTEMPTS {
            control
                .check_user_provider_budget(7)
                .expect("attempt within user budget");
        }
        let exhausted = control
            .check_user_provider_budget(7)
            .expect_err("attempt beyond the user budget must fail");
        assert_eq!(
            exhausted.status(),
            axum::http::StatusCode::TOO_MANY_REQUESTS
        );
        control
            .check_user_provider_budget(8)
            .expect("another user has an independent budget");
    }

    #[tokio::test]
    async fn lazy_hls_same_ticket_retries_single_flight_before_taking_provider_permits() {
        let control = RealDebridLazyHlsControl::new();
        let provider_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let expires_at_ms = now_ms().saturating_add(60_000);
        let attempts = (0..12).map(|_| {
            let control = control.clone();
            let provider_calls = Arc::clone(&provider_calls);
            async move {
                control
                    .resolve("same-ticket", 7, expires_at_ms, || async move {
                        provider_calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Some("https://stream.real-debrid.com/shared.m3u8".to_owned())
                    })
                    .await
            }
        });
        let results = futures_util::future::join_all(attempts).await;

        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        assert!(results.iter().all(|result| {
            result.as_ref().is_ok_and(|value| {
                value.as_deref() == Some("https://stream.real-debrid.com/shared.m3u8")
            })
        }));
        assert_eq!(
            control.permits.available_permits(),
            RD_LAZY_HLS_MAX_CONCURRENT
        );
    }

    #[test]
    fn lazy_hls_cache_evicts_one_old_entry_without_flushing_hot_entries() {
        let control = RealDebridLazyHlsControl::new();
        let base_expiry = now_ms().saturating_add(60_000);
        for index in 0..RD_LAZY_HLS_CACHE_MAX_ENTRIES {
            control.store(
                format!("ticket-{index}"),
                Some(format!("https://stream.real-debrid.com/{index}.m3u8")),
                base_expiry.saturating_add(index as i64),
            );
        }
        control.store(
            "new-ticket".to_owned(),
            Some("https://stream.real-debrid.com/new.m3u8".to_owned()),
            base_expiry.saturating_add(RD_LAZY_HLS_CACHE_MAX_ENTRIES as i64),
        );

        assert_eq!(control.entries.len(), RD_LAZY_HLS_CACHE_MAX_ENTRIES);
        assert!(control.fresh("ticket-0").is_none());
        assert!(control.fresh("ticket-1").is_some());
        assert!(control.fresh("ticket-511").is_some());
        assert!(control.fresh("new-ticket").is_some());
    }
}

use std::collections::HashSet;
use std::fs;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderValue, RANGE,
};
use axum::http::{HeaderMap, Method, Response, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dashmap::DashMap;
use futures_util::StreamExt as _;
use hmac::{Hmac, Mac};
use librqbit::api::TorrentIdOrHash;
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ListOnlyResponse, ManagedTorrent,
    PeerConnectionOptions, Session, SessionOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::{Mutex, Notify, OnceCell};
use tokio::time::timeout;
use tokio_util::io::ReaderStream;

use crate::cleanup_guard::CleanupGuard;
use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::key_lock::key_lock;
use crate::persistence::Db;
use crate::playback_optimize::optimize_playback_cache_file_best_effort;
use crate::resolver::pick_video_file_ids;
use crate::utils::now_ms;

const LOCAL_TORRENT_RECENT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const LOCAL_TORRENT_ACCESS_MARKER: &str = ".last-accessed";
/// Persisted BitTorrent metainfo so resolves after restart don't wait on peers
/// for metadata that was already fetched once.
const LOCAL_TORRENT_METAINFO_FILENAME: &str = ".meta.torrent";
/// Short HTTP hedge when local metainfo is missing. It races magnet peer/DHT
/// metadata, which remains bounded by LOCAL_TORRENT_METADATA_TIMEOUT_MS.
const LOCAL_TORRENT_METAINFO_FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Public metainfo caches are untrusted HTTP endpoints. Legitimate `.torrent`
/// files are normally tiny compared with the selected media, so reject an
/// unexpectedly large response before it can consume unbounded memory.
const LOCAL_TORRENT_METAINFO_MAX_BYTES: usize = 16 * 1024 * 1024;
const LOCAL_TORRENT_STARTUP_PROBE_BYTES: usize = 256 * 1024;
const LOCAL_TORRENT_FINISHED_HANDLE_GRACE_MS: i64 = 5 * 60 * 1000;
const CACHE_CONTROL_STREAM: &str = "no-store";
const DIRECT_FILE_CACHE_FOLDER: &str = "direct";
const INTERNAL_STREAM_ACCESS_PARAM: &str = "internalAccess";
// Keep in sync with resolver::DEFAULT_TRACKERS so cold magnets still get peers
// even when the provider magnet omits public trackers.
const LOCAL_TORRENT_SESSION_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://explodie.org:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker.cyberia.is:6969/announce",
    "udp://tracker.dump.cl:6969/announce",
];

fn session_tracker_urls() -> HashSet<url::Url> {
    LOCAL_TORRENT_SESSION_TRACKERS
        .iter()
        .filter_map(|tracker| url::Url::parse(tracker).ok())
        .collect()
}

fn add_torrent_tracker_list() -> Vec<String> {
    LOCAL_TORRENT_SESSION_TRACKERS
        .iter()
        .map(|tracker| (*tracker).to_owned())
        .collect()
}

fn local_torrent_add_options(
    output_folder: &Path,
    paused: bool,
    only_file: Option<usize>,
) -> AddTorrentOptions {
    AddTorrentOptions {
        paused,
        only_files: only_file.map(|file_id| vec![file_id]),
        output_folder: Some(output_folder.to_string_lossy().to_string()),
        overwrite: true,
        trackers: Some(add_torrent_tracker_list()),
        peer_opts: Some(PeerConnectionOptions {
            connect_timeout: Some(Duration::from_secs(20)),
            read_write_timeout: Some(Duration::from_secs(20)),
            keep_alive_interval: None,
        }),
        ..Default::default()
    }
}

fn local_torrent_list_options(output_folder: &Path) -> AddTorrentOptions {
    AddTorrentOptions {
        list_only: true,
        ..local_torrent_add_options(output_folder, true, None)
    }
}
const INTERNAL_STREAM_ACCESS_CONTEXT: &[u8] = b"streamarena-local-torrent-internal-v1";
type HmacSha256 = Hmac<Sha256>;
type PendingTorrentCleanup = CleanupGuard<Box<dyn FnOnce() + Send>>;
/// Direct-cache downloads only ever target Real-Debrid unrestricted
/// links. Restricting the host prevents this server-side fetch from being
/// pointed at internal/metadata endpoints (SSRF).
const DIRECT_CACHE_ALLOWED_DOWNLOAD_HOSTS: &[&str] =
    &["download.real-debrid.com", "real-debrid.com"];

fn internal_stream_access_token(secret: &str, protected_target: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any length");
    mac.update(INTERNAL_STREAM_ACCESS_CONTEXT);
    mac.update(b"\0");
    mac.update(protected_target.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub(crate) fn with_internal_stream_access(path_and_query: &str, secret: &str) -> String {
    let protected_target = path_and_query.trim();
    let separator = if protected_target.contains('?') {
        '&'
    } else {
        '?'
    };
    format!(
        "{protected_target}{separator}{INTERNAL_STREAM_ACCESS_PARAM}={}",
        internal_stream_access_token(secret, protected_target)
    )
}

pub(crate) fn is_internal_stream_request(secret: &str, uri: &axum::http::Uri) -> bool {
    if !matches!(
        uri.path(),
        "/api/local-torrent/stream" | "/api/local-cache/stream"
    ) {
        return false;
    }
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| uri.path());
    let separator = format!("&{INTERNAL_STREAM_ACCESS_PARAM}=");
    let first_separator = format!("?{INTERNAL_STREAM_ACCESS_PARAM}=");
    let Some((protected_target, encoded_token)) = path_and_query
        .rsplit_once(&separator)
        .or_else(|| path_and_query.rsplit_once(&first_separator))
    else {
        return false;
    };
    if encoded_token.is_empty() || encoded_token.contains('&') {
        return false;
    }
    let Ok(token) = URL_SAFE_NO_PAD.decode(encoded_token) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(INTERNAL_STREAM_ACCESS_CONTEXT);
    mac.update(b"\0");
    mac.update(protected_target.as_bytes());
    mac.verify_slice(&token).is_ok()
}

#[derive(Clone)]
pub struct LocalTorrentService {
    config: Config,
    db: Db,
    http_client: reqwest::Client,
    session: Arc<OnceCell<Arc<Session>>>,
    handles: Arc<DashMap<String, Arc<ManagedTorrent>>>,
    pending_handle_deletions: Arc<DashMap<String, Arc<PendingTorrentDeletion>>>,
    active_streams: Arc<DashMap<String, Arc<AtomicUsize>>>,
    managed_add_lock: Arc<Mutex<()>>,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalTorrentResolveRequest {
    pub info_hash: String,
    pub magnet_uri: String,
    pub preferred_file_index: Option<usize>,
    pub preferred_filename: String,
    pub fallback_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalTorrentResolvedSource {
    pub playable_url: String,
    pub filename: String,
    pub source_hash: String,
    pub selected_file: String,
    pub selected_file_path: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct DirectFileCacheRequest {
    pub source_hash: String,
    pub file_id: String,
    pub source_url: String,
    pub filename: String,
    pub selected_file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTorrentCacheEntry {
    source_hash: String,
    magnet_uri: String,
    file_id: usize,
    file_path: String,
    filename: String,
    output_folder: String,
    file_length: u64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectFileCacheEntry {
    source_hash: String,
    file_id: String,
    source_url: String,
    filename: String,
    selected_file_path: String,
    file_path: String,
    file_length: u64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalTorrentFileCandidate {
    file_id: usize,
    path: String,
    length: u64,
}

#[derive(Debug)]
struct CacheDirEntry {
    path: PathBuf,
    name: String,
    size: u64,
    modified_ms: i64,
}

struct PendingTorrentDeletion {
    done: Notify,
}

struct ActiveTorrentStreamGuard {
    count: Arc<AtomicUsize>,
}

fn spawn_cleanup_holding_managed_add_lock(
    runtime: tokio::runtime::Handle,
    managed_add_guard: tokio::sync::OwnedMutexGuard<()>,
    cleanup: impl std::future::Future<Output = ()> + Send + 'static,
) {
    runtime.spawn(async move {
        let _managed_add_guard = managed_add_guard;
        cleanup.await;
    });
}

impl Drop for ActiveTorrentStreamGuard {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

impl LocalTorrentService {
    pub fn new(config: Config, db: Db, http_client: reqwest::Client) -> Self {
        let download_client = reqwest::Client::builder()
            .user_agent("streamarena-backend")
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or(http_client);
        Self {
            config,
            db,
            http_client: download_client,
            session: Arc::new(OnceCell::new()),
            handles: Arc::new(DashMap::new()),
            pending_handle_deletions: Arc::new(DashMap::new()),
            active_streams: Arc::new(DashMap::new()),
            managed_add_lock: Arc::new(Mutex::new(())),
            locks: Arc::new(DashMap::new()),
        }
    }

    pub fn is_available(&self) -> bool {
        true
    }

    pub(crate) async fn resolve(
        &self,
        request: LocalTorrentResolveRequest,
    ) -> AppResult<LocalTorrentResolvedSource> {
        let source_hash = normalize_torrent_hash(&request.info_hash);
        if source_hash.is_empty() {
            return Err(ApiError::bad_request(
                "Local torrent source hash is invalid.",
            ));
        }
        if !request
            .magnet_uri
            .trim()
            .to_lowercase()
            .starts_with("magnet:?")
        {
            return Err(ApiError::bad_request(
                "Local torrent magnet URI is invalid.",
            ));
        }

        let lock = key_lock(&self.locks, &source_hash);
        let _guard = lock.lock().await;

        let session = self.session().await?;
        let output_folder = self.output_folder_for_hash(&source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;

        let (handle, selected, newly_added) = self
            .prepare_selected_handle(session.clone(), &request, &output_folder)
            .await?;
        let mut pending_handle_cleanup = newly_added
            .then(|| self.pending_handle_cleanup(session, source_hash.clone(), handle.clone()));

        let mut entry = LocalTorrentCacheEntry {
            source_hash: source_hash.clone(),
            magnet_uri: request.magnet_uri.trim().to_owned(),
            file_id: selected.file_id,
            file_path: selected.path.clone(),
            filename: filename_from_path(&selected.path),
            output_folder: output_folder.to_string_lossy().to_string(),
            file_length: selected.length,
            updated_at_ms: now_ms(),
        };
        self.wait_for_startup_probe(handle.clone(), entry.file_id)
            .await?;

        let file_id_key = entry.file_id.to_string();
        if let Some(optimized) = self
            .try_direct_file_resolved_source(&source_hash, &file_id_key)
            .await?
        {
            self.refresh_entry_access_best_effort(&mut entry).await;
            if let Some(cleanup) = pending_handle_cleanup.as_mut() {
                cleanup.disarm();
            }
            return Ok(optimized);
        }

        self.refresh_entry_access(&mut entry).await?;

        if let Some(cleanup) = pending_handle_cleanup.as_mut() {
            cleanup.disarm();
        }

        Ok(LocalTorrentResolvedSource {
            playable_url: local_torrent_stream_url(&entry.source_hash, entry.file_id),
            filename: entry.filename.clone(),
            source_hash: entry.source_hash.clone(),
            selected_file: entry.file_id.to_string(),
            selected_file_path: entry.file_path.clone(),
        })
    }

    #[allow(dead_code)]
    pub(crate) async fn cache_direct_file(
        &self,
        request: DirectFileCacheRequest,
    ) -> AppResult<LocalTorrentResolvedSource> {
        let source_hash = normalize_torrent_hash(&request.source_hash);
        if source_hash.is_empty() {
            return Err(ApiError::bad_request(
                "Direct cache source hash is invalid.",
            ));
        }
        let file_id = normalize_direct_file_id(&request.file_id);
        if file_id.is_empty() {
            return Err(ApiError::bad_request("Direct cache file id is invalid."));
        }
        let source_url = request.source_url.trim();
        if !is_allowed_direct_cache_url(source_url) {
            return Err(ApiError::bad_request(
                "Direct cache source URL host is not allowed.",
            ));
        }

        let lock_key = format!("{source_hash}:direct:{file_id}");
        let lock = key_lock(&self.locks, &lock_key);
        let _guard = lock.lock().await;

        if let Some(mut entry) = self.load_direct_file_entry(&source_hash, &file_id).await?
            && tokio::fs::metadata(&entry.file_path)
                .await
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        {
            self.refresh_direct_file_entry_access(&mut entry).await?;
            return Ok(direct_file_entry_to_resolved_source(&entry));
        }

        let filename = sanitize_cache_filename(
            &[
                request.filename.as_str(),
                request.selected_file_path.as_str(),
                source_url,
            ]
            .into_iter()
            .find_map(|value| {
                let filename = filename_from_path(value);
                (!filename.trim().is_empty()).then_some(filename)
            })
            .unwrap_or_else(|| format!("{source_hash}-{file_id}.mp4")),
        );
        let output_folder = self.direct_file_output_folder(&source_hash, &file_id);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let final_path = output_folder.join(&filename);
        let temp_path = output_folder.join(format!(".{filename}.download"));
        let temp_cleanup_path = temp_path.clone();
        let mut temp_cleanup = CleanupGuard::new(move || {
            let _ = std::fs::remove_file(temp_cleanup_path);
        });

        let response = self
            .http_client
            .get(source_url)
            .send()
            .await
            .map_err(|error| {
                ApiError::bad_gateway(format!("Direct cache download failed: {error}"))
            })?
            .error_for_status()
            .map_err(|error| {
                ApiError::bad_gateway(format!("Direct cache download failed: {error}"))
            })?;
        let expected_bytes = response.content_length().ok_or_else(|| {
            ApiError::bad_gateway("Direct cache download did not report a file size.")
        })?;
        self.ensure_cache_has_room(expected_bytes, &source_hash)
            .await?;
        let _ = tokio::fs::remove_file(&temp_path).await;
        let mut output = tokio::fs::File::create(&temp_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut downloaded = 0_u64;
        let max_bytes = self.config.local_torrent_max_bytes.max(1);
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            ApiError::bad_gateway(format!("Direct cache download failed: {error}"))
        })? {
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > max_bytes {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(ApiError::bad_gateway(
                    "Direct cache file is larger than the local cache quota.",
                ));
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        output
            .flush()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        drop(output);
        if downloaded == 0 {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(ApiError::bad_gateway("Direct cache download was empty."));
        }
        tokio::fs::rename(&temp_path, &final_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        temp_cleanup.disarm();

        let optimized =
            optimize_playback_cache_file_best_effort(&final_path, &output_folder, &filename).await;

        let mut entry = DirectFileCacheEntry {
            source_hash,
            file_id,
            source_url: source_url.to_owned(),
            filename: optimized.filename,
            selected_file_path: request.selected_file_path,
            file_path: optimized.path.to_string_lossy().to_string(),
            file_length: optimized.file_length,
            updated_at_ms: now_ms(),
        };
        self.refresh_direct_file_entry_access(&mut entry).await?;
        Ok(direct_file_entry_to_resolved_source(&entry))
    }

    pub(crate) async fn try_direct_file_resolved_source(
        &self,
        source_hash: &str,
        file_id: &str,
    ) -> AppResult<Option<LocalTorrentResolvedSource>> {
        let source_hash = normalize_torrent_hash(source_hash);
        let file_id = normalize_direct_file_id(file_id);
        if source_hash.is_empty() || file_id.is_empty() {
            return Ok(None);
        }
        let Some(mut entry) = self.load_direct_file_entry(&source_hash, &file_id).await? else {
            return Ok(None);
        };
        let file_path = PathBuf::from(&entry.file_path);
        let metadata = tokio::fs::metadata(&file_path).await.ok();
        if !metadata
            .as_ref()
            .map(|value| value.is_file() && value.len() > 0)
            .unwrap_or(false)
        {
            return Ok(None);
        }
        entry.file_length = metadata
            .map(|value| value.len())
            .unwrap_or(entry.file_length);
        self.refresh_direct_file_entry_access_best_effort(&mut entry)
            .await;
        Ok(Some(direct_file_entry_to_resolved_source(&entry)))
    }

    pub(crate) async fn create_stream_response(
        &self,
        method: Method,
        headers: HeaderMap,
        source_hash: &str,
        file_id: &str,
    ) -> AppResult<Response<Body>> {
        if method != Method::GET && method != Method::HEAD {
            return Err(ApiError::method_not_allowed("Method not allowed."));
        }
        let (source_hash, file_id) = validate_local_torrent_stream_params(source_hash, file_id)?;
        let lock = key_lock(&self.locks, &source_hash);
        let _guard = lock.lock().await;
        let mut entry = self
            .load_entry(&source_hash, file_id)
            .await?
            .ok_or_else(|| ApiError::not_found("Local torrent stream was not found."))?;
        let session = self.session().await?;
        let output_folder = self.output_folder_for_hash(&source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let resume_request = LocalTorrentResolveRequest {
            info_hash: source_hash.clone(),
            magnet_uri: entry.magnet_uri.clone(),
            preferred_file_index: Some(entry.file_id),
            preferred_filename: entry.filename.clone(),
            fallback_name: entry.file_path.clone(),
        };
        let (handle, _, newly_added) = self
            .prepare_selected_handle(session.clone(), &resume_request, &output_folder)
            .await?;
        let mut pending_handle_cleanup = newly_added
            .then(|| self.pending_handle_cleanup(session, source_hash.clone(), handle.clone()));
        self.refresh_entry_access_best_effort(&mut entry).await;
        let mut stream = handle.clone().stream(file_id).map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent stream failed: {error}"))
        })?;
        let file_size = stream.len().max(entry.file_length);
        let content_type = mime_guess::from_path(&entry.file_path)
            .first_raw()
            .unwrap_or("application/octet-stream")
            .to_owned();

        if let Some(range_header) = headers.get(RANGE).and_then(|value| value.to_str().ok()) {
            let Some((start, end)) = parse_stream_range(range_header, file_size) else {
                let mut response = Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .body(Body::from("Requested range not satisfiable"))
                    .expect("range response");
                response.headers_mut().insert(
                    CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{file_size}")).unwrap(),
                );
                return Ok(response);
            };
            stream.seek(SeekFrom::Start(start)).await.map_err(|error| {
                ApiError::bad_gateway(format!("Local torrent seek failed: {error}"))
            })?;
            let len = end - start + 1;
            let body = if method == Method::HEAD {
                Body::empty()
            } else {
                let active_stream = self.active_stream_guard(&source_hash);
                Body::from_stream(
                    ReaderStream::with_capacity(stream.take(len), 64 * 1024).map(move |chunk| {
                        let _keep_alive = &active_stream;
                        chunk
                    }),
                )
            };
            let mut response = Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .body(body)
                .expect("partial local torrent response");
            apply_stream_headers(&mut response, &content_type, len);
            response.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{file_size}")).unwrap(),
            );
            if let Some(cleanup) = pending_handle_cleanup.as_mut() {
                cleanup.disarm();
            }
            return Ok(response);
        }

        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            let active_stream = self.active_stream_guard(&source_hash);
            Body::from_stream(
                ReaderStream::with_capacity(stream, 64 * 1024).map(move |chunk| {
                    let _keep_alive = &active_stream;
                    chunk
                }),
            )
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(body)
            .expect("local torrent response");
        apply_stream_headers(&mut response, &content_type, file_size);
        if let Some(cleanup) = pending_handle_cleanup.as_mut() {
            cleanup.disarm();
        }
        Ok(response)
    }

    fn active_stream_guard(&self, source_hash: &str) -> ActiveTorrentStreamGuard {
        let count_entry = self
            .active_streams
            .entry(source_hash.to_owned())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)));
        // Increment while the DashMap entry guard still pins this key. The
        // maintenance sweep cannot prune a zero-valued entry between lookup
        // and increment and thereby lose visibility of a live response.
        count_entry.fetch_add(1, Ordering::AcqRel);
        let count = count_entry.clone();
        ActiveTorrentStreamGuard { count }
    }

    fn has_active_stream(&self, source_hash: &str) -> bool {
        self.active_streams
            .get(source_hash)
            .is_some_and(|count| count.load(Ordering::Acquire) > 0)
    }

    pub(crate) async fn create_direct_file_stream_response(
        &self,
        method: Method,
        headers: HeaderMap,
        source_hash: &str,
        file_id: &str,
    ) -> AppResult<Response<Body>> {
        if method != Method::GET && method != Method::HEAD {
            return Err(ApiError::method_not_allowed("Method not allowed."));
        }
        let (source_hash, file_id) = validate_direct_file_stream_params(source_hash, file_id)?;
        let lock_key = format!("{source_hash}:direct:{file_id}");
        let lock = key_lock(&self.locks, &lock_key);
        let _guard = lock.lock().await;
        let mut entry = self
            .load_direct_file_entry(&source_hash, &file_id)
            .await?
            .ok_or_else(|| ApiError::not_found("Cached stream was not found."))?;
        let file_path = PathBuf::from(&entry.file_path);
        if !file_path.starts_with(self.direct_file_output_folder(&source_hash, &file_id)) {
            let _ = self
                .db
                .delete_movie_quick_start_cache(direct_file_cache_key(&source_hash, &file_id))
                .await;
            return Err(ApiError::not_found("Cached stream was not found."));
        }
        let metadata = tokio::fs::metadata(&file_path)
            .await
            .map_err(|_| ApiError::not_found("Cached stream was not found."))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(ApiError::not_found("Cached stream was not found."));
        }
        entry.file_length = metadata.len();
        self.refresh_direct_file_entry_access_best_effort(&mut entry)
            .await;

        let file_size = metadata.len();
        let content_type = mime_guess::from_path(&entry.filename)
            .first_raw()
            .unwrap_or("application/octet-stream")
            .to_owned();

        if let Some(range_header) = headers.get(RANGE).and_then(|value| value.to_str().ok()) {
            let Some((start, end)) = parse_stream_range(range_header, file_size) else {
                let mut response = Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .body(Body::from("Requested range not satisfiable"))
                    .expect("range response");
                response.headers_mut().insert(
                    CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{file_size}")).unwrap(),
                );
                return Ok(response);
            };
            let mut file = tokio::fs::File::open(&file_path)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            file.seek(SeekFrom::Start(start))
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            let len = end - start + 1;
            let body = if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from_stream(ReaderStream::with_capacity(file.take(len), 64 * 1024))
            };
            let mut response = Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .body(body)
                .expect("partial cached file response");
            apply_stream_headers(&mut response, &content_type, len);
            response.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{file_size}")).unwrap(),
            );
            return Ok(response);
        }

        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            let file = tokio::fs::File::open(&file_path)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024))
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(body)
            .expect("cached file response");
        apply_stream_headers(&mut response, &content_type, file_size);
        Ok(response)
    }

    async fn session(&self) -> AppResult<Arc<Session>> {
        self.session
            .get_or_try_init(|| async {
                tokio::fs::create_dir_all(&self.config.local_torrent_cache_dir)
                    .await
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                let session_persistence_folder =
                    self.config.local_torrent_cache_dir.join(".session");
                let upload_bps =
                    crate::config::local_torrent_upload_bps().and_then(NonZeroU32::new);
                let options = SessionOptions {
                    disable_dht: false,
                    // Keep the DHT routing table across restarts so the first
                    // resolve after a server bounce doesn't rebuild peer
                    // discovery from zero.
                    disable_dht_persistence: false,
                    // Restore in-progress torrents quickly after restart using
                    // piece bitfields written under `.session/`.
                    fastresume: true,
                    persistence: Some(librqbit::SessionPersistenceConfig::Json {
                        folder: Some(session_persistence_folder),
                    }),
                    // Accept inbound peer connections (in addition to outbound)
                    // so well-connected peers can reach us too. UPnP stays off;
                    // forward the port on the router for full effect.
                    listen_port_range: self.config.local_torrent_listen_port_range.clone(),
                    enable_upnp_port_forwarding: false,
                    // The primary candidate and one bounded hedge initialize in
                    // parallel; cancellation cleanup removes loser handles.
                    concurrent_init_limit: Some(2),
                    // Give cold swarms longer to establish peer sockets while
                    // metadata is still being fetched.
                    peer_opts: Some(PeerConnectionOptions {
                        connect_timeout: Some(Duration::from_secs(20)),
                        read_write_timeout: Some(Duration::from_secs(20)),
                        keep_alive_interval: None,
                    }),
                    trackers: session_tracker_urls(),
                    // Contribute enough upload bandwidth for swarm reciprocity
                    // without monopolizing the home uplink used for playback.
                    // A configured zero keeps the original no-upload mode.
                    ratelimits: LimitsConfig {
                        upload_bps,
                        download_bps: None,
                    },
                    disable_upload: upload_bps.is_none(),
                    ..Default::default()
                };
                Session::new_with_opts(self.config.local_torrent_cache_dir.clone(), options)
                    .await
                    .map_err(|error| {
                        ApiError::bad_gateway(format!(
                            "Local torrent engine failed to start: {error}"
                        ))
                    })
            })
            .await
            .cloned()
    }

    async fn prepare_selected_handle(
        &self,
        session: Arc<Session>,
        request: &LocalTorrentResolveRequest,
        output_folder: &Path,
    ) -> AppResult<(Arc<ManagedTorrent>, LocalTorrentFileCandidate, bool)> {
        let source_hash = normalize_torrent_hash(&request.info_hash);
        let (handle, preselected, newly_added) =
            if let Some(existing) = self.handles.get(&source_hash) {
                (existing.clone(), None, false)
            } else {
                self.add_paused_torrent_handle(
                    session.clone(),
                    &source_hash,
                    &request.magnet_uri,
                    output_folder,
                    request,
                )
                .await?
            };

        let mut pending_handle_cleanup = newly_added.then(|| {
            self.pending_handle_cleanup(session.clone(), source_hash.clone(), handle.clone())
        });

        timeout(
            Duration::from_millis(self.config.local_torrent_ready_timeout_ms),
            handle.wait_until_initialized(),
        )
        .await
        .map_err(|_| ApiError::gateway_timeout("Local torrent initialization timed out."))?
        .map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent initialization failed: {error}"))
        })?;

        let selected = match preselected {
            Some(selected) => selected,
            None => select_torrent_file(self.file_candidates(&handle)?, request)?,
        };

        self.ensure_cache_has_room(selected.length, &source_hash)
            .await?;
        self.cleanup_unselected_placeholders(output_folder, &selected.path)
            .await;

        let selected_files = HashSet::from([selected.file_id]);
        if handle.only_files().as_deref() != Some(&[selected.file_id]) {
            session
                .update_only_files(&handle, &selected_files)
                .await
                .map_err(|error| {
                    ApiError::bad_gateway(format!("Local torrent file selection failed: {error}"))
                })?;
        }
        if handle.is_paused() {
            session.unpause(&handle).await.map_err(|error| {
                ApiError::bad_gateway(format!("Local torrent start failed: {error}"))
            })?;
        }

        self.persist_handle_metainfo(&handle, output_folder).await;
        self.handles.insert(source_hash, handle.clone());
        if let Some(cleanup) = pending_handle_cleanup.as_mut() {
            cleanup.disarm();
        }
        Ok((handle, selected, newly_added))
    }

    fn pending_handle_cleanup(
        &self,
        session: Arc<Session>,
        source_hash: String,
        handle: Arc<ManagedTorrent>,
    ) -> PendingTorrentCleanup {
        let handles = self.handles.clone();
        let pending_deletions = self.pending_handle_deletions.clone();
        let handle_id = handle.id();
        CleanupGuard::new(Box::new(move || {
            let pending = Arc::new(PendingTorrentDeletion {
                done: Notify::new(),
            });
            pending_deletions.insert(source_hash.clone(), pending.clone());
            let should_remove = handles
                .get(&source_hash)
                .is_some_and(|current| current.id() == handle_id);
            if should_remove {
                handles.remove(&source_hash);
            }
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if let Ok(id_or_hash) = TorrentIdOrHash::parse(&source_hash)
                        && let Some(current) = session.get(id_or_hash)
                        && current.id() == handle_id
                    {
                        let _ = session.delete(id_or_hash, false).await;
                    }
                    let should_remove = pending_deletions
                        .get(&source_hash)
                        .is_some_and(|current| Arc::ptr_eq(current.value(), &pending));
                    if should_remove {
                        pending_deletions.remove(&source_hash);
                    }
                    pending.done.notify_one();
                });
            } else {
                pending_deletions.remove(&source_hash);
                pending.done.notify_one();
            }
        }))
    }

    async fn add_paused_torrent_handle(
        &self,
        session: Arc<Session>,
        source_hash: &str,
        magnet_uri: &str,
        output_folder: &Path,
        request: &LocalTorrentResolveRequest,
    ) -> AppResult<(Arc<ManagedTorrent>, Option<LocalTorrentFileCandidate>, bool)> {
        while let Some(pending) = self
            .pending_handle_deletions
            .get(source_hash)
            .map(|entry| entry.clone())
        {
            pending.done.notified().await;
        }
        if let Ok(id_or_hash) = TorrentIdOrHash::parse(source_hash)
            && let Some(handle) = session.get(id_or_hash)
        {
            return Ok((handle, None, false));
        }

        // Metadata discovery is deliberately list-only. It can race the
        // public cache against DHT/peer magnet discovery without inserting a
        // half-initialized managed torrent if the losing future is cancelled.
        let listed = timeout(
            Duration::from_millis(self.config.local_torrent_metadata_timeout_ms),
            self.load_torrent_metadata(session.clone(), source_hash, magnet_uri, output_folder),
        )
        .await
        .map_err(|_| {
            ApiError::gateway_timeout(
                "Selected torrent did not start in time (no metadata from peers). Try another source.",
            )
        })??;

        let files = file_candidates_from_listed_metainfo(&listed)?;
        let selected = select_torrent_file(files, request)?;
        // Reserve cache capacity before librqbit creates the selected file.
        // Passing only_files on the first managed add also prevents a season
        // pack from allocating sparse logical-length files for every episode.
        self.ensure_cache_has_room(selected.length, source_hash)
            .await?;
        self.cleanup_unselected_placeholders(output_folder, &selected.path)
            .await;

        let response = self
            .add_selected_torrent(
                session.clone(),
                source_hash,
                output_folder,
                listed.torrent_bytes.to_vec(),
                selected.file_id,
            )
            .await?;
        match response {
            AddTorrentResponse::Added(_, handle)
            | AddTorrentResponse::AlreadyManaged(_, handle) => {
                if handle.info_hash().as_string() != source_hash {
                    let handle_id = handle.id();
                    return Err(ApiError::bad_gateway(format!(
                        "Local torrent add collided with another managed handle ({handle_id})."
                    )));
                }
                Ok((handle, Some(selected), true))
            }
            AddTorrentResponse::ListOnly(_) => Err(ApiError::bad_gateway(
                "Local torrent handle was not created.",
            )),
        }
    }

    async fn load_torrent_metadata(
        &self,
        session: Arc<Session>,
        source_hash: &str,
        magnet_uri: &str,
        output_folder: &Path,
    ) -> AppResult<ListOnlyResponse> {
        if let Some(bytes) = self.load_metainfo_bytes(output_folder).await {
            match self
                .list_metainfo_bytes(session.clone(), bytes, output_folder)
                .await
            {
                Ok(listed) if listed.info_hash.as_string() == source_hash => return Ok(listed),
                Ok(listed) => tracing::warn!(
                    expected_hash = source_hash,
                    actual_hash = %listed.info_hash.as_string(),
                    "discarding persisted torrent metainfo with a mismatched info hash"
                ),
                Err(error) => tracing::warn!(
                    error = ?error,
                    source_hash,
                    "discarding invalid persisted torrent metainfo"
                ),
            }
            let _ = tokio::fs::remove_file(Self::metainfo_path(output_folder)).await;
        }

        let magnet_list = session.add_torrent(
            AddTorrent::from_url(magnet_uri.to_owned()),
            Some(local_torrent_list_options(output_folder)),
        );
        let metainfo_fetch = self.fetch_metainfo_bytes(source_hash);
        tokio::pin!(magnet_list);
        tokio::pin!(metainfo_fetch);

        let listed = tokio::select! {
            result = &mut magnet_list => {
                match listed_metainfo_response(result) {
                    Ok(listed) if listed.info_hash.as_string() == source_hash => Ok(listed),
                    Ok(listed) => {
                        tracing::warn!(
                            expected_hash = source_hash,
                            actual_hash = %listed.info_hash.as_string(),
                            "magnet metadata did not match; waiting for public metainfo cache"
                        );
                        match metainfo_fetch.await {
                            Some(bytes) => self.list_metainfo_bytes(session.clone(), bytes, output_folder).await,
                            None => Ok(listed),
                        }
                    }
                    Err(magnet_error) => {
                        tracing::warn!(
                            error = ?magnet_error,
                            source_hash,
                            "magnet metadata failed; waiting for public metainfo cache"
                        );
                        match metainfo_fetch.await {
                            Some(bytes) => self.list_metainfo_bytes(session.clone(), bytes, output_folder).await,
                            None => Err(magnet_error),
                        }
                    }
                }
            },
            maybe_bytes = &mut metainfo_fetch => {
                if let Some(bytes) = maybe_bytes {
                    match self.list_metainfo_bytes(session.clone(), bytes, output_folder).await {
                        Ok(listed) if listed.info_hash.as_string() == source_hash => Ok(listed),
                        Ok(listed) => {
                            tracing::warn!(
                                expected_hash = source_hash,
                                actual_hash = %listed.info_hash.as_string(),
                                "public torrent metainfo cache returned the wrong info hash"
                            );
                            listed_metainfo_response(magnet_list.await)
                        }
                        Err(error) => {
                            tracing::warn!(
                                error = ?error,
                                source_hash,
                                "public torrent metainfo cache returned invalid data; waiting for magnet metadata"
                            );
                            listed_metainfo_response(magnet_list.await)
                        }
                    }
                } else {
                    listed_metainfo_response(magnet_list.await)
                }
            }
        }?;
        if listed.info_hash.as_string() != source_hash {
            return Err(ApiError::bad_gateway(
                "Local torrent metadata did not match the requested info hash.",
            ));
        }
        self.persist_metainfo_bytes(output_folder, &listed.torrent_bytes)
            .await;
        Ok(listed)
    }

    async fn list_metainfo_bytes(
        &self,
        session: Arc<Session>,
        bytes: Vec<u8>,
        output_folder: &Path,
    ) -> AppResult<ListOnlyResponse> {
        listed_metainfo_response(
            session
                .add_torrent(
                    AddTorrent::from_bytes(bytes),
                    Some(local_torrent_list_options(output_folder)),
                )
                .await,
        )
    }

    async fn add_selected_torrent(
        &self,
        session: Arc<Session>,
        source_hash: &str,
        output_folder: &Path,
        torrent_bytes: Vec<u8>,
        selected_file_id: usize,
    ) -> AppResult<AddTorrentResponse> {
        // librqbit's JSON persistence chooses the next numeric ID before its
        // torrent DB write lock. Serialize only the short managed-add phase so
        // two different hashes cannot be mistaken for AlreadyManaged by ID;
        // metadata discovery and torrent initialization remain concurrent.
        let managed_add_guard = self.managed_add_lock.clone().lock_owned().await;
        let pending = Arc::new(PendingTorrentDeletion {
            done: Notify::new(),
        });
        self.pending_handle_deletions
            .insert(source_hash.to_owned(), pending.clone());

        // add_torrent inserts into the session before its final persistence
        // await. If this resolve is cancelled in that small window, remove the
        // partially-created handle and keep later resolves behind the barrier
        // until deletion has completed.
        let cleanup_session = session.clone();
        let cleanup_hash = source_hash.to_owned();
        let cleanup_pending = pending.clone();
        let pending_deletions = self.pending_handle_deletions.clone();
        let mut cleanup = CleanupGuard::new(Box::new(move || {
            // `add_torrent` can be cancelled after librqbit reserves an
            // in-memory numeric ID but before JSON persistence records it.
            // Transfer the owned add lock into cleanup so another hash cannot
            // reuse that ID until the cancelled handle is gone.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let cleanup = async move {
                    tokio::task::yield_now().await;
                    if let Ok(id_or_hash) = TorrentIdOrHash::parse(&cleanup_hash)
                        && cleanup_session.get(id_or_hash).is_some()
                    {
                        let _ = cleanup_session.delete(id_or_hash, false).await;
                    }
                    let should_remove = pending_deletions
                        .get(&cleanup_hash)
                        .is_some_and(|current| Arc::ptr_eq(current.value(), &cleanup_pending));
                    if should_remove {
                        pending_deletions.remove(&cleanup_hash);
                    }
                    cleanup_pending.done.notify_one();
                };
                spawn_cleanup_holding_managed_add_lock(runtime, managed_add_guard, cleanup);
            } else {
                drop(managed_add_guard);
                pending_deletions.remove(&cleanup_hash);
                cleanup_pending.done.notify_one();
            }
        }) as Box<dyn FnOnce() + Send>);

        let response = session
            .add_torrent(
                AddTorrent::from_bytes(torrent_bytes),
                Some(local_torrent_add_options(
                    output_folder,
                    true,
                    Some(selected_file_id),
                )),
            )
            .await
            .map_err(|error| ApiError::bad_gateway(format!("Local torrent add failed: {error}")))?;
        cleanup.disarm();
        let should_remove = self
            .pending_handle_deletions
            .get(source_hash)
            .is_some_and(|current| Arc::ptr_eq(current.value(), &pending));
        if should_remove {
            self.pending_handle_deletions.remove(source_hash);
        }
        pending.done.notify_one();
        Ok(response)
    }

    fn file_candidates(
        &self,
        handle: &ManagedTorrent,
    ) -> AppResult<Vec<LocalTorrentFileCandidate>> {
        handle
            .with_metadata(|metadata| {
                metadata
                    .info
                    .iter_file_details()
                    .map_err(|error| error.to_string())
                    .and_then(|files| {
                        files
                            .enumerate()
                            .map(|(file_id, details)| {
                                Ok(LocalTorrentFileCandidate {
                                    file_id,
                                    path: details
                                        .filename
                                        .to_string()
                                        .unwrap_or_else(|_| format!("file-{file_id}")),
                                    length: details.len,
                                })
                            })
                            .collect()
                    })
            })
            .map_err(|error| {
                ApiError::bad_gateway(format!("Local torrent file list failed: {error}"))
            })?
            .map_err(|error| {
                ApiError::bad_gateway(format!("Local torrent file list failed: {error}"))
            })
    }

    fn metainfo_path(output_folder: &Path) -> PathBuf {
        output_folder.join(LOCAL_TORRENT_METAINFO_FILENAME)
    }

    async fn load_metainfo_bytes(&self, output_folder: &Path) -> Option<Vec<u8>> {
        let path = Self::metainfo_path(output_folder);
        let bytes = tokio::fs::read(&path).await.ok()?;
        if looks_like_torrent_metainfo(&bytes) {
            Some(bytes)
        } else {
            let _ = tokio::fs::remove_file(&path).await;
            None
        }
    }

    async fn persist_metainfo_bytes(&self, output_folder: &Path, bytes: &[u8]) {
        if !looks_like_torrent_metainfo(bytes) {
            return;
        }
        if let Err(error) = tokio::fs::create_dir_all(output_folder).await {
            tracing::warn!(
                error = %error,
                path = %output_folder.display(),
                "failed to create local torrent folder for metainfo"
            );
            return;
        }
        let path = Self::metainfo_path(output_folder);
        let tmp = path.with_extension("torrent.tmp");
        if let Err(error) = tokio::fs::write(&tmp, bytes).await {
            tracing::warn!(
                error = %error,
                path = %tmp.display(),
                "failed to write local torrent metainfo"
            );
            return;
        }
        if let Err(error) = tokio::fs::rename(&tmp, &path).await {
            tracing::warn!(
                error = %error,
                path = %path.display(),
                "failed to persist local torrent metainfo"
            );
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }

    async fn fetch_metainfo_bytes(&self, source_hash: &str) -> Option<Vec<u8>> {
        let hash = normalize_torrent_hash(source_hash);
        if hash.len() != 40 {
            return None;
        }
        // Hardcoded public metainfo cache — not user-controlled (no SSRF).
        let url = format!("https://itorrents.org/torrent/{hash}.torrent");
        let response = timeout(
            LOCAL_TORRENT_METAINFO_FETCH_TIMEOUT,
            self.http_client.get(url).send(),
        )
        .await
        .ok()?
        .ok()?;
        if !response.status().is_success() {
            return None;
        }
        if response
            .content_length()
            .is_some_and(|length| length > LOCAL_TORRENT_METAINFO_MAX_BYTES as u64)
        {
            return None;
        }
        let bytes = timeout(LOCAL_TORRENT_METAINFO_FETCH_TIMEOUT, async move {
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.ok()?;
                if bytes.len().saturating_add(chunk.len()) > LOCAL_TORRENT_METAINFO_MAX_BYTES {
                    return None;
                }
                bytes.extend_from_slice(&chunk);
            }
            Some(bytes)
        })
        .await
        .ok()??;
        if looks_like_torrent_metainfo(&bytes) {
            Some(bytes)
        } else {
            None
        }
    }

    async fn persist_handle_metainfo(&self, handle: &ManagedTorrent, output_folder: &Path) {
        let Ok(bytes) = handle.with_metadata(|metadata| metadata.torrent_bytes.to_vec()) else {
            return;
        };
        self.persist_metainfo_bytes(output_folder, &bytes).await;
    }

    async fn cleanup_unselected_placeholders(&self, output_folder: &Path, keep_relative: &str) {
        let keep_path = output_folder.join(keep_relative);
        let Ok(mut stack) = tokio::fs::read_dir(output_folder).await else {
            return;
        };
        let mut pending = vec![];
        while let Ok(Some(entry)) = stack.next_entry().await {
            pending.push(entry.path());
        }
        while let Some(path) = pending.pop() {
            let Ok(metadata) = tokio::fs::metadata(&path).await else {
                continue;
            };
            if metadata.is_dir() {
                if let Ok(mut child) = tokio::fs::read_dir(&path).await {
                    while let Ok(Some(entry)) = child.next_entry().await {
                        pending.push(entry.path());
                    }
                }
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name == LOCAL_TORRENT_ACCESS_MARKER || name == LOCAL_TORRENT_METAINFO_FILENAME {
                continue;
            }
            if path == keep_path {
                continue;
            }
            // Only remove empty placeholders. Non-empty siblings (partial
            // downloads of other titles in a pack) are left alone.
            if metadata.len() == 0 {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }

    async fn wait_for_startup_probe(
        &self,
        handle: Arc<ManagedTorrent>,
        file_id: usize,
    ) -> AppResult<()> {
        let mut stream = handle.stream(file_id).map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent stream failed: {error}"))
        })?;
        let target_bytes = stream.len().min(LOCAL_TORRENT_STARTUP_PROBE_BYTES as u64) as usize;
        if target_bytes == 0 {
            return Err(ApiError::bad_gateway("Local torrent file was empty."));
        }
        let read_result = timeout(
            Duration::from_millis(self.config.local_torrent_ready_timeout_ms),
            read_startup_probe(&mut stream, target_bytes),
        )
        .await
        .map_err(|_| ApiError::gateway_timeout("Local torrent startup buffer was not ready."))?;
        match read_result {
            Ok(count) if count >= target_bytes => Ok(()),
            Ok(_) => Err(ApiError::bad_gateway(
                "Local torrent startup buffer ended unexpectedly.",
            )),
            Err(error) => Err(ApiError::bad_gateway(format!(
                "Local torrent startup buffer failed: {error}"
            ))),
        }
    }

    async fn persist_entry(&self, entry: &LocalTorrentCacheEntry) -> AppResult<()> {
        self.db
            .set_movie_quick_start_cache(
                local_torrent_cache_key(&entry.source_hash, entry.file_id),
                serde_json::to_value(entry).unwrap_or_else(|_| json!({})),
                now_ms() + LOCAL_TORRENT_RECENT_RETENTION_MS,
            )
            .await
    }

    async fn refresh_entry_access(&self, entry: &mut LocalTorrentCacheEntry) -> AppResult<()> {
        entry.updated_at_ms = now_ms();
        self.persist_entry(entry).await?;
        let _ = self.touch_access_marker(entry).await;
        Ok(())
    }

    async fn refresh_entry_access_best_effort(&self, entry: &mut LocalTorrentCacheEntry) {
        let _ = self.refresh_entry_access(entry).await;
    }

    async fn persist_direct_file_entry(&self, entry: &DirectFileCacheEntry) -> AppResult<()> {
        self.db
            .set_movie_quick_start_cache(
                direct_file_cache_key(&entry.source_hash, &entry.file_id),
                serde_json::to_value(entry).unwrap_or_else(|_| json!({})),
                now_ms() + LOCAL_TORRENT_RECENT_RETENTION_MS,
            )
            .await
    }

    async fn refresh_direct_file_entry_access(
        &self,
        entry: &mut DirectFileCacheEntry,
    ) -> AppResult<()> {
        entry.updated_at_ms = now_ms();
        self.persist_direct_file_entry(entry).await?;
        let _ = self.touch_direct_file_access_marker(entry).await;
        Ok(())
    }

    async fn refresh_direct_file_entry_access_best_effort(&self, entry: &mut DirectFileCacheEntry) {
        let _ = self.refresh_direct_file_entry_access(entry).await;
    }

    async fn touch_access_marker(&self, entry: &LocalTorrentCacheEntry) -> AppResult<()> {
        let output_folder = self.output_folder_for_hash(&entry.source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        tokio::fs::write(
            output_folder.join(LOCAL_TORRENT_ACCESS_MARKER),
            entry.updated_at_ms.to_string(),
        )
        .await
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    async fn touch_direct_file_access_marker(&self, entry: &DirectFileCacheEntry) -> AppResult<()> {
        let output_folder = self.output_folder_for_hash(&entry.source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        tokio::fs::write(
            output_folder.join(LOCAL_TORRENT_ACCESS_MARKER),
            entry.updated_at_ms.to_string(),
        )
        .await
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    async fn load_entry(
        &self,
        source_hash: &str,
        file_id: usize,
    ) -> AppResult<Option<LocalTorrentCacheEntry>> {
        let cache_key = local_torrent_cache_key(source_hash, file_id);
        let Some((payload, _)) = self
            .db
            .get_movie_quick_start_cache(cache_key.clone())
            .await?
        else {
            return Ok(None);
        };
        let Ok(mut entry) = serde_json::from_value::<LocalTorrentCacheEntry>(payload) else {
            let _ = self.db.delete_movie_quick_start_cache(cache_key).await;
            return Ok(None);
        };
        entry.source_hash = normalize_torrent_hash(&entry.source_hash);
        if entry.source_hash != source_hash
            || entry.file_id != file_id
            || entry.magnet_uri.is_empty()
        {
            let _ = self.db.delete_movie_quick_start_cache(cache_key).await;
            return Ok(None);
        }
        Ok(Some(entry))
    }

    async fn load_direct_file_entry(
        &self,
        source_hash: &str,
        file_id: &str,
    ) -> AppResult<Option<DirectFileCacheEntry>> {
        let cache_key = direct_file_cache_key(source_hash, file_id);
        let Some((payload, _)) = self
            .db
            .get_movie_quick_start_cache(cache_key.clone())
            .await?
        else {
            return Ok(None);
        };
        let Ok(mut entry) = serde_json::from_value::<DirectFileCacheEntry>(payload) else {
            let _ = self.db.delete_movie_quick_start_cache(cache_key).await;
            return Ok(None);
        };
        entry.source_hash = normalize_torrent_hash(&entry.source_hash);
        entry.file_id = normalize_direct_file_id(&entry.file_id);
        if entry.source_hash != source_hash
            || entry.file_id != file_id
            || entry.file_path.trim().is_empty()
        {
            let _ = self.db.delete_movie_quick_start_cache(cache_key).await;
            return Ok(None);
        }
        Ok(Some(entry))
    }

    async fn ensure_cache_has_room(&self, required_bytes: u64, keep_hash: &str) -> AppResult<()> {
        let max_bytes = self.config.local_torrent_max_bytes.max(1);
        if required_bytes > max_bytes {
            return Err(ApiError::bad_gateway(
                "Local torrent file is larger than the local torrent cache quota.",
            ));
        }
        tokio::fs::create_dir_all(&self.config.local_torrent_cache_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let cache_dir = self.config.local_torrent_cache_dir.clone();
        let keep_dir = self.output_folder_for_hash(keep_hash);
        let initial_keep_bytes = dir_size_blocking(keep_dir).await.unwrap_or_default();
        let initial_used_bytes = dir_size_blocking(cache_dir.clone()).await?;
        if initial_used_bytes
            .saturating_sub(initial_keep_bytes)
            .saturating_add(required_bytes)
            <= max_bytes
        {
            return Ok(());
        }
        if let Some(session) = self.session.get().cloned() {
            // Under actual quota pressure, retire stale inactive handles
            // before selecting cache directories to evict. Freshly resolved
            // URLs retain their grace window until the first stream arrives.
            self.maintain_idle_handles(session, Some(keep_hash)).await;
        }
        let existing_keep_bytes = dir_size_blocking(self.output_folder_for_hash(keep_hash))
            .await
            .unwrap_or_default();
        self.prune_cache(keep_hash, required_bytes, existing_keep_bytes)
            .await?;
        let used_bytes = dir_size_blocking(cache_dir.clone()).await?;
        let existing_keep_bytes = dir_size_blocking(self.output_folder_for_hash(keep_hash))
            .await
            .unwrap_or_default();
        if used_bytes
            .saturating_sub(existing_keep_bytes)
            .saturating_add(required_bytes)
            > max_bytes
        {
            return Err(ApiError::bad_gateway(
                "Local torrent disk quota is full. Clear cache or raise LOCAL_TORRENT_MAX_BYTES.",
            ));
        }
        Ok(())
    }

    async fn prune_cache(
        &self,
        keep_hash: &str,
        required_bytes: u64,
        existing_keep_bytes: u64,
    ) -> AppResult<()> {
        let cache_dir = self.config.local_torrent_cache_dir.clone();
        let max_bytes = self.config.local_torrent_max_bytes.max(1);
        let target_total =
            max_bytes.saturating_sub(required_bytes.saturating_sub(existing_keep_bytes));
        // Protect everything still owned by librqbit, including restored
        // session torrents that have not yet been copied into `self.handles`.
        // The quota pre-pass retires inactive handles first; what remains is
        // either busy, actively streamed, or failed safe during deletion.
        let mut active_hashes = self.session.get().map_or_else(HashSet::new, |session| {
            session.with_torrents(|torrents| {
                torrents
                    .map(|(_, handle)| handle.info_hash().as_string())
                    .collect::<HashSet<_>>()
            })
        });
        active_hashes.extend(self.handles.iter().map(|entry| entry.key().clone()));
        active_hashes.insert(keep_hash.to_owned());
        tokio::task::spawn_blocking(move || {
            let entries = collect_cache_dir_entries(&cache_dir)?;
            let mut total = entries.iter().map(|entry| entry.size).sum::<u64>();
            let stale_cutoff_ms = now_ms().saturating_sub(LOCAL_TORRENT_RECENT_RETENTION_MS);
            let mut retained = Vec::new();
            for entry in entries {
                if entry.modified_ms <= stale_cutoff_ms && !active_hashes.contains(&entry.name) {
                    if fs::remove_dir_all(&entry.path).is_ok() {
                        total = total.saturating_sub(entry.size);
                    }
                    continue;
                }
                retained.push(entry);
            }
            if total <= target_total {
                return Ok::<(), std::io::Error>(());
            }
            retained.sort_by_key(|entry| entry.modified_ms);
            for entry in retained {
                if total <= target_total {
                    break;
                }
                if active_hashes.contains(&entry.name) {
                    continue;
                }
                if fs::remove_dir_all(&entry.path).is_ok() {
                    total = total.saturating_sub(entry.size);
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
    }

    fn output_folder_for_hash(&self, source_hash: &str) -> PathBuf {
        self.config
            .local_torrent_cache_dir
            .join(normalize_torrent_hash(source_hash))
    }

    fn direct_file_output_folder(&self, source_hash: &str, file_id: &str) -> PathBuf {
        self.output_folder_for_hash(source_hash)
            .join(DIRECT_FILE_CACHE_FOLDER)
            .join(normalize_direct_file_id(file_id))
    }
}

impl LocalTorrentService {
    /// Stop completed torrents from seeding indefinitely once bounded uploads
    /// are enabled. A later playback request transparently unpauses its handle.
    pub async fn pause_finished_handles(&self) -> usize {
        let Some(session) = self.session.get().cloned() else {
            return 0;
        };
        self.maintain_idle_handles(session, None).await
    }

    async fn maintain_idle_handles(&self, session: Arc<Session>, skip_hash: Option<&str>) -> usize {
        let handles = session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| handle.clone())
                .collect::<Vec<_>>()
        });
        let mut paused = 0;
        for handle in handles {
            let source_hash = handle.info_hash().as_string();
            if skip_hash == Some(source_hash.as_str()) {
                continue;
            }
            if self.pending_handle_deletions.contains_key(&source_hash) {
                continue;
            }
            let lock = key_lock(&self.locks, &source_hash);
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            if self.has_active_stream(&source_hash) {
                continue;
            }
            let Some(current) = session
                .get(TorrentIdOrHash::Hash(handle.info_hash()))
                .filter(|current| current.id() == handle.id())
            else {
                continue;
            };
            let finished = current.stats().finished;
            let recently_accessed = self.was_torrent_recently_accessed(&source_hash).await;
            // Keep an incomplete torrent alive while it is recent; a resolve
            // in progress also owns the hash lock, so it never reaches here.
            // Once idle, retire it just like a completed handle so dead swarms
            // cannot download or pin quota indefinitely.
            if !finished && recently_accessed {
                continue;
            }
            if !current.is_paused() {
                match session.pause(&current).await {
                    Ok(()) => paused += 1,
                    Err(error) => {
                        tracing::warn!(
                            error = %error,
                            torrent_id = current.id(),
                            "failed to pause idle local torrent"
                        );
                        continue;
                    }
                }
            }

            if recently_accessed || self.has_active_stream(&source_hash) {
                continue;
            }
            if let Err(error) = session
                .delete(TorrentIdOrHash::Id(current.id()), false)
                .await
            {
                tracing::warn!(
                    error = %error,
                    torrent_id = current.id(),
                    "failed to retire idle local torrent"
                );
                continue;
            }
            let should_remove = self
                .handles
                .get(&source_hash)
                .is_some_and(|stored| stored.id() == current.id());
            if should_remove {
                self.handles.remove(&source_hash);
            }
        }
        paused
    }

    async fn was_torrent_recently_accessed(&self, source_hash: &str) -> bool {
        let marker = self
            .output_folder_for_hash(source_hash)
            .join(LOCAL_TORRENT_ACCESS_MARKER);
        tokio::fs::read_to_string(marker)
            .await
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .is_some_and(|accessed_ms| {
                now_ms().saturating_sub(accessed_ms) < LOCAL_TORRENT_FINISHED_HANDLE_GRACE_MS
            })
    }

    /// Drop per-hash lock entries that no active resolve/stream is holding so
    /// the lock table does not grow unbounded over the process lifetime.
    pub fn prune_idle_locks(&self) {
        self.locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        self.active_streams
            .retain(|_, count| count.load(Ordering::Acquire) > 0);
    }
}

fn validate_local_torrent_stream_params(
    source_hash: &str,
    file_id: &str,
) -> AppResult<(String, usize)> {
    let source_hash = normalize_torrent_hash(source_hash);
    if source_hash.is_empty() {
        return Err(ApiError::bad_request("Invalid local torrent sourceHash."));
    }
    let file_id = file_id
        .trim()
        .parse::<usize>()
        .map_err(|_| ApiError::bad_request("Invalid local torrent fileId."))?;
    Ok((source_hash, file_id))
}

fn validate_direct_file_stream_params(
    source_hash: &str,
    file_id: &str,
) -> AppResult<(String, String)> {
    let source_hash = normalize_torrent_hash(source_hash);
    if source_hash.is_empty() {
        return Err(ApiError::bad_request("Invalid cached stream sourceHash."));
    }
    let file_id = normalize_direct_file_id(file_id);
    if file_id.is_empty() {
        return Err(ApiError::bad_request("Invalid cached stream fileId."));
    }
    Ok((source_hash, file_id))
}

fn pick_local_torrent_video_file(
    files: &[LocalTorrentFileCandidate],
    preferred_filename: &str,
    fallback_name: &str,
) -> Option<LocalTorrentFileCandidate> {
    let payload = files
        .iter()
        .map(|file| {
            json!({
                "id": file.file_id,
                "path": file.path,
                "bytes": file.length
            })
        })
        .collect::<Vec<Value>>();
    let selected_id = pick_video_file_ids(&payload, preferred_filename, fallback_name)
        .first()
        .and_then(|value| usize::try_from(*value).ok())?;
    files
        .iter()
        .find(|file| file.file_id == selected_id)
        .cloned()
}

fn select_torrent_file(
    files: Vec<LocalTorrentFileCandidate>,
    request: &LocalTorrentResolveRequest,
) -> AppResult<LocalTorrentFileCandidate> {
    let exact_selected = request
        .preferred_file_index
        .and_then(|file_id| files.iter().find(|file| file.file_id == file_id))
        .filter(|file| is_supported_local_torrent_video_file(file))
        .cloned();
    let heuristic_selected =
        pick_local_torrent_video_file(&files, &request.preferred_filename, &request.fallback_name);
    let selected = match (exact_selected, heuristic_selected) {
        (Some(exact), Some(heuristic)) if exact.file_id != heuristic.file_id => {
            let filename_hint = request.preferred_filename.trim();
            if !filename_hint.is_empty() && media_filename_hint_matches(&exact.path, filename_hint)
            {
                Some(exact)
            } else if contains_episode_hint(&request.fallback_name)
                || (!filename_hint.is_empty()
                    && media_filename_hint_matches(&heuristic.path, filename_hint))
            {
                // fileIdx can be stale in cached addon results. Prefer the
                // metadata/name match when the requested episode or exact
                // behaviorHints filename points at another video.
                Some(heuristic)
            } else {
                Some(exact)
            }
        }
        (Some(exact), _) => Some(exact),
        (None, heuristic) => heuristic,
    };
    selected.ok_or_else(|| ApiError::internal("No supported video file was found in this torrent."))
}

static EPISODE_HINT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(?:^|[^a-z0-9])(?:s\d{1,3}e\d{1,3}|\d{1,3}x\d{1,3})(?:[^a-z0-9]|$)")
        .expect("valid episode hint regex")
});

fn contains_episode_hint(value: &str) -> bool {
    EPISODE_HINT_RE.is_match(value)
}

fn media_filename_hint_matches(path: &str, hint: &str) -> bool {
    fn normalized(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }

    let path = normalized(path);
    let hint = normalized(hint);
    !hint.is_empty() && (path.contains(&hint) || hint.contains(&path))
}

fn file_candidates_from_listed_metainfo(
    listed: &ListOnlyResponse,
) -> AppResult<Vec<LocalTorrentFileCandidate>> {
    listed
        .info
        .iter_file_details()
        .map_err(|error| ApiError::bad_gateway(format!("Local torrent file list failed: {error}")))?
        .enumerate()
        .map(|(file_id, details)| {
            Ok(LocalTorrentFileCandidate {
                file_id,
                path: details
                    .filename
                    .to_string()
                    .unwrap_or_else(|_| format!("file-{file_id}")),
                length: details.len,
            })
        })
        .collect()
}

fn listed_metainfo_response<E: std::fmt::Display>(
    response: Result<AddTorrentResponse, E>,
) -> AppResult<ListOnlyResponse> {
    match response
        .map_err(|error| ApiError::bad_gateway(format!("Local torrent metadata failed: {error}")))?
    {
        AddTorrentResponse::ListOnly(listed) => Ok(listed),
        AddTorrentResponse::Added(_, _) | AddTorrentResponse::AlreadyManaged(_, _) => Err(
            ApiError::bad_gateway("Local torrent metadata request unexpectedly created a handle."),
        ),
    }
}

fn is_supported_local_torrent_video_file(file: &LocalTorrentFileCandidate) -> bool {
    pick_local_torrent_video_file(std::slice::from_ref(file), "", "")
        .is_some_and(|selected| selected.file_id == file.file_id)
}

fn local_torrent_stream_url(source_hash: &str, file_id: usize) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("sourceHash", &normalize_torrent_hash(source_hash));
    serializer.append_pair("fileId", &file_id.to_string());
    format!("/api/local-torrent/stream?{}", serializer.finish())
}

fn direct_file_stream_url(source_hash: &str, file_id: &str) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("sourceHash", &normalize_torrent_hash(source_hash));
    serializer.append_pair("fileId", &normalize_direct_file_id(file_id));
    format!("/api/local-cache/stream?{}", serializer.finish())
}

fn local_torrent_cache_key(source_hash: &str, file_id: usize) -> String {
    format!(
        "local-torrent:{}:{}",
        normalize_torrent_hash(source_hash),
        file_id
    )
}

fn looks_like_torrent_metainfo(bytes: &[u8]) -> bool {
    // BitTorrent metainfo is a bencoded dict and is never tiny.
    bytes.len() >= 64 && bytes.starts_with(b"d")
}

fn direct_file_cache_key(source_hash: &str, file_id: &str) -> String {
    format!(
        "local-file:{}:{}",
        normalize_torrent_hash(source_hash),
        normalize_direct_file_id(file_id)
    )
}

fn is_allowed_direct_cache_url(source_url: &str) -> bool {
    url::Url::parse(source_url)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| {
            let hostname = url.host_str()?.to_ascii_lowercase();
            Some(
                DIRECT_CACHE_ALLOWED_DOWNLOAD_HOSTS.iter().any(|allowed| {
                    hostname == *allowed || hostname.ends_with(&format!(".{allowed}"))
                }),
            )
        })
        .unwrap_or(false)
}

fn normalize_torrent_hash(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 40 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        normalized
    } else {
        String::new()
    }
}

fn normalize_direct_file_id(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    normalized.trim_matches('.').trim_matches('_').to_owned()
}

fn sanitize_cache_filename(value: &str) -> String {
    let filename = filename_from_path(value);
    let sanitized = filename
        .chars()
        .take(180)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_' | '(' | ')') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_owned();
    if sanitized.is_empty() {
        "video.mp4".to_owned()
    } else {
        sanitized
    }
}

fn filename_from_path(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| value.trim().to_owned())
}

fn direct_file_entry_to_resolved_source(
    entry: &DirectFileCacheEntry,
) -> LocalTorrentResolvedSource {
    LocalTorrentResolvedSource {
        playable_url: direct_file_stream_url(&entry.source_hash, &entry.file_id),
        filename: entry.filename.clone(),
        source_hash: entry.source_hash.clone(),
        selected_file: entry.file_id.clone(),
        selected_file_path: entry.selected_file_path.clone(),
    }
}

fn parse_stream_range(header: &str, file_size: u64) -> Option<(u64, u64)> {
    let value = header.trim().strip_prefix("bytes=")?;
    let (raw_start, raw_end) = value.split_once('-')?;
    let start = if raw_start.trim().is_empty() {
        let suffix = raw_end.trim().parse::<u64>().ok()?;
        file_size.saturating_sub(suffix)
    } else {
        raw_start.trim().parse::<u64>().ok()?
    };
    let end = if raw_start.trim().is_empty() || raw_end.trim().is_empty() {
        file_size.checked_sub(1)?
    } else {
        raw_end.trim().parse::<u64>().ok()?
    };
    if start > end || end >= file_size {
        return None;
    }
    Some((start, end))
}

fn apply_stream_headers(response: &mut Response<Body>, content_type: &str, content_length: u64) {
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL_STREAM),
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string()).unwrap(),
    );
}

async fn read_startup_probe(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    target_bytes: usize,
) -> std::io::Result<usize> {
    let mut total_read = 0_usize;
    let mut buffer = vec![0_u8; 64 * 1024];
    while total_read < target_bytes {
        let remaining = target_bytes - total_read;
        let chunk_size = remaining.min(buffer.len());
        let count = reader.read(&mut buffer[..chunk_size]).await?;
        if count == 0 {
            break;
        }
        total_read += count;
    }
    Ok(total_read)
}

async fn dir_size_blocking(path: PathBuf) -> AppResult<u64> {
    tokio::task::spawn_blocking(move || dir_size(&path))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn collect_cache_dir_entries(cache_dir: &Path) -> std::io::Result<Vec<CacheDirEntry>> {
    let mut entries = Vec::new();
    let read_dir = match fs::read_dir(cache_dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(error) => return Err(error),
    };
    for item in read_dir.flatten() {
        match item.metadata() {
            Ok(metadata) if metadata.is_dir() => {}
            _ => continue,
        }
        let name = item.file_name().to_string_lossy().to_string();
        if normalize_torrent_hash(&name).is_empty() {
            continue;
        }
        let (size, modified_ms) = dir_size_and_latest_modified_ms(&item.path())?;
        entries.push(CacheDirEntry {
            path: item.path(),
            name,
            size,
            modified_ms,
        });
    }
    Ok(entries)
}

fn dir_size(path: &Path) -> std::io::Result<u64> {
    dir_size_and_latest_modified_ms(path).map(|(size, _)| size)
}

fn dir_size_and_latest_modified_ms(path: &Path) -> std::io::Result<(u64, i64)> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error),
    };
    let mut latest_modified_ms = system_time_ms(metadata.modified().unwrap_or(UNIX_EPOCH));
    if metadata.is_file() {
        return Ok((metadata.len(), latest_modified_ms));
    }
    let mut total = 0_u64;
    for item in fs::read_dir(path)? {
        let item = item?;
        let (size, modified_ms) = dir_size_and_latest_modified_ms(&item.path())?;
        total = total.saturating_add(size);
        latest_modified_ms = latest_modified_ms.max(modified_ms);
    }
    Ok((total, latest_modified_ms))
}

fn system_time_ms(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::AsyncReadExt as _;
    use tokio::sync::{Mutex, Notify};
    use tokio::time::timeout;

    use super::{
        DirectFileCacheEntry, LOCAL_TORRENT_STARTUP_PROBE_BYTES, LocalTorrentFileCandidate,
        LocalTorrentResolveRequest, contains_episode_hint, direct_file_cache_key,
        direct_file_entry_to_resolved_source, direct_file_stream_url, is_internal_stream_request,
        is_supported_local_torrent_video_file, local_torrent_cache_key,
        looks_like_torrent_metainfo, media_filename_hint_matches, normalize_direct_file_id,
        parse_stream_range, pick_local_torrent_video_file, read_startup_probe,
        sanitize_cache_filename, select_torrent_file, spawn_cleanup_holding_managed_add_lock,
        validate_direct_file_stream_params, validate_local_torrent_stream_params,
        with_internal_stream_access,
    };

    #[tokio::test]
    async fn cancellation_cleanup_holds_managed_add_lock_until_it_finishes() {
        let managed_add_lock = Arc::new(Mutex::new(()));
        let managed_add_guard = managed_add_lock.clone().lock_owned().await;
        let cleanup_started = Arc::new(Notify::new());
        let release_cleanup = Arc::new(Notify::new());
        let cleanup_started_for_task = cleanup_started.clone();
        let release_cleanup_for_task = release_cleanup.clone();

        spawn_cleanup_holding_managed_add_lock(
            tokio::runtime::Handle::current(),
            managed_add_guard,
            async move {
                cleanup_started_for_task.notify_one();
                release_cleanup_for_task.notified().await;
            },
        );

        cleanup_started.notified().await;
        assert!(managed_add_lock.try_lock().is_err());
        release_cleanup.notify_one();
        let _guard = timeout(Duration::from_secs(1), managed_add_lock.lock())
            .await
            .expect("managed-add lock should release after cancellation cleanup");
    }

    #[test]
    fn detects_torrent_metainfo_bytes() {
        assert!(looks_like_torrent_metainfo(
            b"d8:announce9:http://x/4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaaee"
        ));
        assert!(!looks_like_torrent_metainfo(b""));
        assert!(!looks_like_torrent_metainfo(b"<html>not a torrent"));
        assert!(!looks_like_torrent_metainfo(b"d"));
    }

    #[test]
    fn internal_stream_access_is_scoped_and_authenticated() {
        let secret = "test-internal-stream-secret";
        let signed = with_internal_stream_access(
            "/api/local-torrent/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=1",
            secret,
        );
        let uri = signed.parse().expect("signed local stream URI");
        assert!(is_internal_stream_request(secret, &uri));
        assert!(!is_internal_stream_request("wrong-secret", &uri));

        let wrong_path = signed
            .replacen("/api/local-torrent/stream", "/api/media/tracks", 1)
            .parse()
            .expect("wrong-path URI");
        assert!(!is_internal_stream_request(secret, &wrong_path));

        let wrong_file = signed
            .replacen("fileId=1", "fileId=2", 1)
            .parse()
            .expect("wrong-file URI");
        assert!(!is_internal_stream_request(secret, &wrong_file));
    }

    #[test]
    fn validates_stream_params() {
        let (hash, file_id) =
            validate_local_torrent_stream_params("0123456789ABCDEF0123456789abcdef01234567", "12")
                .expect("valid params");
        assert_eq!(hash, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(file_id, 12);
        assert!(
            validate_local_torrent_stream_params("not-a-hash", "12").is_err(),
            "bad source hash is rejected"
        );
        assert!(
            validate_local_torrent_stream_params("0123456789abcdef0123456789abcdef01234567", "bad")
                .is_err(),
            "bad file id is rejected"
        );
    }

    #[test]
    fn validates_direct_file_stream_params() {
        let (hash, file_id) =
            validate_direct_file_stream_params("0123456789ABCDEF0123456789abcdef01234567", " 1/2 ")
                .expect("valid params");
        assert_eq!(hash, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(file_id, "1_2");
        assert!(
            validate_direct_file_stream_params("not-a-hash", "1").is_err(),
            "bad source hash is rejected"
        );
        assert!(
            validate_direct_file_stream_params("0123456789abcdef0123456789abcdef01234567", "...")
                .is_err(),
            "empty normalized file id is rejected"
        );
    }

    #[test]
    fn parses_range_headers() {
        assert_eq!(parse_stream_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_stream_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_stream_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_stream_range("bytes=100-101", 100), None);
    }

    #[tokio::test]
    async fn startup_probe_reads_the_bounded_target() {
        let mut enough = tokio::io::repeat(7).take((LOCAL_TORRENT_STARTUP_PROBE_BYTES * 2) as u64);
        assert_eq!(
            read_startup_probe(&mut enough, LOCAL_TORRENT_STARTUP_PROBE_BYTES)
                .await
                .expect("startup probe"),
            LOCAL_TORRENT_STARTUP_PROBE_BYTES
        );

        let mut short = tokio::io::repeat(7).take(1024);
        assert_eq!(
            read_startup_probe(&mut short, LOCAL_TORRENT_STARTUP_PROBE_BYTES)
                .await
                .expect("short startup probe"),
            1024
        );
    }

    #[test]
    fn picks_movie_video_file() {
        let files = vec![
            LocalTorrentFileCandidate {
                file_id: 0,
                path: "readme.txt".to_owned(),
                length: 100,
            },
            LocalTorrentFileCandidate {
                file_id: 1,
                path: "Night.of.the.Living.Dead.1968.1080p.mkv".to_owned(),
                length: 1_000_000,
            },
        ];
        let selected = pick_local_torrent_video_file(&files, "", "Night of the Living Dead 1968")
            .expect("selected file");
        assert_eq!(selected.file_id, 1);
    }

    #[test]
    fn picks_episode_video_file() {
        let files = vec![
            LocalTorrentFileCandidate {
                file_id: 0,
                path: "Show.Name.S01E01.mkv".to_owned(),
                length: 1_000_000,
            },
            LocalTorrentFileCandidate {
                file_id: 1,
                path: "Show.Name.S01E02.mkv".to_owned(),
                length: 900_000,
            },
        ];
        let selected = pick_local_torrent_video_file(&files, "", "Show Name S01E02 Episode")
            .expect("selected file");
        assert_eq!(selected.file_id, 1);
    }

    #[test]
    fn validates_exact_torrent_file_index_as_video() {
        let video = LocalTorrentFileCandidate {
            file_id: 7,
            path: "Show.Name.S01E08.mkv".to_owned(),
            length: 900_000,
        };
        let text = LocalTorrentFileCandidate {
            file_id: 8,
            path: "Show.Name.S01E08.nfo".to_owned(),
            length: 10_000,
        };
        assert!(is_supported_local_torrent_video_file(&video));
        assert!(!is_supported_local_torrent_video_file(&text));
    }

    #[test]
    fn validates_file_index_against_requested_episode_and_falls_back() {
        let files = vec![
            LocalTorrentFileCandidate {
                file_id: 0,
                path: "Show.Name.S01E07.mkv".to_owned(),
                length: 800_000,
            },
            LocalTorrentFileCandidate {
                file_id: 1,
                path: "Show.Name.S01E08.mkv".to_owned(),
                length: 900_000,
            },
        ];
        let request = LocalTorrentResolveRequest {
            info_hash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            magnet_uri: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_owned(),
            preferred_file_index: Some(0),
            preferred_filename: String::new(),
            fallback_name: "Show Name S01E08 Episode".to_owned(),
        };
        assert_eq!(
            select_torrent_file(files.clone(), &request)
                .expect("episode fallback")
                .file_id,
            1
        );

        let mut valid_request = request.clone();
        valid_request.preferred_file_index = Some(1);
        assert_eq!(
            select_torrent_file(files.clone(), &valid_request)
                .expect("valid file index")
                .file_id,
            1
        );

        let mut out_of_range_request = request;
        out_of_range_request.preferred_file_index = Some(99);
        assert_eq!(
            select_torrent_file(files, &out_of_range_request)
                .expect("out-of-range fallback")
                .file_id,
            1
        );
    }

    #[test]
    fn recognizes_episode_and_filename_hints() {
        assert!(contains_episode_hint("Show.Name.S01E08.1080p"));
        assert!(contains_episode_hint("Show Name 1x08"));
        assert!(!contains_episode_hint("Movie 2008 1080p"));
        assert!(media_filename_hint_matches(
            "folder/Show.Name.S01E08.mkv",
            "Show Name S01E08.mkv"
        ));
    }

    #[test]
    fn builds_per_file_cache_key() {
        assert_eq!(
            local_torrent_cache_key("0123456789abcdef0123456789abcdef01234567", 3),
            "local-torrent:0123456789abcdef0123456789abcdef01234567:3"
        );
    }

    #[test]
    fn builds_direct_file_cache_identity() {
        assert_eq!(normalize_direct_file_id(" 1/2 "), "1_2");
        assert_eq!(
            sanitize_cache_filename("../Movie:Name?.mkv"),
            "Movie_Name_.mkv"
        );
        assert_eq!(
            direct_file_cache_key("0123456789abcdef0123456789abcdef01234567", "1/2"),
            "local-file:0123456789abcdef0123456789abcdef01234567:1_2"
        );
        assert_eq!(
            direct_file_stream_url("0123456789abcdef0123456789abcdef01234567", "1/2"),
            "/api/local-cache/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=1_2"
        );
    }

    #[test]
    fn converts_direct_file_entry_to_resolved_source() {
        let entry = DirectFileCacheEntry {
            source_hash: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            file_id: "7".to_owned(),
            source_url: "https://download.real-debrid.com/movie.mkv".to_owned(),
            filename: "Movie.mkv".to_owned(),
            selected_file_path: "/Movie.mkv".to_owned(),
            file_path: "/tmp/Movie.mkv".to_owned(),
            file_length: 100,
            updated_at_ms: 1,
        };
        let resolved = direct_file_entry_to_resolved_source(&entry);
        assert_eq!(
            resolved.playable_url,
            "/api/local-cache/stream?sourceHash=0123456789abcdef0123456789abcdef01234567&fileId=7"
        );
        assert_eq!(resolved.selected_file, "7");
        assert_eq!(resolved.filename, "Movie.mkv");
    }
}

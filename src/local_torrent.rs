use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderValue, RANGE,
};
use axum::http::{HeaderMap, Method, Response, StatusCode};
use dashmap::DashMap;
use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::timeout;
use tokio_util::io::ReaderStream;

use crate::config::Config;
use crate::error::{ApiError, AppResult};
use crate::persistence::Db;
use crate::resolver::pick_video_file_ids;
use crate::utils::now_ms;

const LOCAL_TORRENT_RECENT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const LOCAL_TORRENT_ACCESS_MARKER: &str = ".last-accessed";
const CACHE_CONTROL_STREAM: &str = "no-store";

#[derive(Clone)]
pub struct LocalTorrentService {
    config: Config,
    db: Db,
    session: Arc<OnceCell<Arc<Session>>>,
    handles: Arc<DashMap<String, Arc<ManagedTorrent>>>,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalTorrentResolveRequest {
    pub info_hash: String,
    pub magnet_uri: String,
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

impl LocalTorrentService {
    pub fn new(config: Config, db: Db) -> Self {
        Self {
            config,
            db,
            session: Arc::new(OnceCell::new()),
            handles: Arc::new(DashMap::new()),
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

        let lock = local_torrent_key_lock(&self.locks, &source_hash);
        let _guard = lock.lock().await;

        let session = self.session().await?;
        let output_folder = self.output_folder_for_hash(&source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;

        let files = self
            .fetch_torrent_file_candidates(session.clone(), &request, &output_folder)
            .await?;
        let selected = pick_local_torrent_video_file(
            &files,
            &request.preferred_filename,
            &request.fallback_name,
        )
        .ok_or_else(|| ApiError::internal("No supported video file was found in this torrent."))?;

        self.ensure_cache_has_room(selected.length, &source_hash)
            .await?;

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
        let handle = self.ensure_handle(session, &entry).await?;
        self.wait_for_first_byte(handle, entry.file_id).await?;
        self.refresh_entry_access(&mut entry).await?;

        Ok(LocalTorrentResolvedSource {
            playable_url: local_torrent_stream_url(&entry.source_hash, entry.file_id),
            filename: entry.filename.clone(),
            source_hash: entry.source_hash.clone(),
            selected_file: entry.file_id.to_string(),
            selected_file_path: entry.file_path.clone(),
        })
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
        let lock = local_torrent_key_lock(&self.locks, &source_hash);
        let _guard = lock.lock().await;
        let mut entry = self
            .load_entry(&source_hash, file_id)
            .await?
            .ok_or_else(|| ApiError::not_found("Local torrent stream was not found."))?;
        let session = self.session().await?;
        let handle = self.ensure_handle(session, &entry).await?;
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
                Body::from_stream(ReaderStream::new(stream.take(len)))
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
            return Ok(response);
        }

        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(ReaderStream::new(stream))
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(body)
            .expect("local torrent response");
        apply_stream_headers(&mut response, &content_type, file_size);
        Ok(response)
    }

    async fn session(&self) -> AppResult<Arc<Session>> {
        self.session
            .get_or_try_init(|| async {
                tokio::fs::create_dir_all(&self.config.local_torrent_cache_dir)
                    .await
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                let options = SessionOptions {
                    disable_dht: false,
                    disable_dht_persistence: true,
                    fastresume: false,
                    listen_port_range: None,
                    enable_upnp_port_forwarding: false,
                    concurrent_init_limit: Some(1),
                    disable_upload: true,
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

    async fn fetch_torrent_file_candidates(
        &self,
        session: Arc<Session>,
        request: &LocalTorrentResolveRequest,
        output_folder: &Path,
    ) -> AppResult<Vec<LocalTorrentFileCandidate>> {
        let options = AddTorrentOptions {
            list_only: true,
            output_folder: Some(output_folder.to_string_lossy().to_string()),
            overwrite: true,
            ..Default::default()
        };
        let list_response = timeout(
            Duration::from_millis(self.config.local_torrent_metadata_timeout_ms),
            session.add_torrent(
                AddTorrent::from_url(request.magnet_uri.clone()),
                Some(options),
            ),
        )
        .await
        .map_err(|_| ApiError::gateway_timeout("Local torrent metadata timed out."))?
        .map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent metadata failed: {error}"))
        })?;

        let AddTorrentResponse::ListOnly(list) = list_response else {
            return Err(ApiError::bad_gateway(
                "Local torrent metadata could not be listed.",
            ));
        };
        list.info
            .iter_file_details()
            .map_err(|error| {
                ApiError::bad_gateway(format!("Local torrent file list failed: {error}"))
            })?
            .enumerate()
            .map(|(file_id, details)| {
                let path = details
                    .filename
                    .to_string()
                    .unwrap_or_else(|_| format!("file-{file_id}"));
                Ok(LocalTorrentFileCandidate {
                    file_id,
                    path,
                    length: details.len,
                })
            })
            .collect()
    }

    async fn ensure_handle(
        &self,
        session: Arc<Session>,
        entry: &LocalTorrentCacheEntry,
    ) -> AppResult<Arc<ManagedTorrent>> {
        if let Some(existing) = self.handles.get(&entry.source_hash) {
            let handle = existing.clone();
            if handle_includes_file(&handle, entry.file_id) {
                return Ok(handle);
            }
            let _ = session
                .delete(TorrentIdOrHash::Id(handle.id()), false)
                .await;
            drop(existing);
            self.handles.remove(&entry.source_hash);
        }

        let output_folder = self.output_folder_for_hash(&entry.source_hash);
        tokio::fs::create_dir_all(&output_folder)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let options = AddTorrentOptions {
            only_files: Some(vec![entry.file_id]),
            output_folder: Some(output_folder.to_string_lossy().to_string()),
            overwrite: true,
            ..Default::default()
        };
        let response = session
            .add_torrent(
                AddTorrent::from_url(entry.magnet_uri.clone()),
                Some(options),
            )
            .await
            .map_err(|error| ApiError::bad_gateway(format!("Local torrent add failed: {error}")))?;
        let handle = match response {
            AddTorrentResponse::Added(_, handle) => handle,
            AddTorrentResponse::AlreadyManaged(_, handle) => {
                if !handle_includes_file(&handle, entry.file_id) {
                    session
                        .delete(TorrentIdOrHash::Id(handle.id()), false)
                        .await
                        .map_err(|error| {
                            ApiError::bad_gateway(format!("Local torrent reload failed: {error}"))
                        })?;
                    let retry_options = AddTorrentOptions {
                        only_files: Some(vec![entry.file_id]),
                        output_folder: Some(output_folder.to_string_lossy().to_string()),
                        overwrite: true,
                        ..Default::default()
                    };
                    session
                        .add_torrent(
                            AddTorrent::from_url(entry.magnet_uri.clone()),
                            Some(retry_options),
                        )
                        .await
                        .map_err(|error| {
                            ApiError::bad_gateway(format!("Local torrent add failed: {error}"))
                        })?
                        .into_handle()
                        .ok_or_else(|| {
                            ApiError::bad_gateway("Local torrent handle was not created.")
                        })?
                } else {
                    handle
                }
            }
            AddTorrentResponse::ListOnly(_) => {
                return Err(ApiError::bad_gateway(
                    "Local torrent handle was not created.",
                ));
            }
        };

        timeout(
            Duration::from_millis(self.config.local_torrent_ready_timeout_ms),
            handle.wait_until_initialized(),
        )
        .await
        .map_err(|_| ApiError::gateway_timeout("Local torrent initialization timed out."))?
        .map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent initialization failed: {error}"))
        })?;
        self.handles
            .insert(entry.source_hash.clone(), handle.clone());
        Ok(handle)
    }

    async fn wait_for_first_byte(
        &self,
        handle: Arc<ManagedTorrent>,
        file_id: usize,
    ) -> AppResult<()> {
        let mut stream = handle.stream(file_id).map_err(|error| {
            ApiError::bad_gateway(format!("Local torrent stream failed: {error}"))
        })?;
        let mut first_byte = [0_u8; 1];
        let read_result = timeout(
            Duration::from_millis(self.config.local_torrent_ready_timeout_ms),
            stream.read(&mut first_byte),
        )
        .await
        .map_err(|_| ApiError::gateway_timeout("Local torrent first byte was not ready."))?;
        match read_result {
            Ok(count) if count > 0 => Ok(()),
            Ok(_) => Err(ApiError::bad_gateway("Local torrent file was empty.")),
            Err(error) => Err(ApiError::bad_gateway(format!(
                "Local torrent first byte failed: {error}"
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
        let existing_keep_bytes = dir_size_blocking(keep_dir).await.unwrap_or_default();
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
        let mut active_hashes = self
            .handles
            .iter()
            .map(|entry| entry.key().clone())
            .collect::<HashSet<_>>();
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
}

fn local_torrent_key_lock(map: &DashMap<String, Arc<Mutex<()>>>, key: &str) -> Arc<Mutex<()>> {
    map.entry(key.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
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

fn handle_includes_file(handle: &ManagedTorrent, file_id: usize) -> bool {
    handle
        .only_files()
        .map(|files| files.contains(&file_id))
        .unwrap_or(true)
}

fn local_torrent_stream_url(source_hash: &str, file_id: usize) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("sourceHash", &normalize_torrent_hash(source_hash));
    serializer.append_pair("fileId", &file_id.to_string());
    format!("/api/local-torrent/stream?{}", serializer.finish())
}

fn local_torrent_cache_key(source_hash: &str, file_id: usize) -> String {
    format!(
        "local-torrent:{}:{}",
        normalize_torrent_hash(source_hash),
        file_id
    )
}

fn normalize_torrent_hash(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 40 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        normalized
    } else {
        String::new()
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
    use super::{
        LocalTorrentFileCandidate, local_torrent_cache_key, parse_stream_range,
        pick_local_torrent_video_file, validate_local_torrent_stream_params,
    };

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
    fn parses_range_headers() {
        assert_eq!(parse_stream_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_stream_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_stream_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_stream_range("bytes=100-101", 100), None);
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
    fn builds_per_file_cache_key() {
        assert_eq!(
            local_torrent_cache_key("0123456789abcdef0123456789abcdef01234567", 3),
            "local-torrent:0123456789abcdef0123456789abcdef01234567:3"
        );
    }
}

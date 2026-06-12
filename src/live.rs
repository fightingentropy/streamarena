use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Response, Uri};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dashmap::DashMap;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::timeout;
use url::Url;
use url::form_urlencoded::byte_serialize;

use crate::error::{ApiError, AppResult};
use crate::process::{run_process_pipe, to_absolute_playback_url};
use crate::routes::AppState;
use crate::utils::now_ms;

const LIVE_HLS_EDGE_SEGMENT_COUNT: usize = 8;
const LIVE_HLS_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LIVE_HLS_BROWSER_FETCH_SCRIPT: &str = "scripts/fetch-browser-live-hls.mjs";
const LIVE_HLS_BROWSER_FETCH_RUNTIME_SCRIPT: &str = "bin/fetch-browser-live-hls.mjs";
const LIVE_HLS_BROWSER_FETCH_TIMEOUT_SECONDS: u64 = 26;
const LIVE_HLS_EXTERNAL_EMBED_PARAM: &str = "externalEmbed";
const LIVE_HLS_SIGNATURE_PARAM: &str = "sig";
const LIVE_HLS_SIGNATURE_CONTEXT: &[u8] = b"netflix-live-hls-v1";
const LIVE_HLS_ALLOWED_HOSTS: &[&str] = &[
    "liveproduseast.akamaized.net",
    "liveproduseast.global.ssl.fastly.net",
    "liveprodusphoenixeast.global.ssl.fastly.net",
    "liveprodusphoenixeast.akamaized.net",
    "vs-hls-push-ww-live.akamaized.net",
    "jmp2.uk",
    "www.bloomberg.com",
    "28585519.net",
    "antennaplus.gr",
    "broadpeak-aas.com",
    "cdn.skycdp.com",
    "msvdn.net",
    "siliconweb.com",
    "strmd.st",
    "lovetier.bz",
    "strmd.top",
    "zohanayaan.com",
    "easy.speedsterwave.app",
    "easy.nightspeedster.app",
    "hello.mousedoor.com",
    "yoru.midwesteagle.com",
    "www.cloudflare-terms-of-service-abuse.com",
    "storm.vodvidl.site",
    "typhoontigertribe.net",
    "ttvnw.net",
];

type HmacSha256 = Hmac<Sha256>;

struct LiveHlsRequest {
    source_url: Url,
    referer: Option<String>,
    trusted_external_embed: bool,
    direct_segments: bool,
}

struct LiveHlsPlaylistFetch {
    final_url: Url,
    body: String,
}

struct LiveHlsResourceFetch {
    content_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct BrowserLiveHlsFetchOutput {
    #[serde(rename = "finalUrl")]
    final_url: String,
    body: String,
}

#[derive(Clone, Copy)]
enum LiveHlsRequestKind {
    Playlist,
    Resource,
}

pub async fn live_hls_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let live_request = live_hls_request_input(&state, &uri, LiveHlsRequestKind::Playlist)?;
    let fetched = fetch_live_hls_playlist_upstream(&state, &live_request).await?;
    let playlist = fetched.body;
    let trusted_secret = live_request
        .trusted_external_embed
        .then_some(state.config.live_hls_proxy_secret.as_str());
    let rewritten = rewrite_live_hls_playlist(
        &fetched.final_url,
        &playlist,
        live_request.referer.as_deref(),
        trusted_secret,
        live_request.direct_segments,
    );
    let rewritten = maybe_route_live_resources_to_worker(
        &state,
        rewritten,
        live_request.trusted_external_embed,
    );

    Response::builder()
        .status(200)
        .header(
            "content-type",
            "application/vnd.apple.mpegurl; charset=utf-8",
        )
        .header("cache-control", "no-store")
        .body(Body::from(rewritten))
        .map_err(|error| ApiError::internal(error.to_string()))
}

/// When the Cloudflare live-segment Worker is configured and this stream is
/// known browser-safe (no transcode needed — the Worker can't run ffmpeg),
/// rewrite the relative `/api/live/hls-resource` segment URLs to absolute Worker
/// URLs so the segment bytes serve from Cloudflare's network instead of the
/// mini's home uplink. Only the host changes — same path, params and HMAC
/// signature — so the Worker validates the identical signature. No-op when
/// disabled, untrusted, or the transcode decision is unknown/needed (in which
/// case the mini keeps serving so transcoding still works).
fn maybe_route_live_resources_to_worker(
    state: &AppState,
    rewritten: String,
    trusted_external_embed: bool,
) -> String {
    let worker_base = state.config.live_hls_resource_worker_base.trim();
    if worker_base.is_empty() || !trusted_external_embed {
        return rewritten;
    }
    let Some(first_input) = first_live_resource_input(&rewritten)
        .as_deref()
        .and_then(|input| Url::parse(input).ok())
    else {
        return rewritten;
    };
    // Curl-fingerprint hosts (e.g. VidLink/storm) must be fetched by the mini
    // over curl; the Worker's Cloudflare-IP egress is blocked even harder, so
    // never route their segments to the Worker.
    if is_curl_fetch_live_hls_upstream(&first_input) {
        return rewritten;
    }
    let browser_safe =
        state.live_audio_transcode_cache.get_fresh(&live_audio_stream_key(&first_input))
            == Some(false);
    if !browser_safe {
        return rewritten;
    }
    rewritten.replace(
        "/api/live/hls-resource",
        &format!("{worker_base}/api/live/hls-resource"),
    )
}

/// When the Cloudflare live-HLS Worker is configured, serve signed live
/// playlist URLs from the Worker host instead of the zone: the zone's
/// always-on L7 DDoS managed ruleset intermittently mints 503s for bursty
/// `/api/live/*` playlist polling (hls.js refresh + failover retries), while
/// the workers.dev host is unaffected. The Worker proxies the playlist from
/// the origin — which keeps doing the upstream fetch + rewrite — and
/// re-points the rewritten URLs at itself, so segments follow automatically.
/// No-op when the Worker base is unset or the source is not the signed live
/// playlist proxy.
pub fn route_live_playback_source_via_worker(worker_base: &str, source: String) -> String {
    let worker_base = worker_base.trim().trim_end_matches('/');
    if worker_base.is_empty() || !source.starts_with("/api/live/hls.m3u8?") {
        return source;
    }
    format!("{worker_base}{source}")
}

/// True when `uri` is a live HLS proxy request carrying a valid
/// trusted-external-embed signature. The API auth middleware uses this to let
/// the Cloudflare Worker's origin relays through without a browser session:
/// the worker→origin hop can't carry cookies, and the HMAC already proves the
/// URL was minted by this backend — the same authorization the Worker itself
/// enforces when serving segments. Unsigned live requests (allowlisted TV
/// channels fetched same-origin by the player) still require a session.
pub fn is_signed_live_hls_request(live_hls_proxy_secret: &str, uri: &Uri) -> bool {
    if uri.path() != "/api/live/hls.m3u8" && uri.path() != "/api/live/hls-resource" {
        return false;
    }
    if live_hls_proxy_secret.trim().is_empty() {
        return false;
    }
    let params = query_pairs(uri.query().unwrap_or_default());
    if params
        .get(LIVE_HLS_EXTERNAL_EMBED_PARAM)
        .map(String::as_str)
        != Some("1")
    {
        return false;
    }
    let (Some(input), Some(signature)) = (
        params.get("input"),
        params.get(LIVE_HLS_SIGNATURE_PARAM),
    ) else {
        return false;
    };
    // The signature covers the normalized input + referer exactly as the URL
    // builder serialized them into the query, so verify over the raw values.
    let referer = params
        .get("referer")
        .and_then(|value| normalize_hls_referer(value));
    verify_live_hls_proxy_url_signature(input, referer.as_deref(), signature, live_hls_proxy_secret)
}

/// Extract the upstream segment URL (`input` query param) from the first bare
/// `/api/live/hls-resource?…` line of a rewritten media playlist, used to derive
/// the stream's transcode-cache key.
fn first_live_resource_input(playlist: &str) -> Option<String> {
    for line in playlist.lines() {
        if let Some(query) = line.trim().strip_prefix("/api/live/hls-resource?") {
            for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                if key == "input" {
                    return Some(value.into_owned());
                }
            }
        }
    }
    None
}

pub async fn live_hls_resource_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> AppResult<Response<Body>> {
    if method != Method::GET {
        return Err(ApiError::method_not_allowed("Method not allowed."));
    }
    let live_request = live_hls_request_input(&state, &uri, LiveHlsRequestKind::Resource)?;
    let fetched = fetch_live_hls_resource_upstream(&state, &live_request).await?;
    let mut content_type = fetched.content_type;
    let mut bytes = fetched.bytes;

    // Some upstreams ship audio/markers the browser can't handle (Nova Sports MP2
    // audio; Bloomberg SCTE-35 ad markers) or an H.264 bitstream that breaks Chrome
    // once ffmpeg touches the container. Re-encode such segments to browser-safe
    // H.264 + AAC. The decision is probed once per stream and cached.
    if is_live_ts_segment(&live_request.source_url, &content_type) {
        match process_live_segment(&state, &live_request.source_url, &bytes).await {
            LiveSegmentOutcome::Passthrough => {}
            LiveSegmentOutcome::Transcoded(output) => {
                bytes = output;
                content_type = "video/mp2t".to_owned();
            }
            LiveSegmentOutcome::TranscodeFailed => {
                return Err(ApiError::bad_gateway("Live segment transcode failed."));
            }
        }
    }

    Response::builder()
        .status(200)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
        .map_err(|error| ApiError::internal(error.to_string()))
}

const LIVE_AUDIO_TRANSCODE_DECISION_TTL_MS: i64 = 10 * 60 * 1000;
const LIVE_AUDIO_TRANSCODE_MAX_ENTRIES: usize = 256;
const LIVE_SEGMENT_PROBE_TIMEOUT_MS: u64 = 8_000;
const LIVE_SEGMENT_TRANSCODE_TIMEOUT_MS: u64 = 20_000;
const LIVE_SEGMENT_MAX_TRANSCODE_BYTES: usize = 24 * 1024 * 1024;
const LIVE_SEGMENT_VIDEO_BITRATE: &str = "6000k";
const LIVE_REENCODE_MAX_CONCURRENT: usize = 3;

// Cap concurrent live segment re-encodes: a cold-start burst of hardware encodes
// overloads VideoToolbox and some fail ("Broken pipe"), so serialize beyond a
// small limit instead of failing.
static LIVE_REENCODE_SEMAPHORE: Semaphore = Semaphore::const_new(LIVE_REENCODE_MAX_CONCURRENT);

// Cap the upstream live HTTP fetch (playlist + segment) tighter than the shared
// 30s client. A dead upstream then releases its socket/fd ~3x faster, which is
// what prevents the file-descriptor exhaustion stall seen under live load.
const LIVE_UPSTREAM_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// Cap concurrent ffprobe probes. The probe is already time-bounded, but a
// thundering herd of new live segments would otherwise spawn unbounded child
// processes (fd + process pressure). Generous — normal playback never queues.
const LIVE_PROBE_MAX_CONCURRENT: usize = 6;
static LIVE_PROBE_SEMAPHORE: Semaphore = Semaphore::const_new(LIVE_PROBE_MAX_CONCURRENT);

// Some live HLS CDNs (VidLink's storm.vodvidl.site) gate on the client's TLS
// fingerprint via Cloudflare bot-management: the shared rustls reqwest client
// is flagged as a bot and gets 403, while the macOS system curl (SecureTransport
// TLS) with a browser UA passes. For those hosts we fetch the playlist AND every
// segment through curl. Pin the system binary (SecureTransport, the fingerprint
// that passes) — a Homebrew curl could link a different TLS stack.
const LIVE_HLS_CURL_BIN: &str = "/usr/bin/curl";
const LIVE_HLS_CURL_TIMEOUT_SECONDS: u64 = 12;
// Bound concurrent curl children the same way as the probe/encode pools so a
// burst of segment requests can't spawn unbounded processes.
const LIVE_CURL_MAX_CONCURRENT: usize = 8;
static LIVE_CURL_SEMAPHORE: Semaphore = Semaphore::const_new(LIVE_CURL_MAX_CONCURRENT);

/// Result of running a live `.ts` segment through the transcode pipeline.
enum LiveSegmentOutcome {
    /// Serve the upstream bytes unchanged.
    Passthrough,
    /// Serve these re-encoded bytes (browser-safe H.264 + AAC).
    Transcoded(Vec<u8>),
    /// The segment required re-encoding but it failed; the caller should return
    /// an error so the player retries the fragment rather than play a broken one.
    TranscodeFailed,
}

#[derive(Clone, Copy)]
struct LiveAudioDecision {
    needs_transcode: bool,
    decided_at_ms: i64,
}

/// Per-stream cache of "does this live stream's audio need transcoding to AAC".
/// Keyed by upstream host + first path segment (the channel), so the audio codec
/// is probed once per channel instead of on every segment.
#[derive(Clone, Default)]
pub struct LiveAudioTranscodeCache {
    entries: Arc<DashMap<String, LiveAudioDecision>>,
}

impl LiveAudioTranscodeCache {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(DashMap::new()),
        }
    }

    fn get_fresh(&self, key: &str) -> Option<bool> {
        let entry = self.entries.get(key)?;
        if now_ms() - entry.decided_at_ms > LIVE_AUDIO_TRANSCODE_DECISION_TTL_MS {
            return None;
        }
        Some(entry.needs_transcode)
    }

    fn record(&self, key: String, needs_transcode: bool) {
        self.entries.insert(
            key,
            LiveAudioDecision {
                needs_transcode,
                decided_at_ms: now_ms(),
            },
        );
    }

    pub fn prune(&self) {
        let now = now_ms();
        self.entries
            .retain(|_, value| now - value.decided_at_ms <= LIVE_AUDIO_TRANSCODE_DECISION_TTL_MS);
        if self.entries.len() > LIVE_AUDIO_TRANSCODE_MAX_ENTRIES {
            self.entries.clear();
        }
    }
}

fn is_live_ts_segment(url: &Url, content_type: &str) -> bool {
    url.path().to_ascii_lowercase().ends_with(".ts")
        || content_type.to_ascii_lowercase().contains("mp2t")
}

fn live_audio_stream_key(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let first_segment = url
        .path_segments()
        .and_then(|mut segments| segments.next())
        .unwrap_or_default();
    format!("{host}/{first_segment}")
}

fn audio_codec_needs_live_transcode(codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    !codec.is_empty() && codec != "aac" && codec != "mp3"
}

/// Decide whether a live `.ts` segment must be re-encoded to play in the browser.
/// Returns None if the probe failed (so the caller can retry on a later segment).
/// A segment needs transcoding when it has audio the browser can't decode
/// (anything but AAC/MP3) OR carries a data/SCTE-35/subtitle stream — Bloomberg's
/// feed embeds SCTE-35 ad markers that trip hls.js's transmux; the re-encode maps
/// only video+audio, dropping those streams.
async fn probe_live_segment_needs_transcode(bytes: Vec<u8>) -> Option<bool> {
    let args = [
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of",
        "csv=p=0", "-i", "-",
    ]
    .iter()
    .map(|value| (*value).to_owned())
    .collect::<Vec<_>>();
    // Bound concurrent probe processes; drop the probe (retry on a later segment)
    // if the limiter is unavailable rather than blocking forever.
    let _permit = LIVE_PROBE_SEMAPHORE.acquire().await.ok()?;
    let output = run_process_pipe(&args, bytes, LIVE_SEGMENT_PROBE_TIMEOUT_MS)
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output);
    let mut saw_stream = false;
    let mut needs_transcode = false;
    for line in text.lines() {
        let tokens: Vec<String> = line
            .split(',')
            .map(|token| token.trim().to_ascii_lowercase())
            .filter(|token| !token.is_empty())
            .collect();
        if tokens.is_empty() {
            continue;
        }
        saw_stream = true;
        // Data / SCTE-35 / subtitle PIDs break hls.js's TS transmux; drop them.
        if tokens
            .iter()
            .any(|token| matches!(token.as_str(), "data" | "subtitle" | "scte_35" | "timed_id3"))
        {
            needs_transcode = true;
        }
        // Non-AAC/MP3 audio is not decodable through MSE.
        if tokens.iter().any(|token| token == "audio") {
            let codec = tokens
                .iter()
                .find(|token| *token != "audio")
                .cloned()
                .unwrap_or_default();
            if audio_codec_needs_live_transcode(&codec) {
                needs_transcode = true;
            }
        }
    }
    saw_stream.then_some(needs_transcode)
}

async fn transcode_live_segment_to_browser_safe(
    bytes: Vec<u8>,
    video_encoder: &str,
) -> Result<Vec<u8>, String> {
    // Re-encode both video and audio to browser-decodable codecs. Copying the
    // video is NOT enough: some upstreams (e.g. NTVS/hesgoaler Nova Sports) ship
    // an H.264 bitstream that ffmpeg's demux/remux leaves undecodable in Chrome
    // (PIPELINE_ERROR_DECODE), whether the segment is copied or re-muxed — only a
    // fresh encode plays reliably. `-copyts` keeps live timestamps aligned so the
    // re-encoded segments concatenate cleanly in the player's live timeline.
    let args = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-copyts", "-i", "-", "-map", "0:v:0?",
        "-map", "0:a:0?", "-c:v", video_encoder, "-b:v", LIVE_SEGMENT_VIDEO_BITRATE, "-c:a", "aac",
        "-b:a", "160k", "-muxpreload", "0", "-muxdelay", "0", "-f", "mpegts", "-",
    ]
    .iter()
    .map(|value| (*value).to_owned())
    .collect::<Vec<_>>();
    // Limit concurrent encodes to avoid overloading the hardware encoder.
    let _permit = LIVE_REENCODE_SEMAPHORE
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    run_process_pipe(&args, bytes, LIVE_SEGMENT_TRANSCODE_TIMEOUT_MS).await
}

fn live_segment_video_encoder(snapshot: &crate::process::FfmpegSnapshot) -> &'static str {
    // Prefer hardware H.264 (cheap on Apple Silicon); fall back to software.
    if snapshot.encoders.h264_videotoolbox {
        "h264_videotoolbox"
    } else if snapshot.encoders.h264_nvenc {
        "h264_nvenc"
    } else if snapshot.encoders.h264_qsv {
        "h264_qsv"
    } else {
        "libx264"
    }
}

async fn process_live_segment(state: &AppState, url: &Url, bytes: &[u8]) -> LiveSegmentOutcome {
    if bytes.is_empty() || bytes.len() > LIVE_SEGMENT_MAX_TRANSCODE_BYTES {
        return LiveSegmentOutcome::Passthrough;
    }
    let key = live_audio_stream_key(url);
    let needs_transcode = match state.live_audio_transcode_cache.get_fresh(&key) {
        Some(decision) => decision,
        None => match probe_live_segment_needs_transcode(bytes.to_vec()).await {
            Some(decision) => {
                state.live_audio_transcode_cache.record(key, decision);
                decision
            }
            // Probe failed: serve the segment as-is and retry detection later.
            None => return LiveSegmentOutcome::Passthrough,
        },
    };
    if !needs_transcode {
        return LiveSegmentOutcome::Passthrough;
    }
    let capabilities = state.runtime.get_ffmpeg_capabilities(false).await;
    let video_encoder = live_segment_video_encoder(&capabilities);
    match transcode_live_segment_to_browser_safe(bytes.to_vec(), video_encoder).await {
        Ok(output) if !output.is_empty() => LiveSegmentOutcome::Transcoded(output),
        // The stream needs re-encoding but it failed/produced nothing. Serving the
        // original would play a broken (e.g. SCTE-35 / MP2) segment, so signal the
        // caller to return an error and let the player retry the fragment instead.
        Ok(_) => LiveSegmentOutcome::TranscodeFailed,
        Err(error) => {
            tracing::warn!(error = %error, "live segment transcode failed; asking player to retry");
            LiveSegmentOutcome::TranscodeFailed
        }
    }
}

fn query_pairs(query: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn absolute_request_url(state: &AppState, uri: &Uri) -> AppResult<Url> {
    Url::parse(&format!(
        "http://{}:{}{}",
        state.config.host, state.config.port, uri
    ))
    .map_err(|error| ApiError::internal(error.to_string()))
}

fn live_hls_request_input(
    state: &AppState,
    uri: &Uri,
    kind: LiveHlsRequestKind,
) -> AppResult<LiveHlsRequest> {
    let params = query_pairs(uri.query().unwrap_or_default());
    let request_url = absolute_request_url(state, uri)?;
    let input = to_absolute_playback_url(
        params.get("input").map(String::as_str).unwrap_or_default(),
        &request_url,
    );
    if input.trim().is_empty() {
        return Err(ApiError::bad_request("Missing input query parameter."));
    }
    let source_url =
        Url::parse(&input).map_err(|_| ApiError::bad_request("Invalid live HLS URL."))?;
    let referer = params
        .get("referer")
        .and_then(|value| normalize_hls_referer(value));
    let trusted_external_embed = is_trusted_external_embed_hls_request(
        &source_url,
        kind,
        referer.as_deref(),
        &params,
        &state.config.live_hls_proxy_secret,
    );
    if !is_allowed_live_hls_url(&source_url) && !trusted_external_embed {
        return Err(ApiError::bad_request("Unsupported live HLS URL."));
    }
    // Opt-in: when set (only honored for trusted embeds), the playlist rewrite
    // leaves browser-direct-eligible CDN hosts as absolute URLs so their bytes
    // skip the Mini's uplink. Default (and the proxied fallback URL) keep the
    // full Mini proxy behavior. Only ever reduces Mini involvement, never the
    // SSRF surface, so it doesn't need to be part of the signed payload.
    let direct_segments = trusted_external_embed
        && params.get("directSeg").map(String::as_str) == Some("1");
    Ok(LiveHlsRequest {
        source_url,
        referer,
        trusted_external_embed,
        direct_segments,
    })
}

fn normalize_hls_referer(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return None;
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_ascii_control() || ch == '\u{7f}')
    {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    url.host_str()?;
    Some(url.to_string())
}

fn encode_query_value(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect::<String>()
}

pub fn build_trusted_external_embed_hls_playback_source(
    input: &str,
    referer: Option<&str>,
    live_hls_proxy_secret: &str,
) -> String {
    live_hls_proxy_playlist_url_with_trust(input, referer, Some(live_hls_proxy_secret))
}

pub fn is_browser_bound_live_hls_upstream(url: &Url) -> bool {
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    host == "strmd.st"
        || host.ends_with(".strmd.st")
        || host == "strmd.top"
        || host.ends_with(".strmd.top")
}

/// Hosts that gate on the client's TLS/HTTP2 fingerprint (Cloudflare bot
/// management): the shared rustls reqwest client is flagged and 403/502s, while
/// the system curl (SecureTransport) with a browser UA passes. These are the
/// VidLink CDN proxy hosts (storm.vodvidl.site) and VixSrc (vixsrc.to playlists +
/// vix-content.net segment CDN). storm re-serves the master playlist, every
/// variant playlist, AND every `.ts` segment under its own `/proxy/...` path;
/// vixsrc.to serves the master/variant playlists, audio-subtitle renditions, and
/// the AES key, while the encrypted `.ts` segments live on the `vix-content.net`
/// edge CDN (`sc-u5-01.vix-content.net`, etc.) — all rustls-blocked, all curl-
/// passable. The Cloudflare Worker is NOT a usable bypass here — its Cloudflare-IP
/// egress is blocked even harder (CF-to-CF) — and per-segment Playwright is far
/// too expensive for a VOD with hundreds of segments, so curl is the fix. (The
/// resolve-time API/embed/playlist fetches for vixsrc.to use a matching curl path
/// in resolver.rs; see `is_curl_fetch_external_embed_host`.)
pub fn is_curl_fetch_live_hls_upstream(url: &Url) -> bool {
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    host == "storm.vodvidl.site"
        || host.ends_with(".vodvidl.site")
        || host == "typhoontigertribe.net"
        || host.ends_with(".typhoontigertribe.net")
        || host == "vixsrc.to"
        || host.ends_with(".vixsrc.to")
        || host == "vix-content.net"
        || host.ends_with(".vix-content.net")
}

pub fn build_sports_live_hls_playback_source(
    input: &str,
    referer: Option<&str>,
    live_hls_proxy_secret: &str,
) -> String {
    build_trusted_external_embed_hls_playback_source(input, referer, live_hls_proxy_secret)
}

/// Hosts that serve the browser **cross-origin directly** — they send
/// `Access-Control-Allow-Origin: *` and impose no Referer wall — so hls.js can
/// fetch them straight from the source CDN with no Mini in the byte path. These
/// are LordFlix's playlist proxy (`tcloud.lordflix.club`) and the TikTok CDN
/// that serves its `.ts` segments (`*.tiktokcdn.com`); both were verified by
/// probe. Leaving these direct (under the `directSeg` flag) takes the heavy
/// segment bytes off the Mini's home uplink entirely. Conservative allow-list:
/// any host NOT listed keeps going through the Mini proxy (the safe default).
fn is_cors_direct_hls_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == "tcloud.lordflix.club"
        || host == "tiktokcdn.com"
        || host.ends_with(".tiktokcdn.com")
}

/// In direct-segment mode, return the absolute upstream URL untouched when its
/// host is browser-direct-eligible (CORS-open, no Referer wall, and not a
/// fingerprint-blocked host that only the Mini's curl can reach). Otherwise
/// None → the caller proxies it through the Mini as usual.
fn direct_hls_url_if_eligible(input: &str, direct_segments: bool) -> Option<String> {
    if !direct_segments {
        return None;
    }
    let url = Url::parse(input).ok()?;
    let host = url.host_str()?;
    if is_cors_direct_hls_host(host) && !is_curl_fetch_live_hls_upstream(&url) {
        Some(input.to_owned())
    } else {
        None
    }
}

fn browser_bound_live_hls_referer_header(referer: Option<&str>) -> Option<String> {
    let referer = referer.and_then(normalize_hls_referer)?;
    let parsed = Url::parse(referer.as_str()).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "embed.st" || host == "www.embed.st" {
        return Some(format!("{}/", parsed.origin().ascii_serialization()));
    }
    Some(referer)
}

fn browser_bound_live_hls_page_url(referer: Option<&str>) -> Option<String> {
    referer.and_then(normalize_hls_referer)
}

fn live_hls_browser_fetch_script_path() -> String {
    if let Some(value) = std::env::var("BROWSER_LIVE_HLS_FETCH_SCRIPT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return value;
    }

    if Path::new(LIVE_HLS_BROWSER_FETCH_SCRIPT).is_file() {
        return LIVE_HLS_BROWSER_FETCH_SCRIPT.to_owned();
    }

    LIVE_HLS_BROWSER_FETCH_RUNTIME_SCRIPT.to_owned()
}

fn ensure_allowed_live_hls_final_url(
    final_url: &Url,
    live_request: &LiveHlsRequest,
    kind: LiveHlsRequestKind,
) -> AppResult<()> {
    if is_allowed_live_hls_url(final_url)
        || live_request.trusted_external_embed
            && is_public_external_embed_hls_proxy_url(final_url, kind)
    {
        return Ok(());
    }
    Err(ApiError::bad_gateway(
        "Live HLS playlist redirected to an unsupported host.",
    ))
}

async fn fetch_live_hls_playlist_upstream(
    state: &AppState,
    live_request: &LiveHlsRequest,
) -> AppResult<LiveHlsPlaylistFetch> {
    if is_curl_fetch_live_hls_upstream(&live_request.source_url) {
        return fetch_live_hls_playlist_via_curl(live_request).await;
    }
    let referer_header = browser_bound_live_hls_referer_header(live_request.referer.as_deref());
    match fetch_live_hls_playlist_via_http(state, live_request, referer_header.as_deref()).await {
        Ok(fetched) => return Ok(fetched),
        Err(error) if should_retry_live_hls_with_browser_fetch(live_request, &error) => {}
        Err(error) => return Err(error),
    }

    let fetched = fetch_live_hls_playlist_via_browser(live_request).await?;
    ensure_allowed_live_hls_final_url(&fetched.final_url, live_request, LiveHlsRequestKind::Playlist)?;
    Ok(fetched)
}

async fn fetch_live_hls_resource_upstream(
    state: &AppState,
    live_request: &LiveHlsRequest,
) -> AppResult<LiveHlsResourceFetch> {
    if is_curl_fetch_live_hls_upstream(&live_request.source_url) {
        return fetch_live_hls_resource_via_curl(live_request).await;
    }
    let referer_header = browser_bound_live_hls_referer_header(live_request.referer.as_deref());
    match fetch_live_hls_resource_via_http(state, live_request, referer_header.as_deref()).await {
        Ok(fetched) => return Ok(fetched),
        Err(error) if should_retry_live_hls_with_browser_fetch(live_request, &error) => {}
        Err(error) => return Err(error),
    }

    if !live_request
        .source_url
        .path()
        .to_ascii_lowercase()
        .ends_with(".m3u8")
    {
        return Err(ApiError::bad_gateway(
            "Live HLS resource request failed in browser-bound mode.",
        ));
    }

    let playlist = fetch_live_hls_playlist_via_browser(live_request).await?;
    ensure_allowed_live_hls_final_url(
        &playlist.final_url,
        live_request,
        LiveHlsRequestKind::Resource,
    )?;
    Ok(LiveHlsResourceFetch {
        content_type: "application/vnd.apple.mpegurl".to_owned(),
        bytes: playlist.body.into_bytes(),
    })
}

fn should_retry_live_hls_with_browser_fetch(
    live_request: &LiveHlsRequest,
    error: &ApiError,
) -> bool {
    if !is_browser_bound_live_hls_upstream(&live_request.source_url) {
        return false;
    }
    error
        .message()
        .is_some_and(|message| message.contains("403"))
}

struct LiveHlsCurlResponse {
    status: u16,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

/// Parse the HTTP status code and Content-Type from a `curl -D` header dump
/// (sent to stderr by our invocation). We do not follow redirects, so there is
/// exactly one header block; take the last status/content-type defensively.
pub(crate) fn parse_curl_response_headers(headers: &str) -> (u16, Option<String>) {
    let mut status = 0u16;
    let mut content_type = None;
    for line in headers.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("HTTP/") {
            // "HTTP/2 200" or "HTTP/1.1 200 OK" -> the token after the version.
            if let Some(code) = rest.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok()) {
                status = code;
            }
        } else if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-type") {
                content_type = Some(value.trim().to_owned());
            }
        }
    }
    (status, content_type)
}

/// Fetch a live HLS URL over the macOS system curl (SecureTransport TLS) rather
/// than the shared rustls reqwest client, for hosts that block rustls's TLS
/// fingerprint (see `is_curl_fetch_live_hls_upstream`). Sends a browser UA and
/// the player Referer. Does NOT follow redirects: the SSRF guard depends on the
/// final host equalling the already-allow-listed request host, so a redirect
/// must not silently retarget. Headers go to stderr (`-D /dev/stderr`) so the
/// body stays clean on stdout.
async fn fetch_live_hls_via_curl(
    url: &Url,
    referer: Option<&str>,
    accept: &str,
) -> AppResult<LiveHlsCurlResponse> {
    let _permit = LIVE_CURL_SEMAPHORE
        .acquire()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut command = Command::new(LIVE_HLS_CURL_BIN);
    command
        .arg("-sS")
        .arg("--max-time")
        .arg(LIVE_HLS_CURL_TIMEOUT_SECONDS.to_string())
        .arg("-A")
        .arg(LIVE_HLS_BROWSER_USER_AGENT)
        .arg("-H")
        .arg(format!("Accept: {accept}"))
        .arg("-H")
        .arg("Accept-Language: en-US,en;q=0.9")
        .arg("-D")
        .arg("/dev/stderr")
        .arg(url.as_str())
        .kill_on_drop(true);
    if let Some(referer) = referer {
        command.arg("-H").arg(format!("Referer: {referer}"));
    }
    let output = timeout(
        Duration::from_secs(LIVE_HLS_CURL_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .map_err(|_| ApiError::bad_gateway("Live HLS curl fetch timed out."))?
    .map_err(|error| ApiError::bad_gateway(format!("Live HLS curl fetch failed: {error}")))?;
    // curl exits non-zero only on transport errors (DNS, connect, timeout);
    // an HTTP 4xx/5xx still exits 0, so the HTTP status is parsed by the caller.
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_gateway(format!(
            "Live HLS curl fetch failed ({}).",
            detail.lines().last().unwrap_or("").trim()
        )));
    }
    let headers = String::from_utf8_lossy(&output.stderr);
    let (status, content_type) = parse_curl_response_headers(&headers);
    Ok(LiveHlsCurlResponse {
        status,
        content_type,
        bytes: output.stdout,
    })
}

async fn fetch_live_hls_playlist_via_curl(
    live_request: &LiveHlsRequest,
) -> AppResult<LiveHlsPlaylistFetch> {
    let referer = browser_bound_live_hls_referer_header(live_request.referer.as_deref());
    let response = fetch_live_hls_via_curl(
        &live_request.source_url,
        referer.as_deref(),
        "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS playlist request failed with status {}.",
            response.status
        )));
    }
    // No redirects are followed, so the final host equals the validated source.
    ensure_allowed_live_hls_final_url(
        &live_request.source_url,
        live_request,
        LiveHlsRequestKind::Playlist,
    )?;
    Ok(LiveHlsPlaylistFetch {
        final_url: live_request.source_url.clone(),
        body: String::from_utf8_lossy(&response.bytes).into_owned(),
    })
}

async fn fetch_live_hls_resource_via_curl(
    live_request: &LiveHlsRequest,
) -> AppResult<LiveHlsResourceFetch> {
    let referer = browser_bound_live_hls_referer_header(live_request.referer.as_deref());
    let response =
        fetch_live_hls_via_curl(&live_request.source_url, referer.as_deref(), "*/*").await?;
    if !(200..300).contains(&response.status) {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS resource request failed with status {}.",
            response.status
        )));
    }
    ensure_allowed_live_hls_final_url(
        &live_request.source_url,
        live_request,
        LiveHlsRequestKind::Resource,
    )?;
    Ok(LiveHlsResourceFetch {
        content_type: response
            .content_type
            .unwrap_or_else(|| "application/octet-stream".to_owned()),
        bytes: response.bytes,
    })
}

async fn fetch_live_hls_playlist_via_http(
    state: &AppState,
    live_request: &LiveHlsRequest,
    referer: Option<&str>,
) -> AppResult<LiveHlsPlaylistFetch> {
    let mut request = state
        .http_client
        .get(live_request.source_url.clone())
        .header(reqwest::header::USER_AGENT, LIVE_HLS_BROWSER_USER_AGENT)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(referer) = referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let response = timeout(LIVE_UPSTREAM_REQUEST_TIMEOUT, request.send())
        .await
        .map_err(|_| ApiError::bad_gateway("Live HLS playlist request timed out."))?
        .map_err(|_| ApiError::bad_gateway("Live HLS playlist request failed."))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS playlist request failed with status {}.",
            response.status()
        )));
    }
    let final_url = response.url().clone();
    ensure_allowed_live_hls_final_url(&final_url, live_request, LiveHlsRequestKind::Playlist)?;
    let body = response
        .text()
        .await
        .map_err(|_| ApiError::bad_gateway("Live HLS playlist response could not be read."))?;
    Ok(LiveHlsPlaylistFetch { final_url, body })
}

async fn fetch_live_hls_resource_via_http(
    state: &AppState,
    live_request: &LiveHlsRequest,
    referer: Option<&str>,
) -> AppResult<LiveHlsResourceFetch> {
    let mut request = state
        .http_client
        .get(live_request.source_url.clone())
        .header(reqwest::header::USER_AGENT, LIVE_HLS_BROWSER_USER_AGENT)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(referer) = referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let response = timeout(LIVE_UPSTREAM_REQUEST_TIMEOUT, request.send())
        .await
        .map_err(|_| ApiError::bad_gateway("Live HLS resource request timed out."))?
        .map_err(|_| ApiError::bad_gateway("Live HLS resource request failed."))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "Live HLS resource request failed with status {}.",
            response.status()
        )));
    }
    let final_url = response.url().clone();
    ensure_allowed_live_hls_final_url(&final_url, live_request, LiveHlsRequestKind::Resource)?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ApiError::bad_gateway("Live HLS resource response could not be read."))?
        .to_vec();
    Ok(LiveHlsResourceFetch { content_type, bytes })
}

async fn fetch_live_hls_playlist_via_browser(
    live_request: &LiveHlsRequest,
) -> AppResult<LiveHlsPlaylistFetch> {
    let script_path = live_hls_browser_fetch_script_path();
    if matches!(
        script_path.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "disabled"
    ) {
        return Err(ApiError::bad_gateway(
            "Live HLS playlist request requires a browser-bound fetch.",
        ));
    }

    let referer_page = browser_bound_live_hls_page_url(live_request.referer.as_deref()).ok_or_else(
        || ApiError::bad_gateway("Live HLS browser fetch requires a player page referer."),
    )?;

    let mut command = Command::new("node");
    command
        .arg(script_path)
        .arg(live_request.source_url.as_str())
        .arg(referer_page.as_str())
        .env(
            "BROWSER_LIVE_HLS_FETCH_TIMEOUT_MS",
            (LIVE_HLS_BROWSER_FETCH_TIMEOUT_SECONDS * 1000).to_string(),
        )
        .kill_on_drop(true);

    let output = timeout(
        Duration::from_secs(LIVE_HLS_BROWSER_FETCH_TIMEOUT_SECONDS + 4),
        command.output(),
    )
    .await
    .map_err(|_| ApiError::bad_gateway("Live HLS browser fetch timed out."))?
    .map_err(|_| ApiError::bad_gateway("Live HLS browser fetch failed."))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let message = detail.trim();
        return Err(ApiError::bad_gateway(if message.is_empty() {
            "Live HLS browser fetch failed.".to_owned()
        } else {
            format!("Live HLS browser fetch failed: {message}")
        }));
    }

    let payload = serde_json::from_slice::<BrowserLiveHlsFetchOutput>(&output.stdout)
        .map_err(|_| ApiError::bad_gateway("Live HLS browser fetch returned invalid JSON."))?;
    let final_url = Url::parse(payload.final_url.trim())
        .or_else(|_| live_request.source_url.join(payload.final_url.trim()))
        .map_err(|_| ApiError::bad_gateway("Live HLS browser fetch returned an invalid URL."))?;
    if !payload.body.trim_start().starts_with("#EXTM3U") {
        return Err(ApiError::bad_gateway(
            "Live HLS browser fetch did not return an HLS playlist.",
        ));
    }
    Ok(LiveHlsPlaylistFetch {
        final_url,
        body: payload.body,
    })
}

fn live_hls_proxy_playlist_url_with_trust(
    input: &str,
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
) -> String {
    live_hls_proxy_url(
        "/api/live/hls.m3u8",
        input,
        referer,
        trusted_external_embed_secret,
    )
}

fn live_hls_proxy_resource_url_with_trust(
    input: &str,
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
) -> String {
    live_hls_proxy_url(
        "/api/live/hls-resource",
        input,
        referer,
        trusted_external_embed_secret,
    )
}

fn live_hls_proxy_url(
    path: &str,
    input: &str,
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
) -> String {
    let input = trusted_external_embed_secret
        .map(|_| normalize_live_hls_signature_input(input))
        .unwrap_or_else(|| input.to_owned());
    let normalized_referer = referer.and_then(normalize_hls_referer);
    let mut url = format!("{path}?input={}", encode_query_value(&input));
    if let Some(referer) = normalized_referer.as_deref() {
        url.push_str("&referer=");
        url.push_str(&encode_query_value(referer));
    }
    if let Some(secret) = trusted_external_embed_secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let signature = sign_live_hls_proxy_url(&input, normalized_referer.as_deref(), secret);
        url.push('&');
        url.push_str(LIVE_HLS_EXTERNAL_EMBED_PARAM);
        url.push_str("=1&");
        url.push_str(LIVE_HLS_SIGNATURE_PARAM);
        url.push('=');
        url.push_str(&encode_query_value(&signature));
    }
    url
}

fn resolve_hls_uri(base_url: &Url, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    base_url.join(trimmed).ok().map(|url| url.to_string())
}

fn is_allowed_live_hls_url(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }

    let Some(host) = url.host_str().map(|value| value.to_lowercase()) else {
        return false;
    };

    LIVE_HLS_ALLOWED_HOSTS
        .iter()
        .any(|allowed| host_matches_allowed_live_hls_host(&host, allowed))
}

fn host_matches_allowed_live_hls_host(host: &str, allowed: &str) -> bool {
    host == allowed
        || host
            .strip_suffix(allowed)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn is_trusted_external_embed_hls_request(
    source_url: &Url,
    kind: LiveHlsRequestKind,
    referer: Option<&str>,
    params: &BTreeMap<String, String>,
    live_hls_proxy_secret: &str,
) -> bool {
    if params
        .get(LIVE_HLS_EXTERNAL_EMBED_PARAM)
        .map(String::as_str)
        != Some("1")
    {
        return false;
    }
    let Some(signature) = params.get(LIVE_HLS_SIGNATURE_PARAM) else {
        return false;
    };
    if live_hls_proxy_secret.trim().is_empty()
        || !is_public_external_embed_hls_proxy_url(source_url, kind)
    {
        return false;
    }
    verify_live_hls_proxy_url_signature(
        source_url.as_str(),
        referer,
        signature,
        live_hls_proxy_secret,
    )
}

fn is_public_external_embed_hls_proxy_url(url: &Url, kind: LiveHlsRequestKind) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let _ = kind;
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    is_public_hls_proxy_hostname(&host)
}

fn is_public_hls_proxy_hostname(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.contains(':')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.parse::<Ipv4Addr>().is_ok()
    {
        return false;
    }
    host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
}

fn sign_live_hls_proxy_url(
    input: &str,
    referer: Option<&str>,
    live_hls_proxy_secret: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(live_hls_proxy_secret.as_bytes())
        .expect("HMAC accepts any key size");
    mac.update(LIVE_HLS_SIGNATURE_CONTEXT);
    mac.update(b"\0");
    mac.update(input.as_bytes());
    mac.update(b"\0");
    mac.update(referer.unwrap_or_default().as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn verify_live_hls_proxy_url_signature(
    input: &str,
    referer: Option<&str>,
    signature: &str,
    live_hls_proxy_secret: &str,
) -> bool {
    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(signature.trim()) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(live_hls_proxy_secret.as_bytes())
        .expect("HMAC accepts any key size");
    mac.update(LIVE_HLS_SIGNATURE_CONTEXT);
    mac.update(b"\0");
    mac.update(input.as_bytes());
    mac.update(b"\0");
    mac.update(referer.unwrap_or_default().as_bytes());
    mac.verify_slice(&signature_bytes).is_ok()
}

fn normalize_live_hls_signature_input(input: &str) -> String {
    Url::parse(input.trim())
        .map(|url| url.to_string())
        .unwrap_or_else(|_| input.trim().to_owned())
}

fn rewrite_live_hls_playlist(
    base_url: &Url,
    playlist: &str,
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
    direct_segments: bool,
) -> String {
    let lines: Vec<&str> = playlist.lines().collect();
    let is_master_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"));
    let is_media_playlist = lines
        .iter()
        .any(|line| line.trim_start().starts_with("#EXTINF"));

    if is_master_playlist {
        return rewrite_live_hls_master_playlist(
            base_url,
            &lines,
            referer,
            trusted_external_embed_secret,
            direct_segments,
        );
    }
    if is_media_playlist {
        return rewrite_live_hls_media_playlist(
            base_url,
            &lines,
            referer,
            trusted_external_embed_secret,
            direct_segments,
        );
    }
    playlist.to_owned()
}

/// Parse the height (e.g. 1080) from an `#EXT-X-STREAM-INF`/`#EXT-X-I-FRAME-STREAM-INF`
/// line's `RESOLUTION=WIDTHxHEIGHT` attribute. Returns None when absent/unparseable.
fn stream_inf_resolution_height(line: &str) -> Option<u32> {
    let upper = line.to_ascii_uppercase();
    let start = upper.find("RESOLUTION=")? + "RESOLUTION=".len();
    let value = upper[start..]
        .split([',', ' ', '\t'])
        .next()
        .unwrap_or_default();
    let (_width, height) = value.split_once('X')?;
    height.trim().parse::<u32>().ok()
}

/// Cap an external-embed master playlist to <= 720p by dropping taller variant
/// renditions (and their following URI line). External-embed VOD is proxied
/// through the mini's home uplink, so a 1080p ladder (~4.5 Mbps/viewer) starves
/// the uplink under concurrent load; 720p (~1.8 Mbps) roughly doubles the
/// concurrent-viewer headroom. Never strips every variant: if no rendition is
/// <= 720p (or none declare a resolution), the playlist is returned unchanged.
fn cap_external_embed_master_to_720p<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    const MAX_HEIGHT: u32 = 720;
    let has_keepable = lines
        .iter()
        .filter(|line| {
            let t = line.trim_start();
            t.starts_with("#EXT-X-STREAM-INF")
        })
        .any(|line| stream_inf_resolution_height(line).is_none_or(|height| height <= MAX_HEIGHT));
    if !has_keepable {
        return lines.to_vec();
    }
    let mut out = Vec::with_capacity(lines.len());
    let mut drop_next_uri = false;
    for &line in lines {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#EXT-X-STREAM-INF") {
            if stream_inf_resolution_height(line).is_some_and(|height| height > MAX_HEIGHT) {
                drop_next_uri = true; // also drop the URI line that follows it
                continue;
            }
            drop_next_uri = false;
            out.push(line);
            continue;
        }
        if trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF") {
            // The URI is inline in the attribute list, so dropping the line suffices.
            if stream_inf_resolution_height(line).is_some_and(|height| height > MAX_HEIGHT) {
                continue;
            }
            out.push(line);
            continue;
        }
        if drop_next_uri {
            drop_next_uri = false;
            // The variant URI is the first non-comment, non-blank line after the
            // dropped STREAM-INF; defensively keep anything else.
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                continue;
            }
        }
        out.push(line);
    }
    out
}

fn rewrite_live_hls_master_playlist(
    base_url: &Url,
    lines: &[&str],
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
    direct_segments: bool,
) -> String {
    // Trusted-embed streams (external-embed VOD, and sports — both signed via
    // build_trusted_external_embed_hls_playback_source) are proxied through the
    // mini's bandwidth-limited home uplink, so cap their quality ladder to 720p.
    // This is a no-op for single-quality streams (most live sports, which serve
    // one transcoded rendition); it only reshapes multi-variant ladders (VOD
    // movie/TV embeds), exactly where the uplink relief is needed. Skip the cap
    // in direct-segment mode: those bytes stream off the source CDN, not the
    // uplink, so the full quality ladder is free.
    let capped_storage;
    let lines: &[&str] = if trusted_external_embed_secret.is_some() && !direct_segments {
        capped_storage = cap_external_embed_master_to_720p(lines);
        &capped_storage
    } else {
        lines
    };
    let mut rewritten = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            rewritten.push(line.to_owned());
            continue;
        }

        if line.starts_with('#') {
            let rewritten_line = rewrite_hls_uri_attribute(
                base_url,
                line,
                referer,
                |input, referer| {
                    if let Some(direct) = direct_hls_url_if_eligible(input, direct_segments) {
                        return direct;
                    }
                    if line.starts_with("#EXT-X-MEDIA:")
                        || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                    {
                        live_hls_proxy_playlist_url_with_trust(
                            input,
                            referer,
                            trusted_external_embed_secret,
                        )
                    } else {
                        live_hls_proxy_resource_url_with_trust(
                            input,
                            referer,
                            trusted_external_embed_secret,
                        )
                    }
                },
            );
            rewritten.push(strip_video_only_stream_inf_codecs(&rewritten_line));
            continue;
        }

        if let Some(absolute_uri) = resolve_hls_uri(base_url, line) {
            // Variant playlist URI: leave it direct when the host serves the
            // browser cross-origin (LordFlix tcloud), so the whole variant +
            // segment chain bypasses the Mini; otherwise proxy as usual.
            rewritten.push(
                direct_hls_url_if_eligible(&absolute_uri, direct_segments).unwrap_or_else(|| {
                    live_hls_proxy_playlist_url_with_trust(
                        &absolute_uri,
                        referer,
                        trusted_external_embed_secret,
                    )
                }),
            );
        } else {
            rewritten.push(line.to_owned());
        }
    }
    if should_prefer_english_hls_audio(base_url, referer) {
        rewritten = prefer_english_hls_audio_defaults(rewritten);
    }
    rewritten.join("\n")
}

/// Drop a `CODECS="..."` attribute from an `#EXT-X-STREAM-INF` line when it only
/// declares a video codec. Some upstreams (e.g. NTVS/hesgoaler MP2 streams) ship
/// muxed audio+video but advertise just the video codec, which makes hls.js set
/// up a video-only buffer and break once audio appears. With CODECS removed,
/// hls.js probes the actual (possibly transcoded) segments instead.
fn strip_video_only_stream_inf_codecs(line: &str) -> String {
    if !line.trim_start().starts_with("#EXT-X-STREAM-INF") {
        return line.to_owned();
    }
    let lower = line.to_ascii_lowercase();
    if !lower.contains("codecs=") {
        return line.to_owned();
    }
    let declares_audio_codec = ["mp4a", "ac-3", "ec-3", "opus", "flac", "alac", "dts"]
        .iter()
        .any(|needle| lower.contains(needle));
    if declares_audio_codec {
        return line.to_owned();
    }
    remove_stream_inf_codecs_attribute(line)
}

fn remove_stream_inf_codecs_attribute(line: &str) -> String {
    let Some((tag, attributes)) = line.split_once(':') else {
        return line.to_owned();
    };
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in attributes.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            ',' if !in_quotes => parts.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let kept = parts
        .into_iter()
        .filter(|attr| {
            !attr
                .trim_start()
                .to_ascii_uppercase()
                .starts_with("CODECS=")
        })
        .collect::<Vec<_>>();
    format!("{tag}:{}", kept.join(","))
}

fn rewrite_live_hls_media_playlist(
    base_url: &Url,
    lines: &[&str],
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
    direct_segments: bool,
) -> String {
    let is_vod_playlist = lines.iter().any(|line| {
        let line = line.trim();
        line.eq_ignore_ascii_case("#EXT-X-ENDLIST")
            || line.eq_ignore_ascii_case("#EXT-X-PLAYLIST-TYPE:VOD")
    });
    if is_vod_playlist {
        return rewrite_vod_hls_media_playlist(
            base_url,
            lines,
            referer,
            trusted_external_embed_secret,
            direct_segments,
        );
    }

    let mut header = Vec::new();
    let mut pending_block = Vec::new();
    let mut segment_blocks: Vec<Vec<String>> = Vec::new();
    let mut original_media_sequence = 0_i64;
    let mut saw_segment = false;

    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            original_media_sequence = value.trim().parse::<i64>().unwrap_or_default();
            continue;
        }

        if line.starts_with("#EXT-X-ENDLIST") {
            continue;
        }

        if line.starts_with('#') {
            if !saw_segment
                && !line.starts_with("#EXTINF")
                && !line.starts_with("#EXT-X-KEY")
                && !line.starts_with("#EXT-X-MAP")
                && !line.starts_with("#EXT-X-PROGRAM-DATE-TIME")
                && !line.starts_with("#EXT-X-DISCONTINUITY")
            {
                header.push(rewrite_hls_uri_attribute(
                    base_url,
                    line,
                    referer,
                    |input, referer| {
                        if let Some(direct) = direct_hls_url_if_eligible(input, direct_segments) {
                            return direct;
                        }
                        let referer = live_hls_resource_referer_for_url(base_url, input, referer);
                        live_hls_proxy_resource_url_with_trust(
                            input,
                            referer,
                            trusted_external_embed_secret,
                        )
                    },
                ));
            } else {
                pending_block.push(rewrite_hls_uri_attribute(
                    base_url,
                    line,
                    referer,
                    |input, referer| {
                        if let Some(direct) = direct_hls_url_if_eligible(input, direct_segments) {
                            return direct;
                        }
                        let referer = live_hls_resource_referer_for_url(base_url, input, referer);
                        live_hls_proxy_resource_url_with_trust(
                            input,
                            referer,
                            trusted_external_embed_secret,
                        )
                    },
                ));
            }
            continue;
        }

        saw_segment = true;
        let segment_uri = resolve_hls_uri(base_url, line)
            .map(|absolute_uri| {
                if let Some(direct) = direct_hls_url_if_eligible(&absolute_uri, direct_segments) {
                    return direct;
                }
                let referer = live_hls_resource_referer_for_url(base_url, &absolute_uri, referer);
                live_hls_proxy_resource_url_with_trust(
                    &absolute_uri,
                    referer,
                    trusted_external_embed_secret,
                )
            })
            .unwrap_or_else(|| line.to_owned());
        pending_block.push(segment_uri);
        segment_blocks.push(std::mem::take(&mut pending_block));
    }

    if segment_blocks.is_empty() {
        return lines.join("\n");
    }

    if !header.iter().any(|line| line == "#EXTM3U") {
        header.insert(0, "#EXTM3U".to_owned());
    }
    header.push("#EXT-X-START:TIME-OFFSET=-18,PRECISE=NO".to_owned());

    let dropped_segments = segment_blocks
        .len()
        .saturating_sub(LIVE_HLS_EDGE_SEGMENT_COUNT);
    let next_media_sequence = original_media_sequence + dropped_segments as i64;
    let kept_blocks = segment_blocks.into_iter().skip(dropped_segments);

    let mut rewritten = header;
    rewritten.push(format!("#EXT-X-MEDIA-SEQUENCE:{next_media_sequence}"));
    for block in kept_blocks {
        rewritten.extend(block);
    }
    rewritten.join("\n")
}

fn rewrite_vod_hls_media_playlist(
    base_url: &Url,
    lines: &[&str],
    referer: Option<&str>,
    trusted_external_embed_secret: Option<&str>,
    direct_segments: bool,
) -> String {
    let mut rewritten = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            rewritten.push(line.to_owned());
            continue;
        }

        if line.starts_with('#') {
            rewritten.push(rewrite_hls_uri_attribute(
                base_url,
                line,
                referer,
                |input, referer| {
                    if let Some(direct) = direct_hls_url_if_eligible(input, direct_segments) {
                        return direct;
                    }
                    let referer = live_hls_resource_referer_for_url(base_url, input, referer);
                    live_hls_proxy_resource_url_with_trust(
                        input,
                        referer,
                        trusted_external_embed_secret,
                    )
                },
            ));
            continue;
        }

        let segment_uri = resolve_hls_uri(base_url, line)
            .map(|absolute_uri| {
                if let Some(direct) = direct_hls_url_if_eligible(&absolute_uri, direct_segments) {
                    return direct;
                }
                let referer = live_hls_resource_referer_for_url(base_url, &absolute_uri, referer);
                live_hls_proxy_resource_url_with_trust(
                    &absolute_uri,
                    referer,
                    trusted_external_embed_secret,
                )
            })
            .unwrap_or_else(|| line.to_owned());
        rewritten.push(segment_uri);
    }
    rewritten.join("\n")
}

fn live_hls_resource_referer_for_url<'a>(
    base_url: &Url,
    input: &str,
    referer: Option<&'a str>,
) -> Option<&'a str> {
    if should_omit_hls_resource_referer(base_url, input, referer) {
        None
    } else {
        referer
    }
}

fn should_omit_hls_resource_referer(base_url: &Url, input: &str, referer: Option<&str>) -> bool {
    if !referer
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| {
            url.host_str()
                .map(|host| host.eq_ignore_ascii_case("vidlink.pro"))
        })
        .unwrap_or(false)
    {
        return false;
    }

    let Ok(resource_url) = Url::parse(input) else {
        return false;
    };
    let Some(resource_host) = resource_url.host_str() else {
        return false;
    };
    let Some(base_host) = base_url.host_str() else {
        return false;
    };
    !resource_host.eq_ignore_ascii_case(base_host)
}

fn rewrite_hls_uri_attribute<F>(
    base_url: &Url,
    line: &str,
    referer: Option<&str>,
    proxy_url_builder: F,
) -> String
where
    F: Fn(&str, Option<&str>) -> String,
{
    let Some(uri_start) = line.find("URI=\"") else {
        return line.to_owned();
    };
    let value_start = uri_start + 5;
    let Some(relative_end) = line[value_start..].find('"') else {
        return line.to_owned();
    };
    let value_end = value_start + relative_end;
    let uri_value = &line[value_start..value_end];
    let Some(absolute_uri) = resolve_hls_uri(base_url, uri_value) else {
        return line.to_owned();
    };
    let proxied_uri = proxy_url_builder(&absolute_uri, referer);
    format!(
        "{}{}{}",
        &line[..value_start],
        proxied_uri,
        &line[value_end..]
    )
}

fn should_prefer_english_hls_audio(base_url: &Url, referer: Option<&str>) -> bool {
    hls_url_looks_like_vixsrc(base_url)
        || referer
            .and_then(|value| Url::parse(value).ok())
            .map(|url| hls_url_looks_like_vixsrc(&url))
            .unwrap_or(false)
}

fn hls_url_looks_like_vixsrc(url: &Url) -> bool {
    url.host_str()
        .map(|host| {
            let host = host.to_ascii_lowercase();
            host == "vixsrc.to" || host.ends_with(".vixsrc.to")
        })
        .unwrap_or(false)
}

fn prefer_english_hls_audio_defaults(lines: Vec<String>) -> Vec<String> {
    let has_english_audio = lines
        .iter()
        .any(|line| hls_line_is_audio_media(line) && hls_media_line_looks_english(line));
    if !has_english_audio {
        return lines;
    }

    lines
        .into_iter()
        .map(|line| {
            if !hls_line_is_audio_media(&line) {
                return line;
            }
            let is_english = hls_media_line_looks_english(&line);
            let line = set_hls_boolean_attribute(&line, "DEFAULT", is_english);
            set_hls_boolean_attribute(&line, "AUTOSELECT", is_english)
        })
        .collect()
}

fn hls_line_is_audio_media(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("#ext-x-media:") && lower.contains("type=audio")
}

fn hls_media_line_looks_english(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("language=\"eng\"")
        || lower.contains("language=eng")
        || lower.contains("language=\"en\"")
        || lower.contains("language=en")
        || lower.contains("name=\"english\"")
        || lower.contains("name=english")
}

fn set_hls_boolean_attribute(line: &str, attribute: &str, enabled: bool) -> String {
    let Some(start) = find_hls_attribute_start(line, attribute) else {
        return format!("{line},{attribute}={}", if enabled { "YES" } else { "NO" });
    };
    let value_start = start + attribute.len() + 1;
    let value_end = line[value_start..]
        .find(',')
        .map(|offset| value_start + offset)
        .unwrap_or(line.len());
    format!(
        "{}{}{}",
        &line[..value_start],
        if enabled { "YES" } else { "NO" },
        &line[value_end..]
    )
}

fn find_hls_attribute_start(line: &str, attribute: &str) -> Option<usize> {
    let target = format!("{attribute}=");
    let upper = line.to_ascii_uppercase();
    let mut search_start = 0;
    while let Some(relative_index) = upper[search_start..].find(&target) {
        let index = search_start + relative_index;
        if index == 0 || line.as_bytes().get(index.wrapping_sub(1)) == Some(&b',') {
            return Some(index);
        }
        search_start = index + target.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        LiveHlsRequestKind, audio_codec_needs_live_transcode,
        build_sports_live_hls_playback_source,
        build_trusted_external_embed_hls_playback_source,
        browser_bound_live_hls_referer_header, host_matches_allowed_live_hls_host,
        is_allowed_live_hls_url, is_browser_bound_live_hls_upstream, is_live_ts_segment,
        is_public_external_embed_hls_proxy_url, is_trusted_external_embed_hls_request,
        live_audio_stream_key, normalize_hls_referer, query_pairs, rewrite_live_hls_playlist,
        strip_video_only_stream_inf_codecs,
    };

    #[test]
    fn first_live_resource_input_extracts_segment_url() {
        let playlist = "#EXTM3U\n#EXTINF:6.0,\n/api/live/hls-resource?input=https%3A%2F%2Fcdn.example.com%2Fseg%2F1.ts&referer=https%3A%2F%2Fr%2F&externalEmbed=1&sig=abc\n";
        assert_eq!(
            super::first_live_resource_input(playlist).as_deref(),
            Some("https://cdn.example.com/seg/1.ts"),
        );
        assert_eq!(
            super::first_live_resource_input("#EXTM3U\nno-resources-here\n"),
            None,
        );
    }

    #[test]
    fn signed_live_hls_requests_bypass_session_auth_only_with_valid_signature() {
        let secret = "test-live-hls-proxy-secret-with-enough-length";
        let signed = build_trusted_external_embed_hls_playback_source(
            "https://cdn.example.com/live/index.m3u8",
            Some("https://embed.st/embed/admin/game/1"),
            secret,
        );
        let uri: axum::http::Uri = signed.parse().expect("signed uri");
        assert!(super::is_signed_live_hls_request(secret, &uri));
        // Wrong secret, tampered input, missing signature, foreign path: all
        // fall back to session auth.
        assert!(!super::is_signed_live_hls_request(
            "wrong-secret-with-enough-length",
            &uri
        ));
        let tampered: axum::http::Uri = signed
            .replace("input=https%3A%2F%2Fcdn", "input=https%3A%2F%2Fevil")
            .parse()
            .expect("tampered uri");
        assert!(!super::is_signed_live_hls_request(secret, &tampered));
        let unsigned: axum::http::Uri =
            "/api/live/hls.m3u8?input=https%3A%2F%2Fwww.bloomberg.com%2Flive.m3u8"
                .parse()
                .expect("unsigned uri");
        assert!(!super::is_signed_live_hls_request(secret, &unsigned));
        let foreign: axum::http::Uri = "/api/user/preferences".parse().expect("foreign uri");
        assert!(!super::is_signed_live_hls_request(secret, &foreign));
        assert!(!super::is_signed_live_hls_request("", &uri));
    }

    #[test]
    fn routes_signed_live_playlists_to_worker_base() {
        let signed = "/api/live/hls.m3u8?input=https%3A%2F%2Fcdn%2Flive.m3u8&externalEmbed=1&sig=abc";
        assert_eq!(
            super::route_live_playback_source_via_worker(
                "https://live.example.workers.dev/",
                signed.to_owned(),
            ),
            format!("https://live.example.workers.dev{signed}"),
        );
        // Disabled flag and non-live sources pass through untouched.
        assert_eq!(
            super::route_live_playback_source_via_worker("  ", signed.to_owned()),
            signed,
        );
        assert_eq!(
            super::route_live_playback_source_via_worker(
                "https://live.example.workers.dev",
                "https://cdn.example.com/direct.m3u8".to_owned(),
            ),
            "https://cdn.example.com/direct.m3u8",
        );
    }

    #[test]
    fn live_hls_signature_matches_cross_checked_vector() {
        // Cross-checked against an independent HMAC-SHA256 (Web Crypto / Node) so
        // the Cloudflare live-proxy Worker validates the exact signatures the
        // backend produces. Changing this output breaks Worker verification.
        let sig = super::sign_live_hls_proxy_url(
            "https://www.bloomberg.com/parity-probe.ts",
            Some("https://example.test/"),
            "paritytest12345",
        );
        assert_eq!(sig, "cxrB-f12ka967rfMS41UeX4azDD4cso-lAwbwwX90Qs");
    }

    #[test]
    fn strips_video_only_codecs_but_keeps_complete_ones() {
        // Video-only CODECS (the Nova Sports 1 MP2 case) gets stripped.
        let video_only = "#EXT-X-STREAM-INF:BANDWIDTH=8730000,RESOLUTION=1920x1080,CODECS=\"avc1.640029\"";
        let stripped = strip_video_only_stream_inf_codecs(video_only);
        assert!(!stripped.to_ascii_lowercase().contains("codecs="));
        assert!(stripped.contains("BANDWIDTH=8730000"));
        assert!(stripped.contains("RESOLUTION=1920x1080"));

        // Audio+video CODECS (the working Nova Sports 2 case) is preserved.
        let complete =
            "#EXT-X-STREAM-INF:BANDWIDTH=6190000,CODECS=\"avc1.4d4029,mp4a.40.2\",RESOLUTION=1280x720";
        assert_eq!(strip_video_only_stream_inf_codecs(complete), complete);

        // Non STREAM-INF lines are untouched.
        let other = "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",CODECS=\"mp4a.40.2\"";
        assert_eq!(strip_video_only_stream_inf_codecs(other), other);
    }

    #[test]
    fn classifies_live_audio_transcode_need() {
        assert!(audio_codec_needs_live_transcode("mp2"));
        assert!(audio_codec_needs_live_transcode("ac3"));
        assert!(!audio_codec_needs_live_transcode("aac"));
        assert!(!audio_codec_needs_live_transcode("mp3"));
        assert!(!audio_codec_needs_live_transcode(""));
    }

    #[test]
    fn derives_stable_live_audio_stream_key_ignoring_token() {
        let a: url::Url =
            "https://lovely.lovetier.bz/NOVASPORTS1/tracks-v1a1/seg-1.ts?token=abc".parse().unwrap();
        let b: url::Url =
            "https://lovely.lovetier.bz/NOVASPORTS1/tracks-v1a1/seg-2.ts?token=xyz".parse().unwrap();
        assert_eq!(live_audio_stream_key(&a), live_audio_stream_key(&b));
        assert_eq!(live_audio_stream_key(&a), "lovely.lovetier.bz/NOVASPORTS1");

        let other: url::Url =
            "https://lovely.lovetier.bz/NOVASPORTS2/tracks-v1a1/seg-1.ts".parse().unwrap();
        assert_ne!(live_audio_stream_key(&a), live_audio_stream_key(&other));
    }

    #[test]
    fn detects_ts_segments() {
        let ts: url::Url = "https://host.example/path/seg.ts".parse().unwrap();
        assert!(is_live_ts_segment(&ts, "application/octet-stream"));
        let m3u8: url::Url = "https://host.example/path/index.m3u8".parse().unwrap();
        assert!(!is_live_ts_segment(&m3u8, "application/vnd.apple.mpegurl"));
        let by_content: url::Url = "https://host.example/path/seg".parse().unwrap();
        assert!(is_live_ts_segment(&by_content, "video/mp2t"));
    }

    #[test]
    fn live_hls_proxy_rejects_unapproved_hosts() {
        let allowed: url::Url = "https://www.bloomberg.com/media-manifest/streams/us.m3u8"
            .parse()
            .expect("allowed url");
        let bloomberg_variant: url::Url = "https://liveproduseast.global.ssl.fastly.net/us/Channel-USTV-AWS-virginia-2/Source-USTV-10000-1-slxdlg-BP-HD-7-oQALjcQ9CJcP_live.m3u8"
            .parse()
            .expect("bloomberg variant url");
        let bloomberg_akamai_variant: url::Url = "https://liveproduseast.akamaized.net/us/Channel-USTV-AWS-virginia-2/Source-USTV-10000-1-slxdlg-BP-HD-7-oQALjcQ9CJcP_live.m3u8"
            .parse()
            .expect("bloomberg akamai variant url");
        let sky_news: url::Url = "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8"
            .parse()
            .expect("sky news url");
        let ert1: url::Url = "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERT1/default/index.m3u8"
            .parse()
            .expect("ert1 url");
        let mega_news: url::Url = "https://streamcdnb2-c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8"
            .parse()
            .expect("mega news url");
        let ant1: url::Url = "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8"
            .parse()
            .expect("ant1 url");
        let alpha_tv: url::Url =
            "https://alphatvlive2-ak.siliconweb.com/alphatvlive/live_abr/playlist.m3u8"
                .parse()
                .expect("alpha tv url");
        let twitch_master: url::Url =
            "https://usher.ttvnw.net/api/channel/hls/topmedia_topnews.m3u8"
                .parse()
                .expect("twitch master url");
        let twitch_variant: url::Url = "https://euw12.playlist.ttvnw.net/v1/playlist/live.m3u8"
            .parse()
            .expect("twitch variant url");
        let twitch_segment: url::Url =
            "https://91334ab1a2f2.j.cloudfront.hls.ttvnw.net/v1/segment/live.ts"
                .parse()
                .expect("twitch segment url");
        let streamed_sports: url::Url =
            "https://lb12.strmd.top/secure/token/rtmp/stream/id/1/playlist.m3u8"
                .parse()
                .expect("streamed sports url");
        let ntvs_sports: url::Url =
            "https://lb10.strmd.st/secure/token/rtmp/stream/id/1/playlist.m3u8"
                .parse()
                .expect("ntvs sports url");
        let ntvs_hesgoaler: url::Url =
            "https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8?token=abc"
                .parse()
                .expect("ntvs hesgoaler url");
        let matchstream_sports: url::Url =
            "https://cdn6.zohanayaan.com:1686/hls/do6.m3u8?md5=abc&expires=1780252412"
                .parse()
                .expect("matchstream sports url");
        let videasy_hls: url::Url = "https://easy.speedsterwave.app/example/index.m3u8"
            .parse()
            .expect("videasy hls url");
        let videasy_new_hls: url::Url = "https://easy.nightspeedster.app/example/index.m3u8"
            .parse()
            .expect("videasy new hls url");
        let videasy_mousedoor_hls: url::Url = "https://hello.mousedoor.com/example/index.m3u8"
            .parse()
            .expect("videasy mousedoor hls url");
        let videasy_yoru_hls: url::Url = "https://yoru.midwesteagle.com/video.m3u8"
            .parse()
            .expect("videasy yoru hls url");
        let videasy_segment_redirect: url::Url =
            "https://www.cloudflare-terms-of-service-abuse.com/stream.ts"
                .parse()
                .expect("videasy redirected segment url");
        let vidlink_hls: url::Url = "https://storm.vodvidl.site/example/index.m3u8"
            .parse()
            .expect("vidlink hls url");
        let vidlink_new_hls: url::Url = "https://typhoontigertribe.net/example/index.m3u8"
            .parse()
            .expect("vidlink new hls url");
        let disallowed: url::Url = "https://example.com/live.m3u8"
            .parse()
            .expect("disallowed url");
        let local: url::Url = "http://127.0.0.1/private.m3u8".parse().expect("local url");

        assert!(is_allowed_live_hls_url(&allowed));
        assert!(is_allowed_live_hls_url(&bloomberg_variant));
        assert!(is_allowed_live_hls_url(&bloomberg_akamai_variant));
        assert!(is_allowed_live_hls_url(&sky_news));
        assert!(is_allowed_live_hls_url(&ert1));
        assert!(is_allowed_live_hls_url(&mega_news));
        assert!(is_allowed_live_hls_url(&ant1));
        assert!(is_allowed_live_hls_url(&alpha_tv));
        assert!(is_allowed_live_hls_url(&twitch_master));
        assert!(is_allowed_live_hls_url(&twitch_variant));
        assert!(is_allowed_live_hls_url(&twitch_segment));
        assert!(is_allowed_live_hls_url(&streamed_sports));
        assert!(is_allowed_live_hls_url(&ntvs_sports));
        assert!(is_allowed_live_hls_url(&ntvs_hesgoaler));
        assert!(is_allowed_live_hls_url(&matchstream_sports));
        assert!(is_allowed_live_hls_url(&videasy_hls));
        assert!(is_allowed_live_hls_url(&videasy_new_hls));
        assert!(is_allowed_live_hls_url(&videasy_mousedoor_hls));
        assert!(is_allowed_live_hls_url(&videasy_yoru_hls));
        assert!(is_allowed_live_hls_url(&videasy_segment_redirect));
        assert!(is_allowed_live_hls_url(&vidlink_hls));
        assert!(is_allowed_live_hls_url(&vidlink_new_hls));
        assert!(!is_allowed_live_hls_url(&disallowed));
        assert!(!is_allowed_live_hls_url(&local));
    }

    #[test]
    fn live_hls_host_matching_requires_domain_boundary() {
        assert!(host_matches_allowed_live_hls_host(
            "media.example.com",
            "example.com"
        ));
        assert!(host_matches_allowed_live_hls_host(
            "example.com",
            "example.com"
        ));
        assert!(!host_matches_allowed_live_hls_host(
            "badexample.com",
            "example.com"
        ));
        assert!(!host_matches_allowed_live_hls_host(
            "example.com.evil.test",
            "example.com"
        ));
    }

    #[test]
    fn trusted_external_embed_hls_signature_allows_public_rotated_hosts() {
        let secret = "test-live-hls-proxy-secret-with-enough-length";
        let referer = Some("https://player.videasy.to/tv/273240/1/4?color=ffd700");
        let playback_url = build_trusted_external_embed_hls_playback_source(
            "https://rotated-videasy-cdn.example.com/title/index.m3u8",
            referer,
            secret,
        );
        let uri: axum::http::Uri = playback_url.parse().expect("signed playback uri");
        let params = query_pairs(uri.query().unwrap_or_default());
        let source_url: url::Url = params
            .get("input")
            .expect("input param")
            .parse()
            .expect("source url");
        let normalized_referer = params
            .get("referer")
            .and_then(|value| normalize_hls_referer(value));

        assert!(!is_allowed_live_hls_url(&source_url));
        assert!(is_trusted_external_embed_hls_request(
            &source_url,
            LiveHlsRequestKind::Playlist,
            normalized_referer.as_deref(),
            &params,
            secret,
        ));
        assert!(!is_trusted_external_embed_hls_request(
            &source_url,
            LiveHlsRequestKind::Playlist,
            normalized_referer.as_deref(),
            &params,
            "wrong-secret-with-enough-length",
        ));
    }

    #[test]
    fn trusted_external_embed_hls_rejects_local_and_accepts_public_playlist_urls() {
        let secret = "test-live-hls-proxy-secret-with-enough-length";
        let local_url: url::Url = "https://localhost/title/index.m3u8"
            .parse()
            .expect("local hls url");
        let non_playlist_url: url::Url = "https://rotated-videasy-cdn.example.com/title/video.mp4"
            .parse()
            .expect("non-playlist url");

        assert!(!is_public_external_embed_hls_proxy_url(
            &local_url,
            LiveHlsRequestKind::Playlist
        ));
        assert!(is_public_external_embed_hls_proxy_url(
            &non_playlist_url,
            LiveHlsRequestKind::Playlist
        ));
        assert!(is_public_external_embed_hls_proxy_url(
            &non_playlist_url,
            LiveHlsRequestKind::Resource
        ));

        let playback_url = build_trusted_external_embed_hls_playback_source(
            local_url.as_str(),
            Some("https://player.videasy.to/movie/1"),
            secret,
        );
        let uri: axum::http::Uri = playback_url.parse().expect("signed playback uri");
        let params = query_pairs(uri.query().unwrap_or_default());
        assert!(!is_trusted_external_embed_hls_request(
            &local_url,
            LiveHlsRequestKind::Playlist,
            params
                .get("referer")
                .and_then(|value| normalize_hls_referer(value))
                .as_deref(),
            &params,
            secret,
        ));
    }

    #[test]
    fn rewrites_master_playlist_entries_through_live_proxy() {
        let base: url::Url = "https://www.bloomberg.com/media-manifest/master.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild/main.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(&base, playlist, None, None, false);

        assert!(rewritten.contains("/api/live/hls.m3u8?input="));
        assert!(rewritten.contains("child%2Fmain.m3u8"));
    }

    #[test]
    fn rewrites_master_playlist_uri_attributes_through_live_proxy() {
        let base: url::Url = "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio1\",URI=\"08_1080-30.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n07_1080-30.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(&base, playlist, None, None, false);

        assert!(rewritten.contains("/api/live/hls.m3u8?input="));
        assert!(rewritten.contains("08_1080-30.m3u8"));
        assert!(rewritten.contains("07_1080-30.m3u8"));
        assert!(!rewritten.contains("URI=\"08_1080-30.m3u8\""));
    }

    #[test]
    fn vixsrc_master_playlist_prefers_english_audio_when_available() {
        let base: url::Url = "https://vixsrc.to/playlist/123/master.m3u8?token=abc"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Italian\",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE=\"ita\",URI=\"ita.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE=\"eng\",URI=\"eng.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"audio\"\nmain.m3u8\n";
        let rewritten = rewrite_live_hls_playlist(
            &base,
            playlist,
            Some("https://vixsrc.to/api/tv/273240/1/1"),
            None,
            false,
        );

        assert!(rewritten.contains("NAME=\"Italian\",DEFAULT=NO,AUTOSELECT=NO"));
        assert!(rewritten.contains("NAME=\"English\",DEFAULT=YES,AUTOSELECT=YES"));
    }

    #[test]
    fn rewrites_media_playlist_segments_and_referer_through_live_proxy() {
        let base: url::Url = "https://media.example.28585519.net/hls/live.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:4.0,\nseg-1.ts\n";
        let rewritten = rewrite_live_hls_playlist(
            &base,
            playlist,
            Some("https://helpless.click/e/player"),
            None,
            false,
        );

        assert!(rewritten.contains("/api/live/hls-resource?input="));
        assert!(rewritten.contains("seg-1.ts"));
        assert!(rewritten.contains("referer=https%3A%2F%2Fhelpless.click%2Fe%2Fplayer"));
    }

    #[test]
    fn omits_vidlink_referer_for_cross_host_media_segments() {
        let base: url::Url = "https://lunarleopardlife.net/title/media.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://lunarleopardlife.net/title/key.bin\"\n#EXTINF:4.0,\nhttps://astroalpacarain.com/title/seg-1.ts\n#EXT-X-ENDLIST\n";
        let rewritten = rewrite_live_hls_playlist(
            &base,
            playlist,
            Some("https://vidlink.pro/tv/1396/1/1"),
            Some("test-live-hls-proxy-secret-with-enough-length"),
            false,
        );
        let key_line = rewritten
            .lines()
            .find(|line| line.contains("key.bin"))
            .expect("key line");
        let segment_line = rewritten
            .lines()
            .find(|line| line.contains("astroalpacarain.com"))
            .expect("segment line");

        assert!(key_line.contains("referer=https%3A%2F%2Fvidlink.pro%2Ftv%2F1396%2F1%2F1"));
        assert!(!segment_line.contains("referer="));
    }

    #[test]
    fn preserves_vod_media_playlist_segments_through_live_proxy() {
        let base: url::Url = "https://easy.speedsterwave.app/title/index.m3u8"
            .parse()
            .expect("base url");
        let playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nseg-2.ts\n#EXTINF:4.0,\nseg-3.ts\n#EXTINF:4.0,\nseg-4.ts\n#EXTINF:4.0,\nseg-5.ts\n#EXTINF:4.0,\nseg-6.ts\n#EXTINF:4.0,\nseg-7.ts\n#EXTINF:4.0,\nseg-8.ts\n#EXTINF:4.0,\nseg-9.ts\n#EXT-X-ENDLIST\n";
        let rewritten = rewrite_live_hls_playlist(
            &base,
            playlist,
            Some("https://player.videasy.to/movie/1"),
            None,
            false,
        );

        assert!(rewritten.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(rewritten.contains("#EXT-X-MEDIA-SEQUENCE:1"));
        assert!(rewritten.contains("#EXT-X-ENDLIST"));
        assert!(rewritten.contains("seg-1.ts"));
        assert!(rewritten.contains("seg-9.ts"));
        assert!(!rewritten.contains("#EXT-X-START:TIME-OFFSET=-18"));
    }

    #[test]
    fn browser_bound_live_hls_hosts_prefer_direct_playback() {
        let strmd: url::Url =
            "https://lb10.strmd.st/secure/token/rtmp/stream/id/1/playlist.m3u8".parse().unwrap();
        let strmd_top: url::Url =
            "https://lb12.strmd.top/secure/token/rtmp/stream/id/1/playlist.m3u8".parse().unwrap();
        let hesgoaler: url::Url =
            "https://lovely.lovetier.bz/NOVASPORTS1/index.m3u8?token=abc".parse().unwrap();

        assert!(is_browser_bound_live_hls_upstream(&strmd));
        assert!(is_browser_bound_live_hls_upstream(&strmd_top));
        assert!(!is_browser_bound_live_hls_upstream(&hesgoaler));

        let secret = "test-live-hls-proxy-secret-with-enough-length";
        let referer = "https://embed.st/embed/admin/ppv-croatia-vs-slovenia/1";
        assert!(build_sports_live_hls_playback_source(strmd.as_str(), Some(referer), secret)
            .starts_with("/api/live/hls.m3u8?"));
        assert!(build_sports_live_hls_playback_source(
            hesgoaler.as_str(),
            Some(referer),
            secret
        )
        .starts_with("/api/live/hls.m3u8?"));
    }

    #[test]
    fn curl_fetch_hosts_cover_vidlink_cdn_but_not_others() {
        let storm: url::Url = "https://storm.vodvidl.site/proxy/wiwii/abc/playlist.m3u8?auth=x"
            .parse()
            .unwrap();
        let storm_sub: url::Url = "https://edge.vodvidl.site/proxy/abc/seg-1.ts".parse().unwrap();
        let typhoon: url::Url = "https://typhoontigertribe.net/example/index.m3u8".parse().unwrap();
        let vixsrc: url::Url = "https://vixsrc.to/playlist/231752?token=x&expires=1".parse().unwrap();
        let vixcdn: url::Url =
            "https://sc-u5-01.vix-content.net/hls/10/3/1f/uuid/video/480p/0000-0500.ts?token=x"
                .parse()
                .unwrap();
        let strmd: url::Url =
            "https://lb10.strmd.st/secure/token/rtmp/stream/id/1/playlist.m3u8".parse().unwrap();
        let bloomberg: url::Url = "https://www.bloomberg.com/live.m3u8".parse().unwrap();

        assert!(super::is_curl_fetch_live_hls_upstream(&storm));
        assert!(super::is_curl_fetch_live_hls_upstream(&storm_sub));
        assert!(super::is_curl_fetch_live_hls_upstream(&typhoon));
        assert!(super::is_curl_fetch_live_hls_upstream(&vixsrc));
        assert!(super::is_curl_fetch_live_hls_upstream(&vixcdn));
        // strmd is browser-bound (Playwright), NOT curl-fingerprint; keep them disjoint.
        assert!(!super::is_curl_fetch_live_hls_upstream(&strmd));
        assert!(super::is_browser_bound_live_hls_upstream(&strmd));
        assert!(!super::is_curl_fetch_live_hls_upstream(&bloomberg));
    }

    #[test]
    fn parses_curl_response_headers() {
        let h2 = "HTTP/2 200 \r\ncontent-type: video/mp2t\r\ncontent-length: 851640\r\n\r\n";
        assert_eq!(super::parse_curl_response_headers(h2), (200, Some("video/mp2t".to_owned())));
        let h1 = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=UTF-8\r\n";
        assert_eq!(
            super::parse_curl_response_headers(h1),
            (403, Some("text/html; charset=UTF-8".to_owned())),
        );
        assert_eq!(super::parse_curl_response_headers("garbage"), (0, None));
    }

    #[test]
    fn parses_stream_inf_resolution_height() {
        assert_eq!(
            super::stream_inf_resolution_height(
                "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080"
            ),
            Some(1080)
        );
        assert_eq!(
            super::stream_inf_resolution_height(
                "#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS=\"avc1\""
            ),
            Some(720)
        );
        // No RESOLUTION attribute -> unknown.
        assert_eq!(
            super::stream_inf_resolution_height("#EXT-X-STREAM-INF:BANDWIDTH=800000"),
            None
        );
    }

    #[test]
    fn caps_external_embed_master_to_720p() {
        let master = "#EXTM3U\n\
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4500000,RESOLUTION=1920x1080\n\
/1080/index.m3u8\n\
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1800000,RESOLUTION=1280x720\n\
/720/index.m3u8\n\
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=720000,RESOLUTION=640x360\n\
/360/index.m3u8";
        let lines: Vec<&str> = master.lines().collect();
        let capped = super::cap_external_embed_master_to_720p(&lines).join("\n");
        assert!(!capped.contains("1920x1080"), "1080p variant must be dropped");
        assert!(!capped.contains("/1080/index.m3u8"), "1080p URI must be dropped");
        assert!(capped.contains("1280x720") && capped.contains("/720/index.m3u8"));
        assert!(capped.contains("640x360") && capped.contains("/360/index.m3u8"));
    }

    #[test]
    fn cap_keeps_master_when_no_rendition_is_720p_or_lower() {
        // Only a 1080p rendition: dropping it would empty the master, so keep it.
        let master = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n\
/1080/index.m3u8";
        let lines: Vec<&str> = master.lines().collect();
        let capped = super::cap_external_embed_master_to_720p(&lines).join("\n");
        assert!(capped.contains("/1080/index.m3u8"));
        // No declared resolutions -> unchanged.
        let no_res = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000\n/v/index.m3u8";
        let lines: Vec<&str> = no_res.lines().collect();
        assert_eq!(super::cap_external_embed_master_to_720p(&lines).join("\n"), no_res);
    }

    #[test]
    fn cors_direct_hls_host_allow_list() {
        assert!(super::is_cors_direct_hls_host("tcloud.lordflix.club"));
        assert!(super::is_cors_direct_hls_host("p16-sg.tiktokcdn.com"));
        assert!(super::is_cors_direct_hls_host("TikTokCDN.com"));
        // Not on the allow-list: keep proxying through the mini.
        assert!(!super::is_cors_direct_hls_host("storm.vodvidl.site"));
        assert!(!super::is_cors_direct_hls_host("lordflix.club"));
        assert!(!super::is_cors_direct_hls_host("evil-tiktokcdn.com"));
    }

    #[test]
    fn direct_segments_leaves_cors_direct_hosts_direct_and_proxies_the_rest() {
        let base: url::Url = "https://tcloud.lordflix.club/tcloud?u=abc".parse().unwrap();
        // VOD media playlist: one CORS-direct (tiktokcdn) segment + one other-host segment.
        let playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\n\
https://p16-sg.tiktokcdn.com/a/seg-1.ts\n#EXTINF:4.0,\n\
https://other.example.net/seg-2.ts\n#EXT-X-ENDLIST\n";
        let secret = Some("test-live-hls-proxy-secret-with-enough-length");

        // directSeg ON: tiktokcdn segment stays direct, the other is proxied.
        let direct =
            rewrite_live_hls_playlist(&base, playlist, Some("https://lordflix.club/"), secret, true);
        assert!(
            direct.contains("https://p16-sg.tiktokcdn.com/a/seg-1.ts"),
            "tiktokcdn segment must be left direct"
        );
        assert!(
            direct.contains("/api/live/hls-resource?input="),
            "non-CORS host must still be proxied"
        );
        assert!(
            !direct.contains("input=https%3A%2F%2Fp16-sg"),
            "tiktokcdn segment must NOT be wrapped in the mini proxy"
        );

        // directSeg OFF (the fallback URL): everything proxied — today's behavior.
        let proxied = rewrite_live_hls_playlist(
            &base,
            playlist,
            Some("https://lordflix.club/"),
            secret,
            false,
        );
        assert!(
            !proxied.contains("https://p16-sg.tiktokcdn.com/a/seg-1.ts"),
            "with directSeg off the tiktokcdn segment is proxied, not direct"
        );
        assert_eq!(
            proxied.matches("/api/live/hls-resource?input=").count(),
            2,
            "both segments proxied through the mini"
        );
    }

    #[test]
    fn browser_bound_live_hls_referer_uses_embed_origin() {
        assert_eq!(
            browser_bound_live_hls_referer_header(Some(
                "https://embed.st/embed/admin/ppv-croatia-vs-slovenia/1"
            )),
            Some("https://embed.st/".to_owned())
        );
        assert_eq!(
            browser_bound_live_hls_referer_header(Some(
                "https://hesgoaler.com/stream.php?ch=NOVASPORTS1"
            )),
            Some("https://hesgoaler.com/stream.php?ch=NOVASPORTS1".to_owned())
        );
    }
}

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    // A clock set before the UNIX epoch is unrecoverable: returning 0 here would
    // silently disable every time-based check (session expiry, cache TTLs, rate
    // limits), so fail loudly instead of defaulting to epoch.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .expect("system clock is set before the UNIX epoch")
}

pub fn hash_stable_string(value: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for ch in value.bytes() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("{hash:08x}")
}

/// Shared preference/normalization helpers. These live in `utils` (not `routes`)
/// so domain modules like `resolver` and `persistence` can use them without a
/// circular dependency on the HTTP transport layer.
pub fn normalize_preferred_audio_lang(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_owned(),
        "en" | "fr" | "es" | "de" | "it" | "pt" => value.trim().to_lowercase(),
        _ => "auto".to_owned(),
    }
}

pub fn normalize_preferred_stream_quality(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "" | "auto" => "auto".to_owned(),
        "4k" | "uhd" | "2160" | "2160p" => "2160p".to_owned(),
        "1080" | "1080p" => "1080p".to_owned(),
        "720" | "720p" => "720p".to_owned(),
        _ => "auto".to_owned(),
    }
}

pub fn normalize_subtitle_preference(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() || raw == "auto" {
        return String::new();
    }
    if matches!(raw.as_str(), "off" | "none" | "disabled") {
        return "off".to_owned();
    }
    normalize_iso_language(&raw)
}

pub fn normalize_session_health_state(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "healthy" => "healthy".to_owned(),
        "degraded" => "degraded".to_owned(),
        "invalid" => "invalid".to_owned(),
        _ => "unknown".to_owned(),
    }
}

fn normalize_iso_language(value: &str) -> String {
    let normalized = value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>();
    let alias = match normalized.as_str() {
        "eng" => "en",
        "fre" | "fra" => "fr",
        "spa" => "es",
        "ger" | "deu" => "de",
        "ita" => "it",
        "por" => "pt",
        "jpn" => "ja",
        "kor" => "ko",
        "zho" | "chi" => "zh",
        "dut" | "nld" => "nl",
        "rum" | "ron" => "ro",
        _ => normalized.as_str(),
    };
    if alias.len() == 2 {
        alias.to_owned()
    } else {
        alias.chars().take(2).collect()
    }
}

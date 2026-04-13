use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn hash_stable_string(value: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for ch in value.bytes() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("{hash:08x}")
}

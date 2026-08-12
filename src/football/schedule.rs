use std::collections::BTreeSet;

use serde_json::{Value, json};
use url::Url;

use crate::utils::now_ms;

use super::{
    AUTO_SOURCE_ID, ESPN_FOOTBALL_SCOREBOARD_URL, ESPN_MATCH_MERGE_TOLERANCE_MS, NTVS_SOURCE_ID,
};

pub(super) fn merge_sports_schedule_payloads(
    payloads: Vec<Value>,
    sport_name: &'static str,
) -> Value {
    let fetched_at_ms = payloads
        .iter()
        .filter_map(|payload| payload.get("fetchedAt").and_then(Value::as_i64))
        .max()
        .unwrap_or_else(now_ms);
    let mut matches: Vec<Value> = Vec::new();

    for payload in payloads {
        let Some(source_matches) = payload.get("matches").and_then(Value::as_array) else {
            continue;
        };
        for incoming in source_matches {
            if let Some(existing) = matches
                .iter_mut()
                .find(|existing| sports_schedule_matches_refer_to_same_fixture(existing, incoming))
            {
                merge_sports_schedule_match(existing, incoming);
            } else {
                matches.push(incoming.clone());
            }
        }
    }

    matches.sort_by_key(|match_item| {
        match_item
            .get("startTimestamp")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });

    json!({
        "source": ESPN_FOOTBALL_SCOREBOARD_URL,
        "sourceProvider": AUTO_SOURCE_ID,
        "sport": sport_name,
        "fetchedAt": fetched_at_ms,
        "matches": matches
    })
}

pub(super) fn filter_marquee_football_schedule(mut payload: Value) -> Value {
    if let Some(matches) = payload.get_mut("matches").and_then(Value::as_array_mut) {
        matches.retain(|match_item| {
            match_item
                .get("league")
                .and_then(Value::as_str)
                .is_some_and(is_marquee_football_competition)
        });
    }
    payload
}

fn sports_schedule_matches_refer_to_same_fixture(left: &Value, right: &Value) -> bool {
    let left_start = left
        .get("startTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let right_start = right
        .get("startTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if left_start <= 0
        || right_start <= 0
        || left_start.abs_diff(right_start) > ESPN_MATCH_MERGE_TOLERANCE_MS as u64
    {
        return false;
    }

    let left_teams = sports_schedule_team_pair(left);
    let right_teams = sports_schedule_team_pair(right);
    if let (Some((left_home, left_away)), Some((right_home, right_away))) =
        (left_teams, right_teams)
    {
        return (left_home == right_home && left_away == right_away)
            || (left_home == right_away && left_away == right_home);
    }

    normalize_sports_schedule_name(
        left.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) == normalize_sports_schedule_name(
        right
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn sports_schedule_team_pair(match_item: &Value) -> Option<(String, String)> {
    let home = normalize_sports_schedule_name(
        match_item
            .get("team1")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let away = normalize_sports_schedule_name(
        match_item
            .get("team2")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    (!home.is_empty() && !away.is_empty()).then_some((home, away))
}

pub(super) fn normalize_sports_schedule_name(value: &str) -> String {
    value
        .replace('.', "")
        .split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .filter(|part| {
            !matches!(
                part.as_str(),
                "fc" | "afc"
                    | "cf"
                    | "sc"
                    | "ac"
                    | "aif"
                    | "bk"
                    | "if"
                    | "is"
                    | "fk"
                    | "sk"
                    | "club"
            )
        })
        .map(|part| {
            if part == "utd" {
                "united".to_owned()
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn merge_sports_schedule_match(existing: &mut Value, incoming: &Value) {
    let mut providers = BTreeSet::new();
    collect_sports_schedule_providers(existing, &mut providers);
    collect_sports_schedule_providers(incoming, &mut providers);
    let incoming_streams = incoming
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_channels = incoming
        .get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_languages = incoming
        .get("languages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incoming_end = incoming
        .get("endsAtTimestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let incoming_important = incoming
        .get("important")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let Some(existing_object) = existing.as_object_mut() else {
        return;
    };

    merge_sports_schedule_array(existing_object, "streams", incoming_streams, "source");
    merge_sports_schedule_array(existing_object, "channels", incoming_channels, "name");
    merge_sports_schedule_array(existing_object, "languages", incoming_languages, "");

    let link_count = existing_object
        .get("streams")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let channel_count = existing_object
        .get("channels")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    existing_object.insert("linkCount".to_owned(), json!(link_count));
    existing_object.insert("channelCount".to_owned(), json!(channel_count));
    existing_object.insert(
        "endsAtTimestamp".to_owned(),
        json!(
            existing_object
                .get("endsAtTimestamp")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(incoming_end)
        ),
    );
    existing_object.insert(
        "important".to_owned(),
        json!(
            existing_object
                .get("important")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || incoming_important
        ),
    );
    let providers = providers.into_iter().collect::<Vec<_>>();
    existing_object.insert("providers".to_owned(), json!(providers));
    existing_object.insert(
        "provider".to_owned(),
        json!(if providers.len() == 1 {
            providers[0].as_str()
        } else {
            AUTO_SOURCE_ID
        }),
    );
}

fn collect_sports_schedule_providers(match_item: &Value, providers: &mut BTreeSet<String>) {
    if let Some(provider) = match_item.get("provider").and_then(Value::as_str) {
        let provider = provider.trim();
        if !provider.is_empty() && provider != AUTO_SOURCE_ID {
            providers.insert(provider.to_owned());
        }
    }
    if let Some(items) = match_item.get("providers").and_then(Value::as_array) {
        for provider in items.iter().filter_map(Value::as_str) {
            let provider = provider.trim();
            if !provider.is_empty() && provider != AUTO_SOURCE_ID {
                providers.insert(provider.to_owned());
            }
        }
    }
}

fn merge_sports_schedule_array(
    object: &mut serde_json::Map<String, Value>,
    field: &str,
    incoming: Vec<Value>,
    unique_field: &str,
) {
    let target = object.entry(field.to_owned()).or_insert_with(|| json!([]));
    let Some(target) = target.as_array_mut() else {
        return;
    };
    let mut seen = target
        .iter()
        .map(|item| sports_schedule_array_identity(item, unique_field))
        .collect::<BTreeSet<_>>();
    for item in incoming {
        let identity = sports_schedule_array_identity(&item, unique_field);
        if !identity.is_empty() && seen.insert(identity) {
            target.push(item);
        }
    }
}

pub(super) fn sports_schedule_array_identity(value: &Value, field: &str) -> String {
    if field.is_empty() {
        return value.as_str().unwrap_or_default().trim().to_lowercase();
    }
    let raw_value = value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if field != "source" {
        return raw_value.to_lowercase();
    }
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let stream_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if provider.eq_ignore_ascii_case(NTVS_SOURCE_ID)
        && stream_id.to_ascii_lowercase().starts_with("ntvs-")
    {
        // The Kobra page's opaque wrappers and Streamed's canonical embed rows
        // describe the same numbered feed. Payloads are merged in canonical-row
        // order, so semantic ids suppress the later wrapper duplicate.
        return format!("ntvs-id:{}", stream_id.to_ascii_lowercase());
    }
    let Ok(mut url) = Url::parse(raw_value) else {
        return raw_value.to_owned();
    };
    if let Some(host) = url.host_str().map(|host| host.to_ascii_lowercase()) {
        let _ = url.set_host(Some(&host));
    }
    // URL paths and query values may be opaque, case-sensitive source tokens.
    // Normalize only the host so distinct NTV wrapper tokens cannot collapse.
    url.to_string()
}

pub(super) fn is_marquee_football_competition(league: &str) -> bool {
    let competition = league
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    matches!(
        competition.as_str(),
        // Europe's five biggest domestic leagues.
        "english premier league"
            | "laliga"
            | "bundesliga"
            | "serie a"
            | "ligue 1"
            // Major UEFA and FIFA competitions.
            | "uefa champions league"
            | "uefa women's champions league"
            | "uefa europa league"
            | "uefa conference league"
            | "uefa european championship"
            | "uefa women's european championship"
            | "uefa nations league"
            | "fifa world cup"
            | "fifa women's world cup"
            | "fifa club world cup"
            | "copa américa"
            | "copa america"
            | "africa cup of nations"
            // The main cups belonging to the five domestic leagues above.
            | "english fa cup"
            | "english carabao cup"
            | "english league cup"
            | "copa del rey"
            | "coppa italia"
            | "german cup"
            | "coupe de france"
    )
}

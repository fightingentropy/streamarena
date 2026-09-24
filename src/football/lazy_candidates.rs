use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::hash::Hash;

pub(super) struct CandidateResolution<T> {
    pub value: Option<T>,
    pub attempted: usize,
    pub expanded: usize,
}

/// Expand a wrapper only when its place in the provider's ordering is reached.
/// Its direct children keep that position; later wrappers are never fetched
/// after successful playback resolution. One caller-held sports permit covers
/// this entire sequential operation, including cancellation on first success.
pub(super) async fn resolve_lazy_candidates<C, K, T, E, EF, R, RF>(
    candidates: Vec<C>,
    limit: usize,
    key: impl Fn(&C) -> K,
    is_wrapper: impl Fn(&C) -> bool,
    expand: E,
    resolve: R,
) -> CandidateResolution<T>
where
    C: Clone,
    K: Eq + Hash,
    E: Fn(C) -> EF,
    EF: Future<Output = Vec<C>>,
    R: Fn(C) -> RF,
    RF: Future<Output = Option<T>>,
{
    let mut pending = VecDeque::from(candidates);
    let mut seen = HashSet::new();
    let mut result = CandidateResolution {
        value: None,
        attempted: 0,
        expanded: 0,
    };
    while result.attempted < limit {
        let Some(candidate) = pending.pop_front() else {
            break;
        };
        if !seen.insert(key(&candidate)) {
            continue;
        }
        if is_wrapper(&candidate) {
            result.expanded += 1;
            // Expansion yields direct supported players only. No recursive
            // wrapper traversal or extra resolver concurrency is introduced.
            for child in expand(candidate).await.into_iter().rev() {
                if !is_wrapper(&child) {
                    pending.push_front(child);
                }
            }
            continue;
        }
        result.attempted += 1;
        if let Some(value) = resolve(candidate).await {
            result.value = Some(value);
            break;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::resolve_lazy_candidates;
    use std::sync::Mutex;

    async fn run(seeds: Vec<&str>, winner: &str, limit: usize) -> (Vec<String>, usize) {
        let events = Mutex::new(Vec::new());
        let result = resolve_lazy_candidates(
            seeds,
            limit,
            |candidate| candidate.trim_end_matches('/').to_owned(),
            |candidate| candidate.starts_with("wrapper"),
            |candidate| {
                events.lock().unwrap().push(format!("expand:{candidate}"));
                let children = if candidate == "wrapper-a" {
                    vec!["first", "second", "first"]
                } else {
                    vec!["third"]
                };
                std::future::ready(children)
            },
            |candidate| {
                events.lock().unwrap().push(format!("resolve:{candidate}"));
                std::future::ready((candidate == winner).then_some(candidate))
            },
        )
        .await;
        (events.into_inner().unwrap(), result.attempted)
    }

    #[tokio::test]
    async fn later_wrappers_are_not_fetched_after_an_earlier_success() {
        let (events, attempted) = run(vec!["first", "wrapper-b"], "first", 12).await;
        assert_eq!(events, ["resolve:first"]);
        assert_eq!(attempted, 1);
    }

    #[tokio::test]
    async fn failed_candidates_expand_later_wrappers_in_order() {
        let (events, attempted) = run(vec!["first", "wrapper-a", "wrapper-b"], "third", 12).await;
        assert_eq!(
            events,
            [
                "resolve:first",
                "expand:wrapper-a",
                "resolve:second",
                "expand:wrapper-b",
                "resolve:third",
            ]
        );
        assert_eq!(attempted, 3);
    }

    #[tokio::test]
    async fn successful_wrapper_child_skips_later_wrappers() {
        let (events, attempted) = run(vec!["wrapper-a", "wrapper-b"], "second", 12).await;
        assert_eq!(
            events,
            ["expand:wrapper-a", "resolve:first", "resolve:second"]
        );
        assert_eq!(attempted, 2);
    }

    #[tokio::test]
    async fn distinct_candidates_obey_the_attempt_limit() {
        let (events, attempted) =
            run(vec!["first", "first", "wrapper-a", "wrapper-b"], "third", 2).await;
        assert_eq!(
            events,
            ["resolve:first", "expand:wrapper-a", "resolve:second"]
        );
        assert_eq!(attempted, 2);
    }

    #[tokio::test]
    async fn explicit_direct_source_never_expands_or_tries_another_source() {
        let (events, attempted) = run(vec!["pinned"], "unavailable", 12).await;
        assert_eq!(events, ["resolve:pinned"]);
        assert_eq!(attempted, 1);
    }

    #[tokio::test]
    async fn expanded_children_use_the_same_normalized_deduplication_key() {
        let (events, attempted) = run(vec!["first/", "wrapper-a"], "second", 12).await;
        assert_eq!(
            events,
            ["resolve:first/", "expand:wrapper-a", "resolve:second"]
        );
        assert_eq!(attempted, 2);
    }
}

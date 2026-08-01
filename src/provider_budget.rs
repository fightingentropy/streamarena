use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

/// Isolates upstream providers from one another while preserving the resolver's
/// separate global concurrency ceiling. A stalled provider can fill its own
/// budget, but cannot consume the permits reserved for every other provider.
#[derive(Clone)]
pub struct ProviderConcurrencyBudgets {
    permits: Arc<DashMap<String, Arc<Semaphore>>>,
    max_per_provider: usize,
}

impl ProviderConcurrencyBudgets {
    pub fn new(max_per_provider: usize) -> Self {
        Self {
            permits: Arc::new(DashMap::new()),
            max_per_provider: max_per_provider.max(1),
        }
    }

    pub async fn acquire(&self, provider: &str, wait: Duration) -> Option<OwnedSemaphorePermit> {
        let provider = provider.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return None;
        }
        let semaphore = self
            .permits
            .entry(provider)
            .or_insert_with(|| Arc::new(Semaphore::new(self.max_per_provider)))
            .clone();
        timeout(
            wait.max(Duration::from_millis(1)),
            semaphore.acquire_owned(),
        )
        .await
        .ok()?
        .ok()
    }

    pub fn prune_idle(&self) {
        let max_per_provider = self.max_per_provider;
        self.permits.retain(|_, semaphore| {
            semaphore.available_permits() != max_per_provider || Arc::strong_count(semaphore) > 1
        });
    }

    #[cfg(test)]
    fn tracked_provider_count(&self) -> usize {
        self.permits.len()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::ProviderConcurrencyBudgets;

    #[tokio::test]
    async fn provider_capacity_is_isolated_and_released_on_cancel() {
        let budgets = ProviderConcurrencyBudgets::new(1);
        let held = budgets
            .acquire("slow", Duration::from_millis(10))
            .await
            .expect("first slow-provider permit");

        assert!(
            budgets
                .acquire("slow", Duration::from_millis(5))
                .await
                .is_none(),
            "one stalled provider must respect its own ceiling"
        );
        let other = budgets
            .acquire("healthy", Duration::from_millis(5))
            .await
            .expect("an unrelated provider keeps independent capacity");

        drop(held);
        assert!(
            budgets
                .acquire("slow", Duration::from_millis(5))
                .await
                .is_some(),
            "dropping a cancelled attempt must immediately release capacity"
        );
        drop(other);
    }

    #[tokio::test]
    async fn idle_provider_budgets_are_pruned() {
        let budgets = ProviderConcurrencyBudgets::new(1);
        let permit = budgets
            .acquire("temporary", Duration::from_millis(5))
            .await
            .expect("permit");
        drop(permit);
        budgets.prune_idle();
        assert_eq!(budgets.tracked_provider_count(), 0);
    }
}

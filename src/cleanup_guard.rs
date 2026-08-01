/// Runs a synchronous cleanup action unless ownership is explicitly committed.
/// This is intentionally tiny and runtime-agnostic so it also fires when an
/// async request future is dropped by client cancellation.
pub struct CleanupGuard<F: FnOnce()> {
    cleanup: Option<F>,
}

impl<F: FnOnce()> CleanupGuard<F> {
    pub fn new(cleanup: F) -> Self {
        Self {
            cleanup: Some(cleanup),
        }
    }

    pub fn disarm(&mut self) {
        self.cleanup = None;
    }
}

impl<F: FnOnce()> Drop for CleanupGuard<F> {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::CleanupGuard;

    #[test]
    fn runs_on_drop_but_not_after_commit() {
        let runs = Arc::new(AtomicUsize::new(0));
        {
            let runs = runs.clone();
            let _guard = CleanupGuard::new(move || {
                runs.fetch_add(1, Ordering::Relaxed);
            });
        }
        assert_eq!(runs.load(Ordering::Relaxed), 1);

        {
            let runs = runs.clone();
            let mut guard = CleanupGuard::new(move || {
                runs.fetch_add(1, Ordering::Relaxed);
            });
            guard.disarm();
        }
        assert_eq!(runs.load(Ordering::Relaxed), 1);
    }
}

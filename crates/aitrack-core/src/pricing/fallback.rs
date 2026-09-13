//! Fallback pricing tracking.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct FallbackCollector {
    inner: Arc<Mutex<HashSet<String>>>,
}

impl FallbackCollector {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn record(&self, model_id: &str) {
        if let Ok(mut set) = self.inner.lock() {
            set.insert(model_id.to_string());
        }
    }

    pub fn recorded(&self) -> Vec<String> {
        if let Ok(set) = self.inner.lock() {
            let mut models: Vec<_> = set.iter().cloned().collect();
            models.sort();
            models
        } else {
            Vec::new()
        }
    }

    pub fn count(&self) -> usize {
        if let Ok(set) = self.inner.lock() {
            set.len()
        } else {
            0
        }
    }
}

impl Default for FallbackCollector {
    fn default() -> Self {
        Self::new()
    }
}

pub fn create_fallback_collector() -> FallbackCollector {
    FallbackCollector::new()
}

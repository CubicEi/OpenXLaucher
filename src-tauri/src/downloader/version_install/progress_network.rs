//! Network vs local progress sampling.
//! Local cache reuse must advance percent but MUST NOT inflate download speed.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Fixed download buckets: vanilla 60% / loader_installer 25% / extras 15%.
pub const VANILLA_WEIGHT: f64 = 60.0;
pub const LOADER_WEIGHT: f64 = 25.0;
pub const EXTRAS_WEIGHT: f64 = 15.0;

pub const VANILLA_END: f64 = 60.0;
pub const LOADER_END: f64 = 85.0;
pub const EXTRAS_END: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressBucket {
    Vanilla,
    LoaderInstaller,
    Extras,
}

impl ProgressBucket {
    pub fn range(self) -> (f64, f64) {
        match self {
            Self::Vanilla => (0.0, VANILLA_END),
            Self::LoaderInstaller => (VANILLA_END, LOADER_END),
            Self::Extras => (LOADER_END, EXTRAS_END),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProgressSample {
    pub bytes_network: u64,
    pub bytes_local_credit: u64,
    pub speed_bps: Option<f64>,
}

/// Shared counters for a download phase (one bucket or whole download).
#[derive(Debug, Default)]
pub struct NetworkByteCounters {
    pub network: AtomicU64,
    pub local: AtomicU64,
}

impl NetworkByteCounters {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn add_network(&self, n: u64) {
        if n > 0 {
            self.network.fetch_add(n, Ordering::SeqCst);
        }
    }

    pub fn add_local(&self, n: u64) {
        if n > 0 {
            self.local.fetch_add(n, Ordering::SeqCst);
        }
    }

    pub fn network_bytes(&self) -> u64 {
        self.network.load(Ordering::SeqCst)
    }

    pub fn local_bytes(&self) -> u64 {
        self.local.load(Ordering::SeqCst)
    }

    pub fn total_credited(&self) -> u64 {
        self.network_bytes().saturating_add(self.local_bytes())
    }
}

/// Computes speed from network bytes only.
pub struct SpeedTracker {
    last_network: u64,
    last_at: Instant,
    primed: bool,
}

impl SpeedTracker {
    pub fn new() -> Self {
        Self {
            last_network: 0,
            last_at: Instant::now(),
            primed: false,
        }
    }

    pub fn sample(&mut self, network_bytes: u64) -> Option<f64> {
        const MIN_WINDOW_SECS: f64 = 0.35;
        const MAX_PLAUSIBLE_BPS: f64 = 500.0 * 1024.0 * 1024.0;
        let elapsed = self.last_at.elapsed().as_secs_f64();
        let speed = if self.primed && elapsed >= MIN_WINDOW_SECS {
            let rate = (network_bytes.saturating_sub(self.last_network) as f64) / elapsed;
            if rate > 0.0 && rate <= MAX_PLAUSIBLE_BPS {
                Some(rate)
            } else {
                None
            }
        } else {
            None
        };
        if !self.primed || elapsed >= MIN_WINDOW_SECS {
            self.last_network = network_bytes;
            self.last_at = Instant::now();
            self.primed = true;
        }
        speed
    }
}

/// Map a 0–100 sub-progress into a global bucket range.
pub fn map_into_bucket(bucket: ProgressBucket, sub_percent: f64) -> f64 {
    let (start, end) = bucket.range();
    let p = sub_percent.clamp(0.0, 100.0) / 100.0;
    start + (end - start) * p
}

/// Short credit animation when a bucket has nothing to download (all cached / skipped).
pub async fn credit_bucket_empty(
    emit: impl Fn(f64),
    bucket: ProgressBucket,
    cancel: &std::sync::atomic::AtomicBool,
) {
    use std::sync::atomic::Ordering;
    let (start, end) = bucket.range();
    if (end - start).abs() < 0.01 {
        emit(end);
        return;
    }
    const STEPS: u32 = 8;
    const STEP_MS: u64 = 40;
    for i in 1..=STEPS {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        let t = i as f64 / STEPS as f64;
        emit(start + (end - start) * t);
        tokio::time::sleep(std::time::Duration::from_millis(STEP_MS)).await;
    }
    emit(end);
}

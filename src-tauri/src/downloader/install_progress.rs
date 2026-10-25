//! Loader/add-on installers report 0–80% while downloading files, 80–100% while installing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Installer JAR / meta fetch occupies 0–5% of the download phase; libraries use 5–80%.
pub const LIB_DOWNLOAD_START: f64 = 5.0;
pub const LIB_DOWNLOAD_END: f64 = 80.0;

/// Wrap a progress channel so file-batch progress (0–100) maps to installer 5–80%.
pub fn attach_download_progress_scaler(outer: mpsc::Sender<f64>) -> mpsc::Sender<f64> {
    attach_download_progress_scaler_ranged(outer, LIB_DOWNLOAD_START, LIB_DOWNLOAD_END)
}

pub fn attach_download_progress_scaler_ranged(
    outer: mpsc::Sender<f64>,
    range_start: f64,
    range_end: f64,
) -> mpsc::Sender<f64> {
    let (inner, mut rx) = mpsc::channel::<f64>(64);
    let span = range_end - range_start;
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            let frac = (p.clamp(0.0, 100.0) / 100.0) * span;
            let scaled = (range_start + frac).min(range_end);
            let _ = outer.try_send(scaled);
        }
    });
    inner
}

#[derive(Clone)]
pub struct ByteBatchTracker {
    outer: mpsc::Sender<(u64, u64)>,
    files: Arc<Mutex<HashMap<String, (u64, u64)>>>,
}

impl ByteBatchTracker {
    pub fn new(outer: mpsc::Sender<(u64, u64)>) -> Self {
        Self {
            outer,
            files: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn file_progress_sender(&self, file_name: String) -> mpsc::Sender<(u64, u64)> {
        let (inner, mut rx) = mpsc::channel::<(u64, u64)>(64);
        let tracker = self.clone();
        tokio::spawn(async move {
            while let Some((done, total)) = rx.recv().await {
                tracker.update_file(&file_name, done, total);
            }
        });
        inner
    }

    fn update_file(&self, file_name: &str, done: u64, total: u64) {
        let mut map = self.files.lock().unwrap();
        map.insert(file_name.to_string(), (done, total));
        let sum_done: u64 = map.values().map(|(d, _)| *d).sum();
        let sum_total: u64 = map.values().map(|(_, t)| *t).sum::<u64>().max(1);
        let _ = self.outer.try_send((sum_done, sum_total));
    }
}

pub fn map_bytes_to_installer_download_percent(done: u64, total: u64) -> f64 {
    if total == 0 {
        return LIB_DOWNLOAD_START;
    }
    let frac = (done as f64 / total as f64).clamp(0.0, 1.0);
    LIB_DOWNLOAD_START + frac * (LIB_DOWNLOAD_END - LIB_DOWNLOAD_START)
}

pub fn map_jar_bytes_to_installer_percent(done: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let frac = (done as f64 / total as f64).clamp(0.0, 1.0);
    LIB_DOWNLOAD_START * frac
}

pub fn emit_install_phase_start(tx: &Option<mpsc::Sender<f64>>) {
    if let Some(tx) = tx {
        let _ = tx.try_send(80.0);
    }
}

pub fn emit_install_phase_fraction(tx: &Option<mpsc::Sender<f64>>, fraction_0_to_1: f64) {
    if let Some(tx) = tx {
        let f = fraction_0_to_1.clamp(0.0, 1.0);
        let p = 80.0 + f * 20.0;
        let _ = tx.try_send(p);
    }
}

pub fn emit_install_phase_done(tx: &Option<mpsc::Sender<f64>>) {
    if let Some(tx) = tx {
        let _ = tx.try_send(100.0);
    }
}

//! Lightweight reachability probes for Modrinth / CurseForge (cached ~10 minutes).

use crate::http_client::{curseforge_client, modrinth_client};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const PROBE_TTL: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModPlatformKind {
    Modrinth,
    CurseForge,
}

#[derive(Debug, Clone)]
struct ProbeSample {
    kind: ModPlatformKind,
    rtt_ms: u128,
    reachable: bool,
}

#[derive(Debug, Clone)]
struct CachedProbe {
    fetched_at: Instant,
    order: Vec<ModPlatformKind>,
    both_unreachable: bool,
}

static PROBE_CACHE: OnceLock<Mutex<Option<CachedProbe>>> = OnceLock::new();

fn probe_cache() -> &'static Mutex<Option<CachedProbe>> {
    PROBE_CACHE.get_or_init(|| Mutex::new(None))
}

async fn ping_modrinth() -> ProbeSample {
    let client = modrinth_client().await;
    let start = Instant::now();
    let result = client
        .get("https://api.modrinth.com/v2/tag/game_version")
        .timeout(PROBE_TIMEOUT)
        .send()
        .await;
    let reachable = matches!(&result, Ok(r) if r.status().is_success() || r.status().as_u16() == 404);
    ProbeSample {
        kind: ModPlatformKind::Modrinth,
        rtt_ms: start.elapsed().as_millis(),
        reachable,
    }
}

async fn ping_curseforge() -> ProbeSample {
    let client = curseforge_client().await;
    let start = Instant::now();
    let result = client
        .get("https://api.curseforge.com/v1/mods/search?gameId=432&pageSize=1")
        .timeout(PROBE_TIMEOUT)
        .send()
        .await;
    let reachable = matches!(&result, Ok(r) if r.status().is_success());
    ProbeSample {
        kind: ModPlatformKind::CurseForge,
        rtt_ms: start.elapsed().as_millis(),
        reachable,
    }
}

fn sort_probe_samples(samples: &[ProbeSample]) -> Vec<ModPlatformKind> {
    let mut reachable: Vec<&ProbeSample> = samples.iter().filter(|s| s.reachable).collect();
    reachable.sort_by(|a, b| {
        a.rtt_ms
            .cmp(&b.rtt_ms)
            .then_with(|| {
                // Same RTT → Modrinth before CurseForge
                match (a.kind, b.kind) {
                    (ModPlatformKind::Modrinth, ModPlatformKind::CurseForge) => std::cmp::Ordering::Less,
                    (ModPlatformKind::CurseForge, ModPlatformKind::Modrinth) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                }
            })
    });
    let mut order: Vec<ModPlatformKind> = reachable.iter().map(|s| s.kind).collect();
    for sample in samples {
        if !sample.reachable {
            order.push(sample.kind);
        }
    }
    order
}

async fn run_probe() -> CachedProbe {
    let (mr, cf) = tokio::join!(ping_modrinth(), ping_curseforge());
    let samples = [mr, cf];
    let both_unreachable = samples.iter().all(|s| !s.reachable);
    let order = sort_probe_samples(&samples);
    CachedProbe {
        fetched_at: Instant::now(),
        order,
        both_unreachable,
    }
}

/// Returns platform try-order by ascending RTT (unreachable last). Uses a shared TTL cache.
pub async fn platform_try_order() -> Result<Vec<ModPlatformKind>, ()> {
    {
        let cache = probe_cache().lock().unwrap();
        if let Some(entry) = cache.as_ref() {
            if entry.fetched_at.elapsed() < PROBE_TTL {
                if entry.both_unreachable {
                    return Err(());
                }
                return Ok(entry.order.clone());
            }
        }
    }

    let fresh = run_probe().await;
    let result = if fresh.both_unreachable {
        Err(())
    } else {
        Ok(fresh.order.clone())
    };
    *probe_cache().lock().unwrap() = Some(fresh);
    result
}

/// Deterministic sort without network (unit tests).
#[cfg(test)]
pub fn order_from_rtt(modrinth_ms: Option<u128>, curseforge_ms: Option<u128>) -> Vec<ModPlatformKind> {
    let samples = [
        ProbeSample {
            kind: ModPlatformKind::Modrinth,
            rtt_ms: modrinth_ms.unwrap_or(u128::MAX),
            reachable: modrinth_ms.is_some(),
        },
        ProbeSample {
            kind: ModPlatformKind::CurseForge,
            rtt_ms: curseforge_ms.unwrap_or(u128::MAX),
            reachable: curseforge_ms.is_some(),
        },
    ];
    sort_probe_samples(&samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tie_break_prefers_modrinth() {
        let order = order_from_rtt(Some(50), Some(50));
        assert_eq!(order[0], ModPlatformKind::Modrinth);
        assert_eq!(order[1], ModPlatformKind::CurseForge);
    }

    #[test]
    fn faster_platform_first() {
        let order = order_from_rtt(Some(120), Some(40));
        assert_eq!(order[0], ModPlatformKind::CurseForge);
        assert_eq!(order[1], ModPlatformKind::Modrinth);
    }

    #[test]
    fn unreachable_sorted_last() {
        let order = order_from_rtt(Some(80), None);
        assert_eq!(order[0], ModPlatformKind::Modrinth);
        assert_eq!(order[1], ModPlatformKind::CurseForge);
    }
}

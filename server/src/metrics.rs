//! In-process counters for the admin dashboard. They reset when the server
//! restarts and are shown as "since start".

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::{Value, json};

use crate::AppState;

#[derive(Default)]
pub struct Metrics {
    requests: AtomicU64,
    ok: AtomicU64,
    client_errors: AtomicU64,
    server_errors: AtomicU64,
    rate_limited: AtomicU64,
    failed_logins: AtomicU64,
    storage_full: AtomicU64,
}

impl Metrics {
    fn record(&self, path: &str, status: u16) {
        self.requests.fetch_add(1, Relaxed);
        match status {
            429 => self.rate_limited.fetch_add(1, Relaxed),
            // Over quota is expected behaviour, not a server fault.
            507 => self.storage_full.fetch_add(1, Relaxed),
            401 if path == "/auth/verify" => self.failed_logins.fetch_add(1, Relaxed),
            _ => 0,
        };
        let class = match status {
            200..=399 => &self.ok,
            400..=499 => &self.client_errors,
            507 => return,
            _ => &self.server_errors,
        };
        class.fetch_add(1, Relaxed);
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "requests": self.requests.load(Relaxed),
            "ok": self.ok.load(Relaxed),
            "client_errors": self.client_errors.load(Relaxed),
            "server_errors": self.server_errors.load(Relaxed),
            "rate_limited": self.rate_limited.load(Relaxed),
            "failed_logins": self.failed_logins.load(Relaxed),
            "storage_full": self.storage_full.load(Relaxed),
        })
    }
}

/// Middleware on the public `/api` router.
pub async fn track(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let res = next.run(req).await;
    st.metrics().record(&path, res.status().as_u16());
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_statuses() {
        let m = Metrics::default();
        for (p, s) in [("/docs", 200), ("/auth/verify", 401), ("/auth/challenge", 429), ("/docs/x/updates", 507), ("/x", 500), ("/docs", 401)] {
            m.record(p, s);
        }
        let v = m.snapshot();
        assert_eq!(v["requests"], 6);
        assert_eq!(v["ok"], 1);
        assert_eq!(v["client_errors"], 3);
        assert_eq!(v["server_errors"], 1);
        assert_eq!(v["rate_limited"], 1);
        assert_eq!(v["failed_logins"], 1);
        assert_eq!(v["storage_full"], 1);
    }
}

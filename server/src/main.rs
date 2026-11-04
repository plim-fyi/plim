use std::future::IntoFuture;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use plim_server::admin::{admin_addr_ok, admin_app, admin_bind_allowed};
use plim_server::{AppState, Config, app, env};
use tokio::sync::watch;

fn listen_addr() -> SocketAddr {
    env("ADDR")
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| "127.0.0.1:3000".parse().unwrap())
}

/// `plim-server --healthcheck`: for container HEALTHCHECKs in images without
/// curl or a shell. Exits 0 if `/healthz` on this instance answers 200.
fn healthcheck() -> ! {
    let mut addr = listen_addr();
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() { [127, 0, 0, 1].into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    let ok = (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut head = [0u8; 16];
        let n = s.read(&mut head)?;
        let line = String::from_utf8_lossy(&head[..n]);
        Ok(line.starts_with("HTTP/1.") && line.get(9..12) == Some("200"))
    })()
    .unwrap_or(false);
    std::process::exit(if ok { 0 } else { 1 })
}

/// Resolves on SIGTERM (container stop) or Ctrl-C.
async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    println!("plim: shutting down");
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--healthcheck") {
        healthcheck();
    }
    // `plim-server --backup <file>`: a consistent copy of PLIM_DB, made while the server runs.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--backup") {
        let Some(out) = args.get(i + 1) else {
            eprintln!("plim: --backup needs a file to write, e.g. --backup /data/backup.db");
            std::process::exit(2);
        };
        let db = Config::from_env().db_path;
        match plim_server::backup::backup(&db, std::path::Path::new(out)) {
            Ok(c) => {
                println!("plim: backed up {db} to {out}: {} bytes, {} accounts, integrity ok", c.bytes, c.accounts);
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("plim: backup failed: {e}");
                std::process::exit(1);
            }
        }
    }

    let cfg = Config::from_env();
    let addr = listen_addr();
    println!(
        "plim: serving {} on http://{addr} (db: {}, pow: {} bits, quota: {} bytes)",
        cfg.web_dir.display(),
        cfg.db_path,
        cfg.pow_bits,
        cfg.quota_bytes
    );
    println!(
        "plim: largest blob {} bytes; covered updates are {}",
        cfg.max_blob_bytes,
        if cfg.prune_on_snapshot { "pruned when a snapshot is stored" } else { "kept (PLIM_PRUNE_ON_SNAPSHOT=0)" }
    );
    println!("plim: trusted proxies: {}", cfg.proxy.describe());
    match &cfg.public_url {
        Some(url) => println!("plim: public address {url} (link previews)"),
        None => println!("plim: no PLIM_PUBLIC_URL, so shared links may show no preview image"),
    }

    // Optional read-only admin dashboard, loopback only (reach it over an SSH
    // tunnel). In a container, opt in to a non-loopback bind and publish the
    // port on the host's loopback only.
    let allow_nonloopback = env("ADMIN_ALLOW_NONLOOPBACK").is_some_and(|v| v == "1");
    let admin_addr: Option<SocketAddr> = env("ADMIN_ADDR").map(|a| match a.parse() {
        Ok(addr) if admin_bind_allowed(&addr, allow_nonloopback) => {
            if !admin_addr_ok(&addr) {
                println!("admin: binding {addr} because PLIM_ADMIN_ALLOW_NONLOOPBACK=1 — publish it only on the host's loopback");
            }
            addr
        }
        Ok(addr) => {
            eprintln!(
                "PLIM_ADMIN_ADDR={addr} is not a loopback address; refusing to expose the admin dashboard \
                 (in a container, set PLIM_ADMIN_ALLOW_NONLOOPBACK=1 and publish it as 127.0.0.1:{p}:{p})",
                p = addr.port()
            );
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("PLIM_ADMIN_ADDR={a:?} is not a socket address (e.g. 127.0.0.1:3001)");
            std::process::exit(1);
        }
    });

    let state = AppState::new(cfg).expect("failed to open database");
    let (stop_tx, stop_rx) = watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = stop_tx.send(true);
    });
    let stopped = |mut rx: watch::Receiver<bool>| async move {
        let _ = rx.wait_for(|s| *s).await;
    };

    let listener = tokio::net::TcpListener::bind(addr).await.expect("failed to bind");
    let public = axum::serve(listener, app(state.clone()).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(stopped(stop_rx.clone()));
    match admin_addr {
        None => public.await.unwrap(),
        Some(admin) => {
            let admin_listener = tokio::net::TcpListener::bind(admin).await.expect("failed to bind admin address");
            if admin_addr_ok(&admin) {
                println!("admin: http://{admin} (remote: ssh -L {p}:{admin} <host>, then open http://localhost:{p})", p = admin.port());
            } else {
                println!("admin: listening on {admin} inside the container; open http://localhost:<published port>");
            }
            let dashboard = axum::serve(admin_listener, admin_app(state)).with_graceful_shutdown(stopped(stop_rx));
            tokio::try_join!(public.into_future(), dashboard.into_future()).unwrap();
        }
    }
}

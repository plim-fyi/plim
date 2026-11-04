//! Versioned asset URLs, so a deploy always loads fresh scripts and styles.
//!
//! Static files are sent with `Cache-Control: no-cache`, but a CDN can
//! override that (Cloudflare's "Browser Cache TTL" turns it into
//! `max-age=14400`), leaving browsers on old scripts for hours after an
//! upgrade. So the page at `/` is served with its links rewritten to
//! `/v/<hash>/…`, where the hash covers every file in the web directory, and
//! `/v/<hash>/<path>` serves `<path>`. A deploy that changes any file changes
//! every URL. Relative imports inside modules, `vendor/` and the PoW worker
//! resolve under the same prefix, so they need no changes.

use std::io;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/n/{id}", get(note_page))
        .route("/n/{id}/", get(note_page)) // (typed with a slash)
        .route("/s/{id}", get(share_page))
        .route("/login", get(index)) // (making or opening a vault: the app's welcome card; / is a short overview)
        .route("/connect", get(index)) // (#369: an app asking to connect; the app shows the consent page)
        .route("/v/{version}/{*path}", get(versioned))
}

/// A short hash of every file under `dir`: names, sizes and contents.
pub fn version(dir: &Path) -> io::Result<String> {
    fn walk(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() { walk(&path, files)? } else { files.push(path) }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, &mut files)?;
    files.sort();
    let mut all = Vec::new();
    for f in files {
        let name = f.strip_prefix(dir).unwrap_or(&f).to_string_lossy().into_owned();
        let data = std::fs::read(&f)?;
        for part in [name.as_bytes(), &data] {
            all.extend_from_slice(&(part.len() as u64).to_le_bytes());
            all.extend_from_slice(part);
        }
    }
    Ok(hex::encode(&crate::sig::sha256(&all)[..6]))
}

/// How long a worked-out version is used before the web directory is looked at again.
const VERSION_FOR: std::time::Duration = std::time::Duration::from_secs(5);

/// The web directory without reading its files: each file's path, size and modification time.
type Fingerprint = Vec<(PathBuf, u64, Option<std::time::SystemTime>)>;

/// The version worked out, when, and from what the directory looked like then.
pub type Cached = (std::time::Instant, Fingerprint, String);

/// What the web directory looks like now. The same as before: the version is too, without
/// hashing every file again.
fn fingerprint(dir: &Path) -> io::Result<Fingerprint> {
    fn walk(dir: &Path, out: &mut Fingerprint) -> io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_dir() {
                walk(&entry.path(), out)?;
            } else {
                out.push((entry.path(), meta.len(), meta.modified().ok()));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, &mut out)?;
    out.sort();
    Ok(out)
}

/// The web files' version now (see `version`), as the pages link it. Looked at again every few
/// seconds (API responses carry it too, and editing files while the server runs still takes
/// effect), but the files are hashed again only when one was added, removed or changed.
pub async fn current_version(st: &AppState) -> Option<String> {
    let cached = st.0.web_version.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((at, _, v)) = &cached
        && at.elapsed() < VERSION_FOR
    {
        return Some(v.clone());
    }
    let dir = st.cfg().web_dir.clone();
    let before = cached.map(|(_, print, v)| (print, v));
    let (print, v) = tokio::task::spawn_blocking(move || -> io::Result<_> {
        let print = fingerprint(&dir)?;
        match before {
            Some((was, v)) if was == print => Ok((print, v)),
            _ => Ok((print, version(&dir)?)),
        }
    })
    .await
    .ok()?
    .ok()?;
    *st.0.web_version.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), print, v.clone()));
    Some(v)
}

/// Every API response says which version of the web files the server has
/// (`X-Tiro-Version`), so a page still running older ones (a tab left open
/// across a deploy, or brought back from the browser's back/forward cache)
/// can tell, and offer to reload (api.js).
pub async fn version_header(State(st): State<AppState>, req: Request, next: axum::middleware::Next) -> Response {
    let mut res = next.run(req).await;
    if let Some(v) = current_version(&st).await
        && let Ok(v) = axum::http::HeaderValue::from_str(&v)
    {
        res.headers_mut().insert("x-tiro-version", v);
    }
    res
}

/// Point every relative `src="…"`, `href="…"` and (one image's) `srcset="…"` in the page at `/v/<version>/`.
pub fn rewrite_index(html: &str, version: &str) -> String {
    let relative = |v: &str| !v.is_empty() && !v.starts_with(['/', '#']) && !v.contains(':');
    let mut out = String::with_capacity(html.len() + 512);
    let mut rest = html;
    loop {
        let next = [" src=\"", " href=\"", " srcset=\""].iter().filter_map(|p| rest.find(p).map(|i| i + p.len())).min();
        let Some(at) = next else { break };
        let (head, tail) = rest.split_at(at);
        out.push_str(head);
        if relative(&tail[..tail.find('"').unwrap_or(0)]) {
            out.push_str(&format!("/v/{version}/"));
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// Make the link preview's `og:url` and `og:image` absolute: many preview
/// fetchers (iMessage among them) ignore relative ones.
pub fn absolute_preview_urls(html: &str, public_url: &str) -> String {
    let mut out = html.to_string();
    for prop in ["og:url", "og:image"] {
        let from = format!(r#"<meta property="{prop}" content="/"#);
        out = out.replacen(&from, &format!(r#"<meta property="{prop}" content="{public_url}/"#), 1);
    }
    out
}

/// The page's CSP: the strict default, plus a one-off nonce for `<style>`
/// elements. CodeMirror (the note editor) adds its styles as a `<style>`
/// element; the page hands it the nonce from `<meta name="style-nonce">`.
pub fn page_csp(nonce: &str) -> String {
    crate::CSP.replacen("style-src 'self'", &format!("style-src 'self' 'nonce-{nonce}'"), 1)
}

fn new_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    hex::encode(bytes)
}

async fn index(State(st): State<AppState>) -> Response {
    page(&st, "index.html", st.cfg().public_url.clone()).await
}

/// A note's address (#299): /n/<note id>, the app's page, whatever the id (the app decides
/// whether it names a note of yours; the server says nothing about which ids exist).
async fn note_page(State(st): State<AppState>, UrlPath(_id): UrlPath<String>) -> Response {
    index(State(st)).await
}

/// The page a shared note's link opens (#70): /s/<share id>#<key>. Only the
/// share ID reaches the server; the page reads the key from the fragment.
async fn share_page(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> Response {
    if !crate::shares::valid_share_id(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // No link preview: a shared link shouldn't show anything about the note.
    page(&st, "share.html", None).await
}

/// An HTML page with versioned asset URLs and a fresh style nonce in its CSP.
async fn page(st: &AppState, file: &'static str, public_url: Option<String>) -> Response {
    let dir = st.cfg().web_dir.clone();
    let nonce = new_nonce();
    let fill = nonce.clone();
    // (The same version API responses carry, so a page just loaded is never "out of date".)
    let Some(version) = current_version(st).await else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let page = tokio::task::spawn_blocking(move || -> io::Result<String> {
        let html = std::fs::read_to_string(dir.join(file))?;
        let html = rewrite_index(&html, &version)
            .replacen(r#"<meta name="style-nonce" content="" />"#, &format!(r#"<meta name="style-nonce" content="{fill}" />"#), 1);
        Ok(match public_url {
            Some(url) => absolute_preview_urls(&html, &url),
            None => html,
        })
    })
    .await;
    match page {
        Ok(Ok(html)) => {
            let mut res = Html(html).into_response();
            res.headers_mut().insert(
                axum::http::header::CONTENT_SECURITY_POLICY,
                axum::http::HeaderValue::from_str(&page_csp(&nonce)).expect("valid header"),
            );
            res
        }
        Ok(Err(e)) if e.kind() == io::ErrorKind::NotFound => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Any version serves the current files: a page from just before a deploy
/// then gets the new files together, never a mix.
async fn versioned(
    State(st): State<AppState>,
    UrlPath((version, path)): UrlPath<(String, String)>,
    req: Request,
) -> Response {
    if version.is_empty() || version.len() > 64 || !version.bytes().all(|b| b.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (mut parts, body) = req.into_parts();
    let Ok(uri) = format!("/{path}").parse::<Uri>() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    parts.uri = uri;
    let res = ServeDir::new(st.cfg().web_dir.clone()).oneshot(Request::from_parts(parts, body)).await;
    match res {
        Ok(res) => res.map(Body::new).into_response(),
        Err(never) => match never {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_relative_links_only() {
        let html = r##"<link rel="stylesheet" href="style.css" />
<script type="module" src="app.js"></script>
<img class="logo" src="icon.svg" alt="" />
<a href="#top">x</a> <a href="https://example.com/">y</a> <img src="/abs.png"> <img data-src="no.png">
<source srcset="about/dark.webp" media="(prefers-color-scheme: dark)" />"##;
        let out = rewrite_index(html, "abc123");
        assert!(out.contains(r#"srcset="/v/abc123/about/dark.webp""#), "a <picture>'s source (#346)");
        assert!(out.contains(r#"href="/v/abc123/style.css""#));
        assert!(out.contains(r#"src="/v/abc123/app.js""#));
        assert!(out.contains(r#"src="/v/abc123/icon.svg""#));
        for kept in [r##"href="#top""##, r#"href="https://example.com/""#, r#"src="/abs.png""#, r#"data-src="no.png""#] {
            assert!(out.contains(kept), "{kept}");
        }
    }

    #[test]
    fn preview_urls_become_absolute() {
        let html = r#"<meta property="og:url" content="/" />
<meta property="og:image" content="/og-image.png" />
<meta property="og:title" content="/not-a-url" />"#;
        let out = absolute_preview_urls(html, "https://notes.example.com");
        assert!(out.contains(r#"<meta property="og:url" content="https://notes.example.com/" />"#));
        assert!(out.contains(r#"<meta property="og:image" content="https://notes.example.com/og-image.png" />"#));
        assert!(out.contains(r#"<meta property="og:title" content="/not-a-url" />"#));
    }

    #[test]
    fn public_url_is_checked() {
        use crate::parse_public_url as p;
        assert_eq!(p("https://notes.example.com/").as_deref(), Some("https://notes.example.com"));
        assert_eq!(p(" http://localhost:3000 ").as_deref(), Some("http://localhost:3000"));
        for bad in ["notes.example.com", "https://", "ftp://x.com", "https://x.com/path", r#"https://x.com"><script>"#] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    #[test]
    fn version_tracks_contents() {
        let dir = std::env::temp_dir().join(format!("plim-assets-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.js"), "one").unwrap();
        std::fs::write(dir.join("sub/b.js"), "two").unwrap();
        let v1 = version(&dir).unwrap();
        assert_eq!(v1.len(), 12);
        assert_eq!(version(&dir).unwrap(), v1);
        std::fs::write(dir.join("sub/b.js"), "TWO").unwrap();
        assert_ne!(version(&dir).unwrap(), v1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

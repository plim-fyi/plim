//! The commit `plim` is built from, for `plim --version`: `PLIM_COMMIT` when it's given (the
//! container build has no `.git`), else the checkout's, else "unknown".

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=PLIM_COMMIT");
    // (A new commit checked out: the version says so on the next build.)
    for path in ["../../.git/HEAD", "../../.git/refs/heads", "../../.git/packed-refs"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let commit = std::env::var("PLIM_COMMIT").ok().filter(|c| !c.is_empty()).or_else(|| {
        let out = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=PLIM_COMMIT={}", commit.unwrap_or_else(|| "unknown".into()));
}

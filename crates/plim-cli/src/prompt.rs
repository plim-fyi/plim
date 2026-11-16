//! Asking: a line, or a secret (the recovery phrase).

use std::io::{BufRead, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};

/// Read a line; from the terminal with a visible prompt, or plain stdin when piped.
pub(crate) fn prompt_line(label: &str) -> Result<String> {
    if std::io::stdin().is_terminal() {
        eprint!("{label}");
        std::io::stderr().flush()?;
    }
    let mut s = String::new();
    std::io::stdin().lock().read_line(&mut s)?;
    Ok(s.trim_end_matches(['\n', '\r']).to_string())
}

/// Set once stdin has been consumed as note content (`plim add` with piped text).
pub(crate) static STDIN_IS_DATA: AtomicBool = AtomicBool::new(false);

/// Read a secret without echo on a terminal; plain stdin when piped (scripts,
/// tests). If stdin carries note content, ask on the controlling terminal.
pub(crate) fn prompt_secret(label: &str) -> Result<String> {
    if std::io::stdin().is_terminal() || STDIN_IS_DATA.load(Ordering::Relaxed) {
        rpassword::prompt_password(label).context("no terminal to ask on")
    } else {
        prompt_line(label)
    }
}


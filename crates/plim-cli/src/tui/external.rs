//! Editing a note in an external editor. The plaintext has to touch disk for
//! this, so it goes in a private 0600 file — in `$XDG_RUNTIME_DIR` (RAM on most
//! Linux systems) when available — and is overwritten and deleted afterwards.
//!
//! Editors keep their own copies too (swap, persistent undo, history), usually
//! on real disk. Vim and Neovim are started with all of that switched off; for
//! other editors the user is warned once.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::config;

/// `PLIM_EDITOR` (or `TIRO_EDITOR`), then `VISUAL`, then `EDITOR`, then `vi`.
fn configured_editor() -> String {
    ["PLIM_EDITOR", "TIRO_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "vi".into())
}

#[derive(Debug, PartialEq)]
pub struct EditorPlan {
    /// Shell command prefix, e.g. `nvim` or `code --wait`.
    pub command: String,
    /// Arguments inserted before the file path.
    pub args: Vec<String>,
    /// Set when the editor may keep its own copies of the note.
    pub warning: Option<String>,
}

/// Vim/Neovim flags that keep the note out of swap, undo, backup and
/// viminfo/shada files. `-c` runs after the user's config, so settings like
/// LazyVim's `undofile = true` don't switch persistence back on.
const VIM_SAFE_ARGS: [&str; 5] =
    ["-n", "-i", "NONE", "-c", "setlocal noundofile noswapfile | set noundofile nobackup nowritebackup"];

/// Editors known not to write the buffer anywhere besides the file itself.
const NON_PERSISTING: [&str; 2] = ["hx", "helix"];

fn find_in_path(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program)).filter(|p| p.exists());
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(program)).find(|p| p.is_file())
}

/// Basename after following symlinks (`vi` is often a link to `vim` or `nvim`).
fn real_name(program: &str, which: &dyn Fn(&str) -> Option<PathBuf>) -> String {
    let resolved = which(program).and_then(|p| fs::canonicalize(p).ok());
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
    resolved.as_deref().and_then(name).or_else(|| name(Path::new(program))).unwrap_or_default()
}

/// Work out what to run. `omarchy_default` is the editor Omarchy's
/// `omarchy-launch-editor` wrapper would pick; the wrapper is bypassed so the
/// editor runs in this terminal and receives our flags.
pub fn plan(configured: &str, omarchy_default: Option<String>, which: &dyn Fn(&str) -> Option<PathBuf>) -> EditorPlan {
    let mut command = configured.trim().to_string();
    let first = command.split_whitespace().next().unwrap_or("vi").to_string();
    if Path::new(&first).file_name().is_some_and(|n| n == "omarchy-launch-editor") {
        command = omarchy_default.unwrap_or_else(|| "nvim".into());
    }
    let program = command.split_whitespace().next().unwrap_or("vi").to_string();
    let name = real_name(&program, which);
    let base = name.trim_end_matches(".exe");
    // (Vim by any of its names: Debian's `vi`/`vim` are `vim.basic`, `vim.gtk3`…, Fedora's `vi` is
    // vim-minimal; without the flags, viminfo keeps yanked text and search history on disk.)
    let vim = base.split('.').next().unwrap_or(base);
    match vim {
        "vim" | "nvim" | "vimx" | "gvim" | "vi" | "view" | "vimdiff" => {
            let mut args: Vec<String> = VIM_SAFE_ARGS.iter().map(|s| s.to_string()).collect();
            if vim == "gvim" {
                args.insert(0, "-f".into()); // stay in the foreground until closed
            }
            EditorPlan { command, args, warning: None }
        }
        b if NON_PERSISTING.contains(&b) => EditorPlan { command, args: vec![], warning: None },
        _ => EditorPlan {
            warning: Some(format!("`{program}` may keep copies of notes on disk — set PLIM_EDITOR to nvim, vim or hx")),
            command,
            args: vec![],
        },
    }
}

fn omarchy_default_editor() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let file = PathBuf::from(home).join(".local/state/omarchy/defaults/editor");
    let editor = fs::read_to_string(file).ok()?.lines().next()?.trim().to_string();
    Some(editor).filter(|e| !e.is_empty() && find_in_path(e).is_some())
}

pub fn current_plan() -> EditorPlan {
    plan(&configured_editor(), omarchy_default_editor(), &find_in_path)
}

fn scratch_dir() -> Result<PathBuf> {
    let dir = match std::env::var("XDG_RUNTIME_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d).join("plim"),
        _ => config::paths()?.data.join("tmp"),
    };
    config::private_dir(&dir)?;
    Ok(dir)
}

/// Overwrite then delete.
fn shred(path: &PathBuf) {
    if let Ok(meta) = fs::metadata(path)
        && let Ok(mut f) = fs::OpenOptions::new().write(true).open(path)
    {
        let _ = f.write_all(&vec![0u8; meta.len() as usize]);
        let _ = f.sync_all();
    }
    let _ = fs::remove_file(path);
}

/// Write `text` to a private file, run the editor on it (the caller has
/// released the terminal), and return the edited text.
pub fn edit(text: &str, plan: &EditorPlan) -> Result<String> {
    let path = scratch_dir()?.join(format!("note-{}.md", hex::encode(plim_core::crypto::random_bytes::<6>())));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // Through the shell so commands like "code --wait" work; our arguments
        // and the path are passed positionally, never spliced into the string.
        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("{} \"$@\"", plan.command))
            .arg("sh")
            .args(&plan.args)
            .arg(&path)
            .status()
            .with_context(|| format!("could not start editor `{}`", plan.command))?;
        if !status.success() {
            bail!("editor `{}` exited with {status}; note left unchanged", plan.command);
        }
        String::from_utf8(fs::read(&path)?).context("the edited note is not valid UTF-8")
    })();
    shred(&path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn vim_family_gets_no_persistence_flags() {
        // (Debian's vim.basic/vim.gtk3 behind vi and vim; Fedora's vi, vim-minimal's own binary.)
        for cmd in ["nvim", "vim", "/usr/bin/nvim", "vim.basic", "/usr/bin/vim.gtk3", "vi", "vimdiff"] {
            let p = plan(cmd, None, &none);
            assert_eq!(p.command, cmd);
            assert_eq!(p.args, VIM_SAFE_ARGS, "{cmd}");
            assert!(p.warning.is_none(), "{cmd}");
        }
        assert_eq!(plan("gvim", None, &none).args[0], "-f");
        assert_eq!(plan("gvim.exe", None, &none).args[0], "-f");
    }

    #[test]
    fn omarchy_wrapper_is_resolved_to_its_editor() {
        let p = plan("omarchy-launch-editor --inline", None, &none);
        assert_eq!((p.command.as_str(), p.args.len()), ("nvim", VIM_SAFE_ARGS.len()));
        let p = plan("omarchy-launch-editor --inline", Some("hx".into()), &none);
        assert_eq!((p.command.as_str(), p.args.is_empty(), p.warning.is_none()), ("hx", true, true));
        let p = plan("/usr/bin/omarchy-launch-editor", Some("code".into()), &none);
        assert!(p.warning.is_some());
    }

    #[test]
    fn symlinked_vi_is_recognised() {
        let dir = std::env::temp_dir().join(format!("plim-test-{}", hex::encode(plim_core::crypto::random_bytes::<4>())));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("nvim"), "").unwrap();
        std::os::unix::fs::symlink(dir.join("nvim"), dir.join("vi")).unwrap();
        let which = |p: &str| Some(dir.join(p));
        assert_eq!(plan("vi", None, &which).args, VIM_SAFE_ARGS);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn other_editors_warn() {
        let p = plan("code --wait", None, &none);
        assert_eq!(p.command, "code --wait");
        assert!(p.args.is_empty());
        assert!(p.warning.unwrap().contains("code"));
        assert!(plan("nano", None, &none).warning.is_some());
    }
}

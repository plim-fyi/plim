mod answers;
mod api;
mod commands;
mod config;
mod edits;
mod export;
mod frontmatter;
mod grants;
mod connector;
mod keychain;
mod mcp;
mod link;
mod notes;
mod prompt;
mod session;
mod search;
mod sharing;
mod store;
mod tags;
mod sync;
#[cfg(test)]
mod connector_tests;
#[cfg(test)]
mod sync_cases;
#[cfg(test)]
mod sync_tests;
mod tui;
mod vault;
mod writer;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::commands::account::{delete_account, init, login, logout, remember};
use crate::commands::edit::{How, edit};
use crate::commands::history::{history, restore};
use crate::commands::notes::{Sort, add, append, cat, cat_tagged, export, ls, rm, tag, tags};
use crate::commands::sharing::{add_link, share, share_with_agents, unshare};
use crate::vault::open_session;
use crate::writer::WritingAs;

/// `plim --version`: the release and the commit it was built from, `0.2.0 (85cb876)` (build.rs).
const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("PLIM_COMMIT"), ")");

#[derive(Parser)]
#[command(name = "plim", version = VERSION, about = "End-to-end encrypted notes in your terminal")]
struct Cli {
    /// Server URL (default: PLIM_SERVER, the signed-in server, or http://127.0.0.1:3000)
    #[arg(long, global = true)]
    server: Option<String>,
    /// Allow a plain http:// server that isn't on this machine (PLIM_INSECURE_HTTP=1): the session
    /// and share keys then cross the network unencrypted. Without it, only https:// and localhost
    #[arg(long, global = true)]
    insecure_http: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Create a new vault and sign this device in to it
    Init,
    /// Sign this device in to an existing vault with its recovery phrase
    Login,
    /// Remember the device passphrase on this machine (its keychain), so plim stops asking for it
    Remember {
        /// Forget it instead: plim asks again
        #[arg(long)]
        off: bool,
    },
    /// Remove this device's saved key
    Logout {
        /// Even if some edits have not been uploaded yet
        #[arg(long)]
        force: bool,
    },
    /// List notes, with their tags
    Ls {
        /// Each note's address (https://…/n/<id>) in place of its id
        #[arg(long)]
        urls: bool,
        /// Only the notes with this tag (that tag itself: "gym" doesn't find #gym/legs, as in the app)
        #[arg(long, value_name = "TAG")]
        tag: Option<String>,
        /// The order, newest first: by when each note was last edited, or when it was made (the
        /// time shown follows it)
        #[arg(long, value_enum, default_value_t = Sort::Edited)]
        sort: Sort,
    },
    /// Print a note (by title, id prefix, its address, or a shared note's link: then no account
    /// needed); with --tag, every note with that tag, each under its title and address
    Cat {
        #[arg(required_unless_present = "tag")]
        query: Option<String>,
        /// Every note with this tag (that tag itself)
        #[arg(long, value_name = "TAG", conflicts_with = "query")]
        tag: Option<String>,
    },
    /// Export every note as a Markdown file into DIR (a new or empty folder), as the app's Export
    /// all notes: its tags, dates and id in its frontmatter; Recently deleted's in DIR/deleted
    Export { dir: std::path::PathBuf },
    /// List the tags in your notes, with how many notes have each
    Tags {
        /// Read every note's tags from its text (notes last written before tags were kept)
        #[arg(long)]
        rebuild: bool,
    },
    /// Tag a note: the tags go in its frontmatter, `tags: [a, b]` (a note from before frontmatter: on its line of tags under its title)
    Tag {
        note: String,
        #[arg(required = true, value_name = "TAG")]
        tags: Vec<String>,
        /// Write as NAME (an app or a script: "Claude", "Backup script"), marked as its in the app and
        /// in History; else $PLIM_AS; else as you
        #[arg(long = "as", value_name = "NAME")]
        by: Option<String>,
    },
    /// Take tags off a note: out of its frontmatter's tags (a note from before frontmatter: off its line of tags)
    Untag {
        note: String,
        #[arg(required = true, value_name = "TAG")]
        tags: Vec<String>,
        /// Write as NAME (an app or a script: "Claude", "Backup script"), marked as its in the app and
        /// in History; else $PLIM_AS; else as you
        #[arg(long = "as", value_name = "NAME")]
        by: Option<String>,
    },
    /// Add text at the end of a note (by title, id prefix, its address, or an edit link: then no
    /// account needed), from arguments, or from stdin when no text is given
    Append {
        target: String,
        #[arg(allow_hyphen_values = true)]
        text: Vec<String>,
        /// Write as NAME (an app or a script: "Claude", "Backup script"), marked as its in the app and
        /// in History; else $PLIM_AS; else as you
        #[arg(long = "as", value_name = "NAME")]
        by: Option<String>,
    },
    /// Change a note's text: in your editor ($PLIM_EDITOR, $VISUAL, $EDITOR), a piece of it
    /// replaced (--replace OLD NEW, there exactly once), or its whole new text from stdin (`-`).
    /// By title, id prefix, its address, or an edit link (then no account needed). Merged with
    /// edits made elsewhere; kept in its history as your other edits are
    Edit {
        note: String,
        /// `-`: the note's whole new text from stdin (only what changed is changed)
        #[arg(value_parser = ["-"], conflicts_with = "replace")]
        from: Option<String>,
        /// Replace OLD, which must be in the note exactly once, with NEW (empty: take it out)
        #[arg(long, num_args = 2, value_names = ["OLD", "NEW"], allow_hyphen_values = true)]
        replace: Option<Vec<String>>,
        /// Write as NAME (an app or a script: "Claude", "Backup script"), marked as its in the app and
        /// in History; else $PLIM_AS; else as you
        #[arg(long = "as", value_name = "NAME")]
        by: Option<String>,
    },
    /// A note's earlier versions, newest first and numbered: when, who made each if an AI did
    /// ("Claude · amber fox"), and the lines it added and removed; with a number, that version
    History {
        note: String,
        /// Print this version (1 is the newest)
        n: Option<usize>,
        /// With a number: what that version changed since the one before, as a diff
        #[arg(long, requires = "n")]
        diff: bool,
        /// List every version (the newest 20 otherwise)
        #[arg(long, conflicts_with = "n")]
        all: bool,
    },
    /// Put a note back as it was in one of its versions (`plim history` numbers them); what it is
    /// now is kept as a version first, so this can be undone too
    Restore { note: String, n: usize },
    /// Add a shared note to your list from its link (as "Add to my notes" in the web app)
    AddLink { link: String },
    /// Share a note, and print its links (edit and view); for a shared note, the links you have.
    /// With --agents, share it with agents instead
    Share {
        note: String,
        /// Share it with agents (#514): every agent you connect (through the connector) reads and
        /// edits it. No links are made
        #[arg(long, conflicts_with_all = ["new_links", "for"])]
        agents: bool,
        /// Replace its links: the old ones stop working (only whoever shared it); people's own
        /// links (--for) keep working
        #[arg(long)]
        new_links: bool,
        /// A link of their own for someone, printed: take it back without touching the others
        /// (in the app's Share dialog, for now)
        #[arg(long, value_name = "NAME")]
        r#for: Option<String>,
        /// With --for: a link that can only view the note
        #[arg(long, requires = "for")]
        view: bool,
    },
    /// Stop sharing a note: its links stop working (only whoever shared it). With --agents, stop
    /// sharing it with agents instead
    Unshare {
        note: String,
        /// Stop sharing it with agents (#514): they lose it, and its links stay as they are
        #[arg(long)]
        agents: bool,
    },
    /// Add a note from arguments, or from stdin when no text is given
    Add {
        #[arg(allow_hyphen_values = true)]
        text: Vec<String>,
        /// Write as NAME (an app or a script: "Claude", "Backup script"), marked as its in the app and
        /// in History; else $PLIM_AS; else as you
        #[arg(long = "as", value_name = "NAME")]
        by: Option<String>,
    },
    /// Delete a note (by title, id prefix, or its address)
    Rm { query: String },
    /// Delete your account and everything of it from the server, for good
    DeleteAccount,
    /// Serve as the connector for a Plim server (#369): a remote MCP server that Claude (or another
    /// MCP client) connects to over the web, and the owner connects in Plim, under Settings →
    /// Connections. There's no MCP server on stdin/stdout: in a terminal, use these commands
    Mcp {
        /// The address to listen on. No account here: --server names the Plim server, --public-url
        /// this one's address
        #[arg(long, value_name = "ADDR")]
        http: Option<std::net::SocketAddr>,
        /// With --http: the connector's own address as Claude reaches it (PLIM_CONNECTOR_URL)
        #[arg(long, value_name = "URL", requires = "http")]
        public_url: Option<String>,
        /// With --http: the file holding the key that seals its tokens (PLIM_CONNECTOR_SECRET_FILE;
        /// made if missing; default: <data dir>/connector.key)
        #[arg(long, value_name = "PATH", requires = "http")]
        secret_file: Option<std::path::PathBuf>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    api::allow_insecure_http(cli.insecure_http || config::env("INSECURE_HTTP").is_some_and(|v| v == "1"));
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let done = run(cli).await;
        api::end_sessions().await; // (#146: the sessions it signed in to end with it, done or failed)
        done
    })
}

async fn run(cli: Cli) -> Result<()> {
    let server = cli.server.as_deref();
    match cli.command {
        Some(Command::Init) => init(server).await,
        Some(Command::Login) => login(server).await,
        Some(Command::Remember { off }) => remember(off).await,
        Some(Command::Logout { force }) => logout(force),
        Some(Command::Ls { urls, tag, sort }) => ls(server, urls, tag.as_deref(), sort).await,
        Some(Command::Cat { tag: Some(tag), .. }) => cat_tagged(server, &tag).await,
        Some(Command::Cat { query, .. }) => cat(server, query.as_deref().unwrap_or_default()).await,
        Some(Command::Export { dir }) => export(server, &dir).await,
        Some(Command::Tags { rebuild }) => tags(server, rebuild).await,
        Some(Command::Tag { note, tags, by }) => tag(server, &note, &tags, true, WritingAs::from(by)?).await,
        Some(Command::Untag { note, tags, by }) => tag(server, &note, &tags, false, WritingAs::from(by)?).await,
        Some(Command::Append { target, mut text, mut by }) => {
            trailing_as(&mut text, &mut by);
            append(server, &target, text, WritingAs::from(by)?).await
        }
        Some(Command::Edit { note, from, replace, by }) => {
            let how = match (from, replace) {
                (Some(_), _) => How::Stdin,
                (None, Some(r)) => How::Replace(r[0].clone(), r[1].clone()),
                (None, None) => How::Editor,
            };
            edit(server, &note, how, WritingAs::from(by)?).await
        }
        Some(Command::History { note, n, diff, all }) => history(server, &note, n, diff, all).await,
        Some(Command::Restore { note, n }) => restore(server, &note, n).await,
        Some(Command::AddLink { link }) => add_link(server, &link).await,
        Some(Command::Share { note, agents: true, .. }) => share_with_agents(server, &note, true).await,
        Some(Command::Share { note, new_links, r#for, view, .. }) => share(server, &note, new_links, r#for.as_deref(), view).await,
        Some(Command::Unshare { note, agents: true }) => share_with_agents(server, &note, false).await,
        Some(Command::Unshare { note, .. }) => unshare(server, &note).await,
        Some(Command::Add { mut text, mut by }) => {
            trailing_as(&mut text, &mut by);
            add(server, text, WritingAs::from(by)?).await
        }
        Some(Command::Rm { query }) => rm(server, &query).await,
        Some(Command::DeleteAccount) => delete_account(server).await,
        Some(Command::Mcp { http: None, .. }) => bail!(
            "plim mcp only runs the connector now (`plim mcp --http ADDR`): there's no MCP server on stdin/stdout. \
             Connect Claude to your Plim server's connector (in Plim, Settings → Connections), and remove `plim mcp` \
             from this client's settings. In a terminal, use the plim commands."
        ),
        Some(Command::Mcp { http: Some(listen), public_url, secret_file }) => {
            // (The settings, PLIM_ or TIRO_: clap's `env` takes only one name.)
            let public_url = public_url
                .or_else(|| config::env("CONNECTOR_URL"))
                .context("--public-url (or PLIM_CONNECTOR_URL) is needed: the connector's address as Claude reaches it")?;
            if !(public_url.starts_with("https://") || public_url.starts_with("http://")) {
                bail!("--public-url must be an address like https://mcp.example.com");
            }
            let secret_file = match secret_file.or_else(|| config::env("CONNECTOR_SECRET_FILE").map(Into::into)) {
                Some(p) => p,
                None => config::paths()?.data.join("connector.key"),
            };
            let server = config::server_url(server, config::load_device()?.as_ref());
            connector::serve(connector::Opts { listen, public_url, server, secret_file }).await
        }
        None => tui::run(open_session(server).await?).await,
    }
}


/// `--as NAME` after the text (#542): the text takes everything after it, list items' hyphens too,
/// so a trailing `--as NAME` is taken back out as the flag.
fn trailing_as(text: &mut Vec<String>, by: &mut Option<String>) {
    if by.is_none() && text.len() >= 2 && text[text.len() - 2] == "--as" {
        *by = text.pop();
        text.pop();
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    /// `--as` (#542) beside text that starts with a hyphen (a list item), either side of it.
    #[test]
    fn append_takes_as_and_a_list_item() {
        let parse = |args: &[&str]| Cli::try_parse_from([&["plim", "append", "Plan"][..], args].concat()).map(|c| match c.command {
            Some(Command::Append { mut text, mut by, .. }) => {
                trailing_as(&mut text, &mut by);
                (text, by)
            }
            _ => panic!("not append"),
        });
        assert_eq!(parse(&["- and more", "--as", "Claude"]).unwrap(), (vec!["- and more".into()], Some("Claude".into())));
        assert_eq!(parse(&["--as", "Claude", "- and more"]).unwrap(), (vec!["- and more".into()], Some("Claude".into())));
        assert_eq!(parse(&["- one", "two"]).unwrap(), (vec!["- one".into(), "two".into()], None));
        assert_eq!(parse(&["-"]).unwrap().0, vec!["-".to_string()], "stdin");
    }

    /// `plim edit`'s three ways (#505 follow-up): a list item's piece (starting with a hyphen) as
    /// --replace's words, `-` for stdin, and not both.
    #[test]
    fn edit_parses_its_three_ways() {
        let parse = |args: &[&str]| Cli::try_parse_from([&["plim", "edit", "Plan"][..], args].concat()).map(|c| match c.command {
            Some(Command::Edit { from, replace, .. }) => (from, replace),
            _ => panic!("not edit"),
        });
        assert_eq!(parse(&[]).unwrap(), (None, None));
        assert_eq!(parse(&["-"]).unwrap(), (Some("-".into()), None));
        assert_eq!(parse(&["--replace", "- one", "- two"]).unwrap(), (None, Some(vec!["- one".into(), "- two".into()])));
        assert_eq!(parse(&["--replace", "gone", ""]).unwrap().1, Some(vec!["gone".into(), "".into()]), "empty NEW: taken out");
        assert!(parse(&["-", "--replace", "a", "b"]).is_err(), "not both");
        assert!(parse(&["x"]).is_err(), "only - stands for stdin");
        assert!(parse(&["--replace", "a"]).is_err(), "OLD and NEW");
    }
}

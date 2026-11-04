//! Interactive terminal UI: note list + editor, autosave, live sync.

pub(crate) mod binding;
pub(crate) mod external;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use ratatui::DefaultTerminal;
use ratatui::Frame;
use ratatui::crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use ratatui::crossterm::execute;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui_textarea::{CursorMove, TextArea, WrapMode};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Transact, Update};

use crate::notes::{self, NoteMeta};
use crate::session::Session;
use crate::sync::{Cmd, DocSync, Events, REMOTE, Rollback, ShareHome, Status};

enum UiEvent {
    Status(String, Status),
    Rollback(Rollback),
    Remote(String, Vec<u8>),
    /// A shared note's change not made with its edit link (#77): skipped.
    Forged,
}

struct ChannelEvents(mpsc::UnboundedSender<UiEvent>);

impl Events for ChannelEvents {
    fn status(&self, doc_id: &str, status: Status) {
        let _ = self.0.send(UiEvent::Status(doc_id.into(), status));
    }
    fn rollback(&self, r: Rollback) {
        let _ = self.0.send(UiEvent::Rollback(r));
    }
    fn forged(&self, _doc_id: &str) {
        let _ = self.0.send(UiEvent::Forged);
    }
}

/// A doc whose sync runs in a background task.
struct DocHandle {
    id: String,
    doc: Doc,
    cmd: mpsc::UnboundedSender<Cmd>,
    task: JoinHandle<()>,
}

impl DocHandle {
    /// A doc: the note list, a note's own doc, or (`share`) a shared note's share (#80).
    async fn open(sess: &Arc<Session>, id: &str, share: Option<Arc<ShareHome>>, tx: &mpsc::UnboundedSender<UiEvent>, sink: bool) -> Result<Self> {
        let events = Arc::new(ChannelEvents(tx.clone()));
        let mut s = match share {
            Some(share) => DocSync::new_share(sess.clone(), share, events)?,
            None => DocSync::new(sess.clone(), id, events)?,
        };
        s.load().await?;
        s.keep_history().await; // (a note: your edits keep versions as the app's do, #505; not the list)
        if sink {
            let tx = tx.clone();
            s.set_remote_sink(Arc::new(move |doc_id: &str, bytes: Vec<u8>| {
                let _ = tx.send(UiEvent::Remote(doc_id.into(), bytes));
            }));
        }
        let (doc, id) = (s.doc.clone(), s.doc_id.clone());
        let (cmd, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(s.drive(rx));
        Ok(DocHandle { id, doc, cmd, task })
    }

    /// Flush and stop; waits up to 5 s for the upload.
    async fn stop(self) {
        let (ack, done) = oneshot::channel();
        if self.cmd.send(Cmd::Stop(ack)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(5), done).await;
        }
        self.task.abort();
    }
}

struct OpenNote {
    /// The note's id in the list (its doc's is `handle.id`: "share:<id>" when shared).
    note_id: String,
    /// Where it was opened: its share's id, or None for its own doc. If the list says
    /// otherwise later (shared or unshared elsewhere), it's reopened there.
    share_id: Option<String>,
    /// A view link (#80): read, don't type.
    view_only: bool,
    handle: DocHandle,
    editor: TextArea<'static>,
    /// The text the editor was last in sync with.
    synced: String,
    /// When it was last edited here (server clock, ms; 0: not yet): a deletion
    /// from elsewhere that hadn't seen that edit doesn't hide it (#54).
    edited_at: f64,
}

#[derive(PartialEq)]
enum Focus {
    List,
    Editor,
}

enum Mode {
    Normal,
    Search,
    ConfirmDelete(String),
}

struct App {
    sess: Arc<Session>,
    tx: mpsc::UnboundedSender<UiEvent>,
    rx: mpsc::UnboundedReceiver<UiEvent>,
    index: DocHandle,
    note: Option<OpenNote>,
    closing: Vec<JoinHandle<()>>,
    focus: Focus,
    mode: Mode,
    list: ListState,
    filter: String,
    statuses: HashMap<String, Status>,
    rollbacks: BTreeMap<String, Rollback>,
    message: Option<(String, Instant)>,
    external_requested: bool,
    /// The "your editor may keep copies" warning has been shown this session.
    editor_warned: bool,
    /// The open note's home changed (shared or unshared elsewhere): reopen it, and say why.
    reopen: Option<(String, &'static str)>,
    quit: bool,
}

const VIEW_ONLY: &str = "View only: you have this shared note's view link.";

/// Keys that move around a note without changing it (all a view link allows).
fn is_navigation(key: &KeyEvent) -> bool {
    matches!(key.code, KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right | KeyCode::Home | KeyCode::End | KeyCode::PageUp | KeyCode::PageDown)
}

pub async fn run(sess: Arc<Session>) -> Result<()> {
    let (tx, rx) = mpsc::unbounded_channel();
    let index = DocHandle::open(&sess, "index", None, &tx, false).await?;
    let mut app = App {
        sess: sess.clone(),
        tx,
        rx,
        index,
        note: None,
        closing: Vec::new(),
        focus: Focus::List,
        mode: Mode::Normal,
        list: ListState::default().with_selected(Some(0)),
        filter: String::new(),
        statuses: HashMap::new(),
        rollbacks: BTreeMap::new(),
        message: None,
        external_requested: false,
        editor_warned: false,
        reopen: None,
        quit: false,
    };
    if let Some((_, got)) = sess.keyring_rollback {
        app.rollbacks.insert("keyring".into(), Rollback { doc_id: "keyring".into(), missing: got as usize, incomplete: false });
    }
    // Leave the terminal in bracketed-paste-off state even if we panic.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(std::io::stdout(), DisableBracketedPaste);
        previous(info);
    }));
    let mut terminal = enter_terminal();
    let result = app.event_loop(&mut terminal).await;
    leave_terminal();
    if app.shutdown().await {
        eprintln!("Some edits couldn't be uploaded; they're saved on this device and will upload next time.");
    }
    result
}

impl App {
    async fn event_loop(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        while !self.quit {
            terminal.draw(|f| self.render(f))?;
            if event::poll(Duration::from_millis(50))? {
                match event::read()? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => self.on_key(key).await,
                    Event::Paste(text) => self.on_paste(&text),
                    _ => {}
                }
            }
            while let Ok(ev) = self.rx.try_recv() {
                self.on_sync_event(ev);
            }
            self.check_open_note();
            if let Some((id, why)) = self.reopen.take() {
                self.open_note(&id).await;
                self.flash(why);
            }
            if std::mem::take(&mut self.external_requested) {
                self.edit_externally(terminal);
            }
        }
        Ok(())
    }

    /// Stop all syncs (each flushes first). Returns true if anything is still unsent.
    async fn shutdown(&mut self) -> bool {
        if let Some(n) = self.note.take() {
            n.handle.stop().await;
        }
        for t in self.closing.drain(..) {
            let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
        }
        let index = std::mem::replace(&mut self.index, DocHandle {
            id: String::new(),
            doc: Doc::new(),
            cmd: mpsc::unbounded_channel().0,
            task: tokio::spawn(async {}),
        });
        index.stop().await;
        !self.sess.store.outbox_docs().unwrap_or_default().is_empty()
    }

    fn flash(&mut self, msg: impl Into<String>) {
        self.message = Some((msg.into(), Instant::now()));
    }

    fn visible_notes(&self) -> Vec<NoteMeta> {
        let q = self.filter.to_lowercase();
        // ("#gym": the notes tagged #gym, #308, #539; else titles with the words in them.)
        let tag = q.starts_with('#').then(|| crate::tags::tag_name(&q)).flatten();
        notes::list(&self.index.doc)
            .into_iter()
            .filter(|n| match &tag {
                Some(t) => n.tags.iter().any(|x| crate::tags::matches(x, t)),
                None => q.is_empty() || n.title.to_lowercase().contains(&q),
            })
            .collect()
    }

    fn selected(&self) -> Option<NoteMeta> {
        let notes = self.visible_notes();
        self.list.selected().and_then(|i| notes.get(i).cloned())
    }

    // ---------- sync events ----------

    fn on_sync_event(&mut self, ev: UiEvent) {
        match ev {
            UiEvent::Status(doc, s) => {
                self.statuses.insert(doc, s);
            }
            UiEvent::Rollback(r) => {
                self.rollbacks.insert(r.doc_id.clone(), r);
            }
            UiEvent::Forged => self.flash("Skipped a change to this shared note that wasn't made with its edit link."),
            // (Not returning early: the checks below must also run after the note list changes.)
            UiEvent::Remote(doc_id, bytes) => {
                if let Some(note) = self.note.as_mut().filter(|n| n.handle.id == doc_id)
                    && let Ok(update) = Update::decode_v1(&bytes)
                    && note.handle.doc.transact_mut_with(REMOTE).apply_update(update).is_ok()
                {
                    let new = notes::body(&note.handle.doc);
                    if new != note.synced {
                        let ratatui_textarea::DataCursor(row, col) = note.editor.cursor();
                        let (row, col) = binding::move_cursor(&note.synced, &new, row, col);
                        note.editor = new_editor(&new);
                        note.editor.move_cursor(CursorMove::Jump(row as u16, col as u16));
                        note.synced = new;
                    }
                }
            }
        }
    }

    /// The open note was deleted, or shared, on another device. (Shared, its text
    /// moved to the share: what's typed here from now on would be lost.) Checked
    /// on every pass: the note list changes without an event.
    fn check_open_note(&mut self) {
        // A note deleted elsewhere while it was being edited (here or elsewhere) comes back (#54).
        if let Some(n) = self.note.as_ref().filter(|n| n.edited_at > 0.0) {
            notes::keep_edit(&self.index.doc, &n.note_id, n.edited_at);
        }
        let back = notes::revive_edited(&self.index.doc);
        match back.as_slice() {
            [] => {}
            [title] => self.flash(format!("\"{}\" was deleted on another device while it was being edited, so it's back.", if title.is_empty() { "Untitled" } else { title })),
            _ => self.flash(format!("{} notes were deleted on another device while being edited, so they're back.", back.len())),
        }
        let open = self.note.as_ref().and_then(|n| notes::get(&self.index.doc, &n.note_id));
        if open.as_ref().is_some_and(|m| m.deleted) {
            self.close_note();
            self.flash("This note was deleted on another device.");
        } else if let Some(m) = open
            && self.note.as_ref().is_some_and(|n| n.share_id != m.share.as_ref().map(|s| s.id.clone()))
        {
            // Shared, unshared or its links replaced on another device: reopen it in its new home.
            self.reopen = Some((m.id, if m.share.is_some() { "This note was shared on another device." } else { "This note isn't shared any more." }));
        }
    }

    fn overall_status(&self) -> Status {
        self.statuses.values().copied().max().unwrap_or(Status::Saved)
    }

    // ---------- notes ----------

    async fn open_note(&mut self, id: &str) {
        if self.note.as_ref().is_some_and(|n| n.note_id == id) {
            self.focus = Focus::Editor;
            return;
        }
        self.close_note();
        // A shared note's text is in its share (#80), sealed with its link's keys.
        let share_ref = notes::get(&self.index.doc, id).and_then(|m| m.share);
        let share = match share_ref.as_ref().map(|r| r.home()).transpose() {
            Ok(s) => s.map(Arc::new),
            Err(e) => return self.flash(format!("Couldn't open this shared note: {e:#}")),
        };
        let view_only = share.as_ref().is_some_and(|s| !s.writable());
        match DocHandle::open(&self.sess, id, share, &self.tx, true).await {
            Ok(handle) => {
                let text = notes::body(&handle.doc);
                let mut editor = new_editor(&text);
                editor.move_cursor(CursorMove::Bottom);
                editor.move_cursor(CursorMove::End);
                let share_id = share_ref.map(|r| r.id);
                self.note = Some(OpenNote { note_id: id.into(), share_id, view_only, handle, editor, synced: text, edited_at: 0.0 });
                self.focus = Focus::Editor;
                if view_only {
                    self.flash(VIEW_ONLY);
                }
            }
            Err(e) => self.flash(format!("Couldn't open note: {e:#}")),
        }
    }

    fn close_note(&mut self) {
        if let Some(n) = self.note.take() {
            self.statuses.remove(&n.handle.id);
            self.closing.push(tokio::spawn(n.handle.stop()));
        }
        self.focus = Focus::List;
    }

    async fn new_note(&mut self) {
        self.filter.clear();
        let id = notes::create(&self.index.doc, "");
        self.list.select(Some(0));
        self.open_note(&id).await;
    }

    /// Push the editor's text into the doc and keep the index title current.
    fn editor_changed(&mut self) {
        let Some(note) = self.note.as_mut() else { return };
        let text = note.editor.lines().join("\n");
        binding::apply_text(&note.handle.doc, &note.synced, &text);
        notes::touch(&self.index.doc, &note.note_id, &text, false);
        note.synced = text;
        note.edited_at = notes::now_ms();
    }

    fn edit_externally(&mut self, terminal: &mut DefaultTerminal) {
        if self.note.as_ref().is_some_and(|n| n.view_only) {
            return self.flash(VIEW_ONLY);
        }
        let Some(note) = self.note.as_mut() else { return };
        let base_state = binding::state_of(&note.handle.doc);
        let base_text = notes::body(&note.handle.doc);
        let plan = external::current_plan();
        leave_terminal();
        let edited = external::edit(&base_text, &plan);
        *terminal = enter_terminal();
        let _ = terminal.clear();
        let result = edited.and_then(|text| binding::external_edit_updates(&base_state, &text));
        match result {
            Ok(updates) if !updates.is_empty() => {
                // Local changes (no REMOTE origin), so they're queued for upload:
                // one transaction each, so a big edit stays in pieces.
                let applied = updates.iter().try_for_each(|update| {
                    let u = Update::decode_v1(update)?;
                    note.handle.doc.transact_mut().apply_update(u)?;
                    anyhow::Ok(())
                });
                if let Err(e) = applied {
                    self.flash(format!("Couldn't merge the edit: {e:#}"));
                    return;
                }
                let new = notes::body(&note.handle.doc);
                let ratatui_textarea::DataCursor(row, col) = note.editor.cursor();
                let (row, col) = binding::move_cursor(&note.synced, &new, row, col);
                note.editor = new_editor(&new);
                note.editor.move_cursor(CursorMove::Jump(row as u16, col as u16));
                note.synced = new.clone();
                note.edited_at = notes::now_ms();
                let id = note.note_id.clone();
                notes::touch(&self.index.doc, &id, &new, true);
                self.flash("Merged changes from your editor.");
            }
            Ok(_) => self.flash("No changes."),
            Err(e) => self.flash(format!("{e:#}")),
        }
        if let Some(w) = plan.warning
            && !std::mem::replace(&mut self.editor_warned, true)
        {
            self.flash(w);
        }
    }

    // ---------- paste ----------

    /// A bracketed paste arrives as one event: insert it as a single edit
    /// (one transaction, one upload) instead of one keystroke per character.
    fn on_paste(&mut self, text: &str) {
        // Terminals often send pasted newlines as bare CR.
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        match (&self.mode, &self.focus) {
            (Mode::Search, _) => self.filter.push_str(text.lines().next().unwrap_or("")),
            (Mode::Normal, Focus::Editor) if self.note.as_ref().is_some_and(|n| n.view_only) => self.flash(VIEW_ONLY),
            (Mode::Normal, Focus::Editor) => {
                if let Some(note) = self.note.as_mut()
                    && note.editor.insert_str(&text)
                {
                    self.editor_changed();
                }
            }
            _ => self.flash("Open a note (Enter) or create one (n) to paste into it."),
        }
    }

    // ---------- keys ----------

    async fn on_key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match &self.mode {
            Mode::ConfirmDelete(id) => {
                let id = id.clone();
                self.mode = Mode::Normal;
                if matches!(key.code, KeyCode::Char('y' | 'Y')) {
                    if self.note.as_ref().is_some_and(|n| n.note_id == id) {
                        self.close_note();
                    }
                    notes::delete(&self.index.doc, &id);
                    self.flash("Deleted.");
                }
                return;
            }
            Mode::Search => {
                match key.code {
                    KeyCode::Esc => {
                        self.filter.clear();
                        self.mode = Mode::Normal;
                    }
                    KeyCode::Enter => self.mode = Mode::Normal,
                    KeyCode::Backspace => {
                        self.filter.pop();
                    }
                    KeyCode::Char(c) if !ctrl => self.filter.push(c),
                    _ => {}
                }
                self.list.select(Some(0));
                return;
            }
            Mode::Normal => {}
        }

        // Global shortcuts.
        match (ctrl, key.code) {
            (true, KeyCode::Char('q')) => {
                self.quit = true;
                return;
            }
            (true, KeyCode::Char('n')) => return self.new_note().await,
            (true, KeyCode::Char('e')) if self.note.is_some() => {
                self.external_requested = true;
                return;
            }
            _ => {}
        }

        if self.focus == Focus::Editor {
            match key.code {
                KeyCode::Esc => self.focus = Focus::List,
                // A view link: moving around, not typing.
                _ if self.note.as_ref().is_some_and(|n| n.view_only) && !is_navigation(&key) => self.flash(VIEW_ONLY),
                _ => {
                    let note = self.note.as_mut().expect("editor focus implies an open note");
                    if note.editor.input(key) {
                        self.editor_changed();
                    }
                }
            }
            return;
        }

        let count = self.visible_notes().len();
        let sel = self.list.selected().unwrap_or(0);
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Down | KeyCode::Char('j') => self.list.select(Some((sel + 1).min(count.saturating_sub(1)))),
            KeyCode::Up | KeyCode::Char('k') => self.list.select(Some(sel.saturating_sub(1))),
            KeyCode::Home | KeyCode::Char('g') => self.list.select(Some(0)),
            KeyCode::End | KeyCode::Char('G') => self.list.select(Some(count.saturating_sub(1))),
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => {
                if let Some(n) = self.selected() {
                    self.open_note(&n.id).await;
                }
            }
            KeyCode::Tab if self.note.is_some() => self.focus = Focus::Editor,
            KeyCode::Char('n') => self.new_note().await,
            KeyCode::Char('e') => {
                if let Some(n) = self.selected() {
                    self.open_note(&n.id).await;
                    self.external_requested = self.note.is_some();
                }
            }
            KeyCode::Char('d') => {
                if let Some(n) = self.selected() {
                    self.mode = Mode::ConfirmDelete(n.id);
                }
            }
            KeyCode::Char('/') => {
                self.filter.clear();
                self.mode = Mode::Search;
            }
            KeyCode::Char('A') if !self.rollbacks.is_empty() => {
                if let Some(n) = &self.note {
                    let _ = n.handle.cmd.send(Cmd::AcceptServerState);
                }
                let _ = self.index.cmd.send(Cmd::AcceptServerState);
                if self.rollbacks.contains_key("keyring") {
                    let _ = self.sess.store.set_key_version(self.sess.keyring.read().unwrap().current());
                }
                self.rollbacks.clear();
                self.flash("Acknowledged. The server's current data is the new baseline.");
            }
            _ => {}
        }
    }

    // ---------- rendering ----------

    fn render(&mut self, f: &mut Frame) {
        let banner = if self.rollbacks.is_empty() { 0 } else { 3 };
        let [main, banner_area, status_area] =
            Layout::vertical([Constraint::Min(3), Constraint::Length(banner), Constraint::Length(1)]).areas(f.area());
        let [list_area, editor_area] =
            Layout::horizontal([Constraint::Length(32.min(main.width / 3).max(20)), Constraint::Min(10)]).areas(main);

        self.render_list(f, list_area);
        self.render_editor(f, editor_area);
        if banner > 0 {
            self.render_banner(f, banner_area);
        }
        self.render_status(f, status_area);
    }

    fn render_list(&mut self, f: &mut Frame, area: Rect) {
        let notes = self.visible_notes();
        if self.list.selected().is_some_and(|i| i >= notes.len()) {
            self.list.select(Some(notes.len().saturating_sub(1)));
        }
        let open = self.note.as_ref().map(|n| n.note_id.clone());
        // While a note is open, the selection is that note, wherever editing moved it in the
        // list (a row number would point at another note: Esc, Enter would open that one).
        if self.focus == Focus::Editor
            && let Some(i) = open.as_deref().and_then(|id| notes.iter().position(|n| n.id == id))
        {
            self.list.select(Some(i));
        }
        let selected = self.list.selected();
        let width = area.width.saturating_sub(4) as usize;
        let items: Vec<ListItem> = notes
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let when = relative_short(n.updated);
                // Marked like the web app's list ("Shared · 2d"), in a colour that shows on the selected row too.
                let tag = if n.shared { "Shared · " } else { "" };
                let title = if n.title.is_empty() { "Untitled".to_string() } else { n.title.clone() };
                let room = width.saturating_sub(tag.chars().count() + when.chars().count() + 1);
                let title: String = if title.chars().count() > room {
                    title.chars().take(room.saturating_sub(1)).chain(['…']).collect()
                } else {
                    title
                };
                let pad = width.saturating_sub(title.chars().count() + tag.chars().count() + when.chars().count());
                let mut style = Style::default();
                if n.title.is_empty() {
                    style = style.italic().fg(Color::DarkGray);
                }
                if open.as_deref() == Some(n.id.as_str()) {
                    style = style.bold();
                }
                ListItem::new(Line::from(vec![
                    Span::styled(title, style),
                    Span::raw(" ".repeat(pad)),
                    Span::styled(tag, Style::default().fg(Color::Cyan)),
                    // (Lighter on the selected row: dark grey disappears on its highlight.)
                    Span::styled(when, Style::default().fg(if selected == Some(i) { Color::Gray } else { Color::DarkGray })),
                ]))
            })
            .collect();
        let title = match (&self.mode, self.filter.is_empty()) {
            (Mode::Search, _) => format!(" /{}▏", self.filter),
            (_, false) => format!(" Plim — /{} ", self.filter),
            _ => " Plim ".to_string(),
        };
        let focused = self.focus == Focus::List;
        let block = Block::default().borders(Borders::ALL).title(title).border_style(border(focused));
        if items.is_empty() {
            let hint = if self.filter.is_empty() { "No notes yet.\nPress n to write one." } else { "No matches." };
            f.render_widget(Paragraph::new(hint).fg(Color::DarkGray).block(block), area);
            return;
        }
        let list = List::new(items).block(block).highlight_style(if focused {
            Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        });
        f.render_stateful_widget(list, area, &mut self.list);
    }

    fn render_editor(&mut self, f: &mut Frame, area: Rect) {
        let focused = self.focus == Focus::Editor;
        match self.note.as_mut() {
            Some(note) => {
                note.editor.set_block(Block::default().borders(Borders::ALL).border_style(border(focused)));
                note.editor.set_cursor_style(if focused {
                    Style::default().add_modifier(Modifier::REVERSED)
                } else {
                    Style::default()
                });
                f.render_widget(&note.editor, area);
            }
            None => {
                let p = Paragraph::new("\n  Select a note and press Enter, or press n for a new one.")
                    .fg(Color::DarkGray)
                    .block(Block::default().borders(Borders::ALL).border_style(border(false)));
                f.render_widget(p, area);
            }
        }
    }

    fn render_banner(&self, f: &mut Frame, area: Rect) {
        let what: Vec<String> = self
            .rollbacks
            .keys()
            .map(|k| match k.as_str() {
                "keyring" => "the encryption keys".to_string(),
                "index" => "the note list".to_string(),
                id => notes::all(&self.index.doc)
                    .into_iter()
                    .find(|n| n.id == id)
                    .map_or("a note".to_string(), |n| format!("\"{}\"", n.title)),
            })
            .collect();
        let text = vec![
            Line::from(Span::styled(
                " ⚠ The server sent older data than this device has seen before.",
                Style::default().fg(Color::Red).bold(),
            )),
            Line::from(format!("   Affected: {}. Recent changes may be missing.", what.join(", "))),
            Line::from("   (A restored server backup, or withheld data.) Press A in the list to acknowledge."),
        ];
        f.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), area);
    }

    fn render_status(&mut self, f: &mut Frame, area: Rect) {
        let (dot, label, color) = match self.overall_status() {
            Status::Saved => ("●", "Saved", Color::Green),
            Status::Saving => ("●", "Saving…", Color::Gray),
            Status::Offline => ("●", "Offline — saved on this device", Color::Yellow),
            Status::Error => ("●", "Couldn't save — retrying", Color::Red),
            Status::Full => ("●", "Storage full — kept on this device", Color::Red),
            Status::TooLarge => ("●", "Too large to sync well — split this note", Color::Red),
            Status::LinkOff => ("●", "This shared note's links were turned off", Color::Red),
        };
        // A view link (#80): say so where the save state goes.
        let (dot, label, color) = match &self.note {
            Some(n) if n.view_only && label == "Saved" => ("●", "View only", Color::Gray),
            _ => (dot, label, color),
        };
        if self.message.as_ref().is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(4)) {
            self.message = None;
        }
        let hints = match (&self.mode, &self.focus) {
            (Mode::ConfirmDelete(_), _) => "Delete this note? y / n".to_string(),
            (Mode::Search, _) => "type to filter · Enter keep · Esc clear".to_string(),
            (_, Focus::Editor) => "Esc list · ^E $EDITOR · ^N new · ^Q quit".to_string(),
            (_, Focus::List) => "↑↓ move · Enter open · n new · e $EDITOR · / search · d delete · q quit".to_string(),
        };
        let right = self.message.as_ref().map(|(m, _)| m.clone()).unwrap_or(hints);
        let left = format!(" {dot} {label}");
        let pad = (area.width as usize).saturating_sub(left.chars().count() + right.chars().count() + 1);
        let line = Line::from(vec![
            Span::styled(format!(" {dot}"), Style::default().fg(color)),
            Span::raw(format!(" {label}")),
            Span::raw(" ".repeat(pad)),
            Span::styled(right, Style::default().fg(Color::DarkGray)),
        ]);
        f.render_widget(Paragraph::new(line), area);
    }
}

fn enter_terminal() -> DefaultTerminal {
    let terminal = ratatui::init();
    let _ = execute!(std::io::stdout(), EnableBracketedPaste);
    terminal
}

fn leave_terminal() {
    let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    ratatui::restore();
}

fn new_editor(text: &str) -> TextArea<'static> {
    let mut t = TextArea::new(text.split('\n').map(String::from).collect());
    t.set_wrap_mode(WrapMode::WordOrGlyph);
    t.set_cursor_line_style(Style::default());
    t.set_placeholder_text("Start typing…");
    t
}

fn border(focused: bool) -> Style {
    if focused { Style::default().fg(Color::Blue) } else { Style::default().fg(Color::DarkGray) }
}

fn relative_short(ms: f64) -> String {
    if ms == 0.0 {
        return String::new();
    }
    let s = (notes::now_ms() - ms) / 1000.0;
    match s {
        s if s < 60.0 => "now".into(),
        s if s < 3600.0 => format!("{}m", (s / 60.0) as u64),
        s if s < 86400.0 => format!("{}h", (s / 3600.0) as u64),
        s => format!("{}d", (s / 86400.0) as u64),
    }
}

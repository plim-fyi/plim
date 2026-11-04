// A note's address (#299): /n/<id>, the note's for life. Only the id is in the path (the
// server, its logs and the proxy's see it; a title never), and a bare address opens nothing for
// anyone without access to the note, so it's safe in history, bookmarks, chat logs and
// screenshots: a name, not a key. The app serves it (app.js enterNotes, ui/note.js), the
// service worker offline (sw.js), the terminal client takes it anywhere it takes a note.

const NOTE_PATH = /^\/n\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The note id a path names (`/n/<id>`), or null. */
export const noteIdAt = (pathname) => pathname.match(NOTE_PATH)?.[1].toLowerCase() ?? null;

export const notePath = (id) => `/n/${id}`;

/** A note's address, to copy or print. */
export const noteUrl = (id, origin = location.origin) => `${origin}${notePath(id)}`;

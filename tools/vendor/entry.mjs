// What the web app uses from CodeMirror 6 and y-codemirror.next. Bundled
// into web/vendor/codemirror.mjs by build.mjs; `yjs` stays external and
// resolves to the app's own web/vendor/yjs.mjs (one Yjs instance).
export { EditorSelection, EditorState, Compartment, Facet, Prec, StateField } from '@codemirror/state';
export { Decoration, drawSelection, EditorView, keymap, placeholder, showTooltip, tooltips, ViewPlugin, WidgetType } from '@codemirror/view';
export { indentLess, indentMore, standardKeymap } from '@codemirror/commands';
// Markdown, shown formatted (web/livepreview.js): the GitHub-flavoured language only, and its
// list commands. Not `markdown()`, which brings HTML, CSS and JavaScript parsers along.
export { Language, syntaxTree } from '@codemirror/language';
export { deleteMarkupBackward, insertNewlineContinueMarkup, markdownLanguage } from '@codemirror/lang-markdown';
export { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
// Presence for shared notes: who's in the note, and where their cursor is.
export { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

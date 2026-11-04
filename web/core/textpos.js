// A place in a note's text that stays with the same text when it's edited around (here or on
// another device): a Yjs relative position, as a string to keep (the saved cursor and scroll of
// a note, ui/note.js) or to send (where your cursor is, for the others in a shared note).
import * as Y from '../vendor/yjs.mjs';
import { b64, unb64 } from './crypto.js';

/** `pos` in `ytext` now, as a string that follows the text. */
export const relative = (ytext, pos) => b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, pos)));

/**
 * Where position `pos` of a text is after a change to it (a Y.Text delta), staying with the text
 * it was in: text put in at `pos` or before pushes it on; inside what's taken out, it's where that was.
 */
export function mapPos(pos, delta) {
  let at = 0, out = pos;
  for (const op of delta) {
    if (op.retain != null) {
      at += op.retain;
      if (at > pos) break;
    } else if (op.insert != null) {
      if (at <= pos) out += typeof op.insert === 'string' ? op.insert.length : 1;
    } else if (op.delete != null) {
      if (at + op.delete <= pos) {
        out -= op.delete;
        at += op.delete;
      } else {
        out -= pos - at;
        break;
      }
    }
  }
  return out;
}

/**
 * `mapPos` the other way (#331): where position `pos` of the text after a change (a Y.Text delta)
 * was before it. Text put in before `pos`: less; `pos` inside what was put in: where that went
 * in; text taken out before it: more.
 */
export function unmapPos(pos, delta) {
  let at = 0, out = pos; // (`at`: where we are in the text after the change)
  for (const op of delta) {
    if (op.retain != null) {
      at += op.retain;
      if (at > pos) break;
    } else if (op.insert != null) {
      const n = typeof op.insert === 'string' ? op.insert.length : 1;
      if (at + n <= pos) {
        out -= n;
        at += n;
      } else {
        out -= pos - at;
        break;
      }
    } else if (op.delete != null) {
      if (at < pos) out += op.delete;
    }
  }
  return out;
}

/** A position saved by `relative`, back in the text as it is now (null if it can't be found). */
export function absolute(ytext, saved) {
  try {
    const p = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(saved)), ytext.doc);
    return p && p.type === ytext ? Math.min(p.index, ytext.length) : null;
  } catch {
    return null;
  }
}

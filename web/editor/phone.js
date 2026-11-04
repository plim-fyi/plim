// A phone (#283, #290): a touch screen, and an iPhone's or Android phone's browser, or a phone's
// width. There a note is edited as the markdown it is (Preview, a toggle: ui/reading.js), in a
// plain textarea the OS owns (textarea.js): none of CodeMirror (computers and tablets edit in it).
export const ON_A_PHONE = typeof navigator !== 'undefined' && typeof matchMedia !== 'undefined'
  && matchMedia('(hover: none) and (pointer: coarse)').matches
  && (/iPhone|Android.+Mobile/.test(navigator.userAgent) || matchMedia('(max-width: 720px)').matches);

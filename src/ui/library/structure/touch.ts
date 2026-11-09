/**
 * Touch targets of at least 44 px on the book page (spec §4.9): on phone widths and on touch screens of
 * any width, compact controls grow to 44 px; a desktop with a mouse keeps the compact sizes. Min sizes
 * win over the shared primitives' fixed heights, so nothing conflicts with ui.tsx (which is unchanged).
 */

/** A control at least 44 px tall. */
export const TOUCH = 'max-sm:min-h-11 pointer-coarse:min-h-11';
/** An icon-only control at least 44 × 44 px. */
export const TOUCH_SQUARE = 'max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
/** On a group of actions: every button and button-like link in it is at least 44 px tall. */
export const TOUCH_BUTTONS =
  'max-sm:[&_button]:min-h-11 pointer-coarse:[&_button]:min-h-11 max-sm:[&_a]:min-h-11 pointer-coarse:[&_a]:min-h-11';
/**
 * Dialog footers: wraps the footer's buttons without a box of its own (display: contents keeps the
 * footer's flex layout) so they grow on touch screens like TOUCH_BUTTONS.
 */
export const TOUCH_FOOTER = `contents ${TOUCH_BUTTONS}`;
/**
 * On a form or a dialog body: text boxes, selects and buttons are at least 44 px tall and icon buttons
 * 44 px wide (shared TagInput and Input included); checkboxes and radios are sized by their labels.
 */
export const TOUCH_FORM = [
  'max-sm:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11',
  'pointer-coarse:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11',
  'max-sm:[&_select]:min-h-11',
  'pointer-coarse:[&_select]:min-h-11',
  'max-sm:[&_button]:min-h-11',
  'pointer-coarse:[&_button]:min-h-11',
  'max-sm:[&_button]:min-w-11',
  'pointer-coarse:[&_button]:min-w-11',
].join(' ');
/** Around ui.tsx's Switch: its label (which toggles it) is a 44 px tall target, with the switch beside it centered. */
export const TOUCH_SWITCH = [
  'max-sm:[&>div]:items-center max-sm:[&_label]:flex max-sm:[&_label]:min-h-11 max-sm:[&_label]:items-center',
  'pointer-coarse:[&>div]:items-center pointer-coarse:[&_label]:flex pointer-coarse:[&_label]:min-h-11 pointer-coarse:[&_label]:items-center',
].join(' ');

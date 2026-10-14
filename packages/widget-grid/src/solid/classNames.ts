/**
 * Class names hosts need (ADR-0019). The stylesheet owns the selectors;
 * hosts that render their own grid markup (for example loading skeletons)
 * use these constants instead of repeating the literals.
 */

/** The grid element (`data-widget-grid`). */
export const WIDGET_GRID_CLASS = "wg-grid";
/** One widget frame (`article`). */
export const WIDGET_FRAME_CLASS = "wg-frame";
/** The scrollable widget body. */
export const WIDGET_BODY_CLASS = "wg-body";
/** The header strip (the drag handle). */
export const WIDGET_HEADER_CLASS = "wg-header";
/** The slot shown during a drag. */
export const WIDGET_PLACEHOLDER_CLASS = "wg-placeholder";

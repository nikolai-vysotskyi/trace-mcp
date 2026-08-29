/* icons.tsx — Lattice workspace inline-SVG icon set.
   Glyph bodies are ported VERBATIM from the Liquid Glass design bundle
   (project/icons.js) so the workspace matches the design 1:1. Drawn on a 24×24
   grid, rendered at currentColor with rounded caps/joins, stroke-width 1.6
   (the design default). renderIcon(name) in the bundle is the single source.

   For a production macOS build, swap each path body with the licensed SF Symbol
   exported from Apple's SF Symbols app — <Icon> is the single swap point. */

import { createContext, useContext } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { FILE_TYPE_SVGS } from './fileIcons.generated';

/** Raw inner-SVG markup per icon name (24×24 viewBox). Verbatim from icons.js. */
const GLYPHS: Record<string, string> = {
  // arrows & chevrons
  add: '<path d="M12 5v14M5 12h14"/>',
  remove: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M6 18L18 6"/>',
  check: '<path d="M5 12l5 5L20 6"/>',
  radio: '<circle cx="12" cy="12" r="8"/>',
  chevron_left: '<path d="M15 6l-6 6 6 6"/>',
  chevron_right: '<path d="M9 6l6 6-6 6"/>',
  expand_more: '<path d="M6 9l6 6 6-6"/>',
  expand_less: '<path d="M6 15l6-6 6 6"/>',
  arrow_upward: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrow_outward: '<path d="M7 17L17 7M7 7h10v10"/>',
  arrow_right_alt: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  more_horiz:
    '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  more_vert:
    '<circle cx="12" cy="6" r="1.55" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.55" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.55" fill="currentColor" stroke="none"/>',
  // 6-dot drag handle — signals a row can be picked up and reordered.
  drag: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',

  // files & folders
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folder_open:
    '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H3z"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 1H5a2 2 0 0 1-2-2z"/>',
  description: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  data_object:
    '<path d="M9 5a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3M15 5a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3"/>',
  function: '<path d="M19 5h-3a3 3 0 0 0-3 3v8a3 3 0 0 1-3 3H7M8 12h8"/>',
  account_tree:
    '<rect x="3" y="3" width="6" height="5" rx="1"/><rect x="15" y="8" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M9 5h3v13h3M12 11h3"/>',

  // intelligence / graph
  hub: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="1.5"/><circle cx="12" cy="20" r="1.5"/><circle cx="4" cy="8" r="1.5"/><circle cx="20" cy="8" r="1.5"/><circle cx="4" cy="16" r="1.5"/><circle cx="20" cy="16" r="1.5"/><path d="M12 7v-1.5M12 17v1.5M9.5 10.5L5.2 8.6M14.5 10.5l4.3-1.9M9.5 13.5l-4.3 1.9M14.5 13.5l4.3 1.9"/>',
  smart_toy:
    '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  neurology:
    '<path d="M9 18v-1a3 3 0 0 0-1-2 5 5 0 1 1 8-4 4 4 0 0 1-1 3 3 3 0 0 0-1 2v2"/><path d="M9 21h6M10 18h4"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  monitoring: '<path d="M4 4v16h16"/><path d="M8 14l3-3 2 2 4-5"/>',
  timeline:
    '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="8" r="2"/><path d="M8 11l8-2M11 13l4 6"/><circle cx="13" cy="18" r="2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4"/><path d="M12 8v4l3 2"/>',

  // actions & ui
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  manage_search: '<circle cx="9" cy="9" r="5"/><path d="M16 16l4 4M13 18h7M13 21h7"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  tune: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/>',
  light_mode:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  dark_mode: '<path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8z"/>',
  cable:
    '<path d="M5 3v6a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3v6M5 9h0M19 21h0"/><rect x="3" y="1" width="4" height="4" rx="1"/><rect x="17" y="19" width="4" height="4" rx="1"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  // Question mark in a circle — the glyph for help. Honest about what help is
  // here: a page of answers, not someone waiting to talk to you.
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4"/><circle cx="12" cy="16.6" r="0.7" fill="currentColor" stroke="none"/>',
  /* REMOVED, and not to be re-added under any name (DESIGN.md §5):
     - `auto_awesome` (sparkles) — decorates rather than names. It is the
       AI-marketing glyph; on a developer tool it says "exciting" instead of
       saying what the item does. `View changelog` uses `description`.
     - `forum` (speech bubbles) — promises a conversation with a person. Every
       place we used it opens a page or a text field instead: `Get help` opens
       GitHub issues (`help`), Ask queries the index (`search`).
     A glyph is a name, not decoration. If you reach for either of these, the
     item you are labelling probably has a more specific destination to name. */
  pause: '<path d="M8 5v14M16 5v14"/>',
  play_arrow: '<path d="M7 5v14l12-7z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  add_note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M18 3v6M15 6h6"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
  git_branch:
    '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="9" r="3"/><path d="M18 12a9 9 0 0 1-9 9M6 9v6"/>',
  favorite: '<path d="M12 21s-7-4.5-9-9a4.5 4.5 0 0 1 9-2 4.5 4.5 0 0 1 9 2c-2 4.5-9 9-9 9z"/>',
  grid_view:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  // Project "Overview" landing tab — a compass needle echoing the Lattice app
  // icon (the liquid-glass compass). Reads as "get your bearings on the project"
  // and ties the tab to the product's own identity rather than a generic grid.
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.4 5.2-5.2 2.4 2.4-5.2z"/><circle cx="12" cy="12" r="0.6"/>',
  format_align_left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  view_column:
    '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><rect x="17" y="4" width="4" height="16" rx="1"/>',
  // Kanban board — Trello-style mark: a rounded board frame holding two
  // filled column-cards of different heights (a tall "todo" stack and a short
  // "done" stack). Reads instantly as a task board and scales cleanly to 12px.
  kanban:
    '<rect x="4" y="4" width="16" height="16" rx="2.5"/>' +
    '<rect x="6.7" y="7" width="4.1" height="10" rx="1.3" fill="currentColor" stroke="none"/>' +
    '<rect x="13.2" y="7" width="4.1" height="6" rx="1.3" fill="currentColor" stroke="none"/>',
  view_grid:
    '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  dock_to_right: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  attach_file: '<path d="M16 6l-6.5 6.5a3 3 0 0 0 4 4L21 9a5 5 0 0 0-7-7L6 10a7 7 0 0 0 10 10l5-5"/>',
  fit_screen:
    '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
  filter_center_focus:
    '<path d="M5 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3"/><circle cx="12" cy="12" r="3"/>',
  fullscreen: '<path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
  fullscreen_exit:
    '<path d="M5 8h3V5M16 5v3h3M19 16h-3v3M8 19v-3H5"/>',
  terminal:
    '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  pull_request:
    '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><circle cx="18" cy="18" r="3"/><path d="M18 15V9a3 3 0 0 0-3-3h-3l2-2m0 4l-2-2"/>',
  dock_bottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15h18"/>',
  db_key: '<circle cx="8" cy="8" r="3"/><path d="M10 10l6 6M14 14l2 2M16 12l2 2"/>',
  db_column: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 9h14M5 15h14"/>',
  // Grid table — outer frame + header row + column dividers. Reads as a data
  // table (rows × columns), distinct from the single-column db_column card.
  db_table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11"/>',
  db_schema:
    '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v4h11v4M6.5 12v4"/>',
  db_server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h0M7 16.5h0"/>',
  db_index: '<path d="M4 6h16M4 12h16M4 18h16M9 3v18"/><circle cx="6.5" cy="6" r="0.5"/>',
  visibility: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
  cloud: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A3.5 3.5 0 0 1 18 18z"/>',
  compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M17 3l4 4-9 9h-4v-4z"/>',
  phone: '<path d="M5 3h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  hand_raised:
    '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6m0-1V4a1.5 1.5 0 0 1 3 0v7m0-1V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-3.5a1.5 1.5 0 0 1 2.5-1.7L8 13z"/>',
  automation: '<rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V4M9 13h0M15 13h0M8 4h8"/>',
  plugins:
    '<path d="M7 8V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3M5 8h14v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM12 18v3"/>',
  // The VS Code "Extensions" mark: three aligned squares plus a fourth, rotated
  // square breaking away at the top-right — instantly reads as "add-ons". Drawn
  // as four rounded squares so it stays crisp at rail size.
  extension:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/>' +
    '<rect x="3.5" y="13" width="7" height="7" rx="1.4"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1.4"/>' +
    '<rect x="13.7" y="3" width="6.6" height="6.6" rx="1.4" transform="rotate(20 17 6.3)"/>',
  content_copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/>',
  trash: '<path d="M5 7h14M10 4h4M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L18 10l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  // Solid pencil (Material "edit" filled) — fill-only, centered on the 24-grid.
  // Used where a small, solid affordance reads better than the thin outline
  // (e.g. the board-tab rename action).
  'edit-fill':
    '<path fill="currentColor" stroke="none" d="M3 17.46V21h3.54L17.81 9.73l-3.54-3.54L3 17.46zm17.71-10.5a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  delete: '<path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/>',
  view_list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>',
  bug_report:
    '<rect x="8" y="7" width="8" height="11" rx="4"/><path d="M12 7V4M9 5l-2-2M15 5l2-2M8 11H4M16 11h4M8 15H5M16 15h3M9.5 18l-2 3M14.5 18l2 3"/>',
  wifi: '<path d="M5 12a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0M11 18a1.5 1.5 0 0 1 2 0"/>',
  bluetooth: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  notifications: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  volume_up: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/>',

  // Lattice extras (not in the bundle) — kept for chrome that needs them
  refresh:
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  // Git workflow extras
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10H9"/>',
  arrow_downward: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  cloud_upload:
    '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A3.5 3.5 0 0 1 17 18"/><path d="M12 21v-8M9 16l3-3 3 3"/>',
  cloud_download:
    '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A3.5 3.5 0 0 1 17 18"/><path d="M12 12v8M9 17l3 3 3-3"/>',
  done_all: '<path d="M2 13l4 4L15 8M11 17l1.5 1.5L22 8"/>',
  difference:
    '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M8 21h11a2 2 0 0 0 2-2V8M7 7h5M9.5 4.5v5"/>',
  // Clock — the composer's "queue / send when the current run finishes" action.
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',

  // File-type glyphs (used by fileKind for non-language files)
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  warning: '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4M12 17.2h0"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  font: '<path d="M5 19l5-13h1.6l5 13M7.6 14h6.8"/>',
  movie:
    '<path d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5V8M3 8h18v10.5A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M3 8l3.5-3M9 8l3.5-3M15 8l3.5-3"/>',
  music_note: '<circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="16" r="2.4"/><path d="M9.4 18V6.5l10-2V16"/>',
  binary:
    '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',

  // Vendor brand marks for the agent catalog. Drawn on the same 24×24 stroke
  // grid (not the trademark vectors) — simplified, recognizable marks tinted to
  // each brand's accent via .ag-logo--anthropic / .ag-logo--openai in CSS.
  // Anthropic — radial sunburst (8 spokes from a small core).
  anthropic:
    '<path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.2 5.2l4.2 4.2M14.6 14.6l4.2 4.2M18.8 5.2l-4.2 4.2M9.4 14.6l-4.2 4.2" stroke-width="2"/>',
  // OpenAI — three interlocking loops forming the hexafoil blossom.
  openai:
    '<ellipse cx="12" cy="12" rx="2.5" ry="8.4"/><ellipse cx="12" cy="12" rx="2.5" ry="8.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="2.5" ry="8.4" transform="rotate(120 12 12)"/>',
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** Inline-SVG icon. Falls back to the `description` glyph for unknown names. */
export function Icon({ name, size = 18, className, style }: IconProps): ReactElement {
  const body = GLYPHS[name] ?? GLYPHS.description;
  return (
    <span
      className={'sym' + (className ? ' ' + className : '')}
      style={{ display: 'inline-flex', lineHeight: 0, width: size, height: size, ...style }}
      // Inline glyph markup is a static, build-time constant — no user input.
      dangerouslySetInnerHTML={{
        __html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
      }}
    />
  );
}

/* Folder icon from the IntelliJ Platform New UI icon set — intellij-community
   `platform/icons/src/expui/nodes/folder.svg`, © JetBrains s.r.o., Apache-2.0
   (attribution in NOTICE). A 16×16 two-tone folder (filled body + contrasting
   border); one icon serves both collapsed and expanded state — the disclosure
   chevron carries open/closed — so there is no separate open variant.

   Fill + stroke are NOT baked in: the `.fld` path is colored entirely from CSS
   (.ws-folderico .fld), so the row's hue class drives both — gray (regular),
   tan (hidden/dot), orange (excluded/deps), white (selected). */
const FOLDER_PATH =
  'M8.10584 4.34613L8.25344 4.5H8.46667H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.9529 13.932 13.5 13.3667 13.5H2.63333C2.06804 13.5 1.5 12.9529 1.5 12.1333V3.86667C1.5 3.04707 2.06804 2.5 2.63333 2.5H6.1217C6.25792 2.5 6.38824 2.55557 6.48253 2.65387L8.10584 4.34613Z';

/** Two-tone folder icon (IntelliJ Platform, Apache-2.0; colored via CSS `.fld`). */
export function FolderGlyph({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <span
      className={'sym' + (className ? ' ' + className : '')}
      style={{ display: 'inline-flex', lineHeight: 0, width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path className="fld" d={FOLDER_PATH} />
      </svg>
    </span>
  );
}

/** "Black hole" agent mark — the generic AI/agent avatar. Artwork from the
    Solar icon set by 480 Design (CC BY 4.0, see NOTICE); two-tone via opacity. */
export function AgentMark({ className }: { className?: string }): ReactElement {
  return (
    <svg
      className={'ws-ai-star' + (className ? ' ' + className : '')}
      viewBox="0 0 24 24"
      fill="#7a5af0"
    >
      <path
        opacity=".5"
        d="M12.735 14.654a.75.75 0 0 1-.23-1.44c.224-.094.441-.237.645-.44a.75.75 0 0 1 .996-.058a.75.75 0 0 1 .705.954c-.21.746-.6 1.477-1.105 2.147a.75.75 0 0 1-1.197-.903q.098-.13.186-.26m-2.248.041a.75.75 0 0 0 .953-.707a.75.75 0 0 0-.058-.994a2 2 0 0 1-.442-.646a.75.75 0 0 0-1.438.23a7 7 0 0 1-.26-.186a.75.75 0 0 0-.903 1.198c.67.505 1.4.894 2.148 1.105m-3.811-2.749a.75.75 0 0 0 1.18-.925a8 8 0 0 1-1.01-1.677a.75.75 0 1 0-1.372.604c.317.72.728 1.394 1.202 1.998M4.84 7.672a.75.75 0 0 0 1.49-.178a5.1 5.1 0 0 1 .108-1.862a.75.75 0 0 0-1.454-.366a6.6 6.6 0 0 0-.144 2.406M6.008 3.08a.75.75 0 1 0 1.218.875q.265-.37.62-.727a.75.75 0 0 0-1.06-1.061a7.4 7.4 0 0 0-.778.912m5.755 6.007a7 7 0 0 0-.187.26a.75.75 0 0 1 .23 1.439a2 2 0 0 0-.645.441a.75.75 0 0 1-.995.058a.752.752 0 0 1-.706-.954c.211-.746.6-1.477 1.105-2.147a.75.75 0 0 1 1.198.903m2.062.219a.75.75 0 0 0-.954.707a.75.75 0 0 0 .059.994c.204.204.347.421.441.645a.75.75 0 0 0 1.439-.23q.13.09.26.187a.75.75 0 0 0 .902-1.198c-.67-.505-1.4-.894-2.147-1.105m3.81 2.749a.75.75 0 1 0-1.18.925c.4.511.746 1.079 1.01 1.677a.75.75 0 0 0 1.372-.604a9.4 9.4 0 0 0-1.202-1.998m1.837 4.274a.75.75 0 1 0-1.49.178a5.1 5.1 0 0 1-.109 1.862a.75.75 0 0 0 1.455.366a6.6 6.6 0 0 0 .143-2.406m-1.167 4.592a.75.75 0 0 0-1.218-.875a6 6 0 0 1-.621.727a.75.75 0 0 0 1.06 1.06q.44-.439.779-.911M12.082 7.573a.75.75 0 0 1 .127-1.053a9.4 9.4 0 0 1 1.998-1.202a.75.75 0 0 1 .604 1.373a8 8 0 0 0-1.677 1.01a.75.75 0 0 1-1.053-.128m3.747-2.056a.75.75 0 0 1 .656-.833a6.6 6.6 0 0 1 2.405.143a.75.75 0 1 1-.366 1.455a5.1 5.1 0 0 0-1.862-.109a.75.75 0 0 1-.834-.656m4.203.506a.75.75 0 0 1 1.046-.171q.472.339.912.778a.75.75 0 1 1-1.06 1.06a6 6 0 0 0-.728-.62a.75.75 0 0 1-.17-1.047M12.103 17.48a.75.75 0 0 0-.926-1.18A8 8 0 0 1 9.5 17.31a.75.75 0 1 0 .604 1.372a9.4 9.4 0 0 0 1.999-1.202m-4.275 1.836a.75.75 0 1 0-.178-1.49a5.1 5.1 0 0 1-1.862-.108a.75.75 0 1 0-.366 1.454a6.6 6.6 0 0 0 2.406.144m-4.592-1.168a.75.75 0 1 0 .875-1.218a6 6 0 0 1-.727-.62a.75.75 0 0 0-1.06 1.06q.439.44.912.778"
      />
      <path d="M8.928 12.453c.406.836 1.016 1.541 1.825 1.942c-.793.183-1.71.22-2.648.087C5.315 14.087 2.75 12.284 2.75 9a.75.75 0 0 0-1.5 0c0 4.316 3.436 6.513 6.645 6.968c1.612.228 3.27.042 4.558-.584c.868-.422 1.596-1.065 1.988-1.921c.142.741.162 1.578.041 2.432c-.395 2.79-2.198 5.355-5.482 5.355a.75.75 0 0 0 0 1.5c4.316 0 6.513-3.436 6.968-6.645c.228-1.612.042-3.27-.584-4.558c-.346-.712-.84-1.33-1.48-1.745a7.7 7.7 0 0 1 1.99.027c2.792.396 5.356 2.198 5.356 5.483a.75.75 0 0 0 1.5 0c0-4.316-3.436-6.513-6.645-6.968c-1.612-.228-3.27-.043-4.558.584c-.692.336-1.294.812-1.709 1.425a7.6 7.6 0 0 1-.009-2.248c.396-2.79 2.198-5.355 5.483-5.355a.75.75 0 0 0 0-1.5c-4.316 0-6.513 3.436-6.968 6.645c-.228 1.612-.043 3.27.584 4.558" />
    </svg>
  );
}

// ClaudeMark / CodexMark / AsanaMark (stylized third-party brand marks in the
// source Codechats app) were intentionally dropped in this port — trace-mcp
// doesn't tag per-provider chat rows, so they'd be unused dead code, and
// there's no reason to carry stylized Anthropic/OpenAI/Asana marks into an
// MIT repo that doesn't need them.

/* ============================================================================
   File-type icons — IntelliJ Platform New UI icon set, © JetBrains s.r.o.,
   Apache-2.0 (attribution in NOTICE; TypeScript is the Devicon mark, MIT).
   The {light,dark} SVG bodies in fileIcons.generated.ts are fetched from
   github.com/JetBrains/intellij-community by scripts/generate-file-icons.mjs.
   We render the variant matching the active island theme.
   ============================================================================ */

/** Active island theme, mirrored from WorkspaceShell so file-type glyphs can pick
    the matching {light,dark} variant without threading a prop through every panel. */
export const IslandThemeContext = createContext<'dark' | 'light'>('dark');

/** A file maps to exactly one file-type icon id (a key in FILE_TYPE_SVGS). */
export type FileKind = { ftype: string };

/** Extension → file-type icon id. Unmapped extensions fall back to the `text`
    document icon, so a file is never invisible. */
const FTYPE_BY_EXT: Record<string, string> = {
  // languages
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python', pyi: 'python',
  php: 'php', phtml: 'php',
  java: 'java',
  scala: 'scala', sc: 'scala',
  c: 'c', h: 'h',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', 'h++': 'cpp', ino: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  vue: 'vue',
  groovy: 'groovy', gvy: 'groovy',
  gradle: 'gradle',
  graphql: 'graphql', gql: 'graphql',
  perl: 'perl', pl: 'perl', pm: 'perl', pod: 'perl',
  // data / config
  json: 'json', json5: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', wsdl: 'xml', plist: 'xml',
  sql: 'sql', ddl: 'sql',
  csv: 'csv', tsv: 'csv',
  properties: 'properties',
  editorconfig: 'editorconfig',
  ini: 'config', conf: 'config', cfg: 'config', env: 'config',
  tf: 'terraform', tfvars: 'terraform', hcl: 'terraform',
  // markup / styles / docs
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css', pcss: 'css', styl: 'css',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  rst: 'rst',
  ipynb: 'jupyter',
  // web templates → markup
  hbs: 'html', handlebars: 'html', mustache: 'html', ejs: 'html', njk: 'html',
  liquid: 'html', twig: 'html', erb: 'html', haml: 'html', blade: 'html', mjml: 'html',
  // shell
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
  ps1: 'shell', bat: 'shell', cmd: 'shell',
  // images
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image',
  tiff: 'image', tif: 'image', psd: 'image', ai: 'image', eps: 'image', xcf: 'image', svgz: 'image',
  // fonts
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  // archives & installers
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', rar: 'archive',
  '7z': 'archive', bz2: 'archive', xz: 'archive', zst: 'archive',
  jar: 'archive', war: 'archive', ear: 'archive', apk: 'archive', aab: 'archive',
  ipa: 'archive', whl: 'archive', gem: 'archive', nupkg: 'archive', deb: 'archive',
  rpm: 'archive', dmg: 'archive', pkg: 'archive', iso: 'archive', msi: 'archive', cab: 'archive',
  // compiled / binary
  wasm: 'binarydata', wat: 'binarydata', class: 'binarydata', o: 'binarydata',
  obj: 'binarydata', a: 'binarydata', lib: 'binarydata', so: 'binarydata',
  dylib: 'binarydata', dll: 'binarydata', exe: 'binarydata', bin: 'binarydata',
  out: 'binarydata', pyc: 'binarydata', pyd: 'binarydata',
  parquet: 'binarydata', avro: 'binarydata',
  // documents → text
  txt: 'text', log: 'text', pdf: 'text', rtf: 'text', tex: 'text', bib: 'text',
  adoc: 'text', asciidoc: 'text', org: 'text', textile: 'text',
  doc: 'text', docx: 'text', odt: 'text',
  ppt: 'text', pptx: 'text', odp: 'text', xlsx: 'text', xls: 'text', ods: 'text',
};

/** Extension-less shell rc / profile dotfiles → shell icon. */
const SHELL_RC = new Set([
  '.zshrc', '.bashrc', '.zshenv', '.zprofile', '.zlogin', '.bash_profile',
  '.profile', '.bash_aliases', '.bash_login', '.bash_logout', '.cshrc', '.kshrc',
]);

/** Map a filename to its file-type icon id. Whole-name rules win over the
    raw extension (Dockerfile, .gitignore, dotfile configs…). */
export function fileKind(name: string): FileKind {
  const n = name.toLowerCase();
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';

  if (n === 'dockerfile' || n.startsWith('dockerfile.') || ext === 'dockerfile')
    return { ftype: 'docker' };
  if (n === '.gitignore' || n === '.gitattributes' || n === '.gitmodules')
    return { ftype: 'gitignore' };
  if (n === '.env' || n.startsWith('.env.')) return { ftype: 'config' };
  if (SHELL_RC.has(n)) return { ftype: 'shell' };
  // Dotfile config / ignore lists (.npmrc, .babelrc, .prettierignore…).
  if (n.startsWith('.') && (n.endsWith('rc') || n.endsWith('ignore'))) return { ftype: 'config' };

  return { ftype: FTYPE_BY_EXT[ext] ?? 'text' };
}

export interface FileTypeGlyphProps {
  ftype: string;
  size?: number;
  className?: string;
}

/** File-type icon (IntelliJ Platform set), rendered for the active island theme. */
export function FileTypeGlyph({ ftype, size = 16, className }: FileTypeGlyphProps): ReactElement {
  const theme = useContext(IslandThemeContext);
  const variant = FILE_TYPE_SVGS[ftype] ?? FILE_TYPE_SVGS.text;
  const inner = theme === 'light' ? variant.light : variant.dark;
  return (
    <span
      className={'ws-fticon' + (className ? ' ' + className : '')}
      style={{ display: 'inline-flex', lineHeight: 0, width: size, height: size }}
      // Generated SVG markup — a static build-time constant, no user input.
      dangerouslySetInnerHTML={{
        __html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none">${inner}</svg>`,
      }}
    />
  );
}

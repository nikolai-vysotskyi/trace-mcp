/* The top band — the one horizontal line every window-chrome control sits on.
   (TRA-370)

   The macOS traffic lights are drawn by the system, positioned by the MAIN
   process; the sidebar toggle and the surface toolbar are drawn by the
   renderer, positioned by CSS. Before this file those were two independent
   literals in two files, and they disagreed: the strip was 44px (centre 22)
   while `trafficLightPosition.y = 18` put the lights' centre at 25. Three
   pixels, permanently, with a comment claiming they were centred.

   So the band height lives here once, `--top-band-h` is generated from it, and
   the traffic-light offset is DERIVED from it. Change TOP_BAND_H and both
   move together. `tokens.test.ts` fails if tokens.css drifts from this value. */

/** Height of every top band in the app, in CSS px. Mirrored by `--top-band-h`. */
export const TOP_BAND_H = 44;

/** The macOS traffic lights are 12pt circles. */
export const TRAFFIC_LIGHT_D = 12;

/* `trafficLightPosition.y` is NOT the top edge of the circle — the button's
   frame carries a point above it, so the circle renders one point lower than
   the offset asks for. Measured on macOS 26 / Electron 41 by screen-capturing
   the real window and reading the red light's row profile: y=18 centres it at
   25.0, y=15 centres it at 22.0. Slope 1, intercept 7. If a future Electron
   changes the button's frame, this is the constant that absorbs it. */
const TRAFFIC_LIGHT_FRAME_INSET = 1;

/** Offset that centres the lights in a band this tall. Never write it by hand. */
const centreLightsIn = (bandH: number): number =>
  (bandH - TRAFFIC_LIGHT_D) / 2 - TRAFFIC_LIGHT_FRAME_INSET;

/** Offset that centres the lights in the band. Never write this number down. */
export const TRAFFIC_LIGHT_Y = centreLightsIn(TOP_BAND_H);

/* ---- The second band, the one we do not draw (TRA-399) --------------------
   A macOS tabbed window grows an AppKit tab bar. The window is
   `titleBarStyle: 'hiddenInset'`, i.e. full-size content view, so the web
   contents does NOT shrink — `innerHeight` stays equal to `outerHeight` and the
   tab bar is painted OVER the top of the renderer. Reserve its height or it
   swallows whatever the app drew on that line, which is the entire surface
   toolbar plus the sidebar toggle.

   Measured on macOS 26.5 / Electron 41.10.6, two tabs open, by the MARKER ROW:
   paint the whole renderer a colour macOS chrome never uses (#FF00FF), then
   photograph the window (`screencapture -l<CGWindowID>`) and read the row
   profile. The first fully magenta row IS the bar's bottom edge, because the
   bar is the only thing that can cover the marker. y=0..27.5 is plate (the last
   two of those rows being its separator), y=28.0 is the first clean marker row.

   Read it that way and only that way. TRA-432: the first measurement asked
   "where does the sidebar's material resume?" instead, got 36.0, and shipped
   it — but 36.0 is where OUR OWN reserved band ends, not the bar. The 8px
   between them is this constant over-reserving, rendered in the window's
   backdrop, which looks exactly like a bar that is 8px taller. A band 8px too
   tall centres the traffic lights 4px too low, and that is what users saw. The
   marker row cannot make that mistake: nothing but the bar hides the marker.

   If a future macOS changes the metric, this is the one constant that absorbs
   it — re-measure with the marker, do not eyeball a screenshot. */

/** Height of the AppKit tab bar on a tabbed window, in CSS px. */
export const MAC_TAB_BAR_H = 28;

/** Offset that centres the lights in the TAB BAR, which owns the top band then. */
export const TRAFFIC_LIGHT_Y_TABBED = centreLightsIn(MAC_TAB_BAR_H);

/** The offset that holds right now. The lights belong to whichever band is on
    the window's top line — ours at 44px, AppKit's tab bar at 36px. */
export const trafficLightYFor = (tabBarVisible: boolean): number =>
  tabBarVisible ? TRAFFIC_LIGHT_Y_TABBED : TRAFFIC_LIGHT_Y;

/** Distance from the window's leading edge to the first light. */
export const TRAFFIC_LIGHT_X = 14;

/** Where the lights' centre lands, given an offset — that band's centre. */
export const trafficLightCentreY = (y: number = TRAFFIC_LIGHT_Y): number =>
  y + TRAFFIC_LIGHT_FRAME_INSET + TRAFFIC_LIGHT_D / 2;

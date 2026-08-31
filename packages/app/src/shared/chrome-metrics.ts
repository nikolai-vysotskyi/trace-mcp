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

/** The macOS traffic lights are 12pt circles.
    macOS 26 draws them at 14pt; the pair below absorbs the difference, because
    what `centreLightsIn` needs is the centre offset (bandH / 2 - 7), and 12
    with a 1pt frame inset and 14 with none give the same number. Change one
    without the other and every band moves. */
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

   Measured on macOS 26.5 / Electron 41.10.6 from a 2x capture of a real
   two-tab window, by the two things that band actually contains:

     the bar's PLATE runs y=0 to y=20.0 — the same row at every x across the
     window, the fill below it being the window's own backdrop, not the bar;
     the SELECTED TAB's pill runs y=0.5 to y=17.5, centre y=9.0.

   Anything taller than 20 is not the bar. It is this constant over-reserving,
   and the surplus renders in the window's backdrop as a dead strip that looks
   exactly like a bar with nothing in it. Worse, the traffic lights are centred
   in whatever this says, so every surplus pixel puts them half a pixel below
   the tabs: at 36 they sat 8px low (TRA-370), at 28 they sat 4px low (TRA-432).
   Both of those came from asking where the surrounding material resumes rather
   than where the bar's own plate stops.

   28 then went back to 36 on its own: #659, a telemetry change, was squashed
   from a stale base and carried the old value in with it, along with several
   other unrelated reverts. Nothing caught it, because the only assertion on
   this constant compared it with itself. That is why the guard in
   tab-chrome.test.ts is written against a number measured off AppKit.

   If a future macOS changes the metric, this is the one constant that absorbs
   it. Re-measure both numbers — the plate's bottom row AND the tab centre —
   and update `MAC_TAB_CENTRE_Y` in tab-chrome.test.ts with them. A measurement
   of one alone is what went wrong twice. */

/** Height of the AppKit tab bar on a tabbed window, in CSS px. */
export const MAC_TAB_BAR_H = 28;

/** Offset that centres the lights in the TAB BAR, which owns the top band then. */
export const TRAFFIC_LIGHT_Y_TABBED = centreLightsIn(MAC_TAB_BAR_H);

/** The offset that holds right now. The lights belong to whichever band is on
    the window's top line — ours at TOP_BAND_H, AppKit's at MAC_TAB_BAR_H. */
export const trafficLightYFor = (tabBarVisible: boolean): number =>
  tabBarVisible ? TRAFFIC_LIGHT_Y_TABBED : TRAFFIC_LIGHT_Y;

/** Distance from the window's leading edge to the first light. */
export const TRAFFIC_LIGHT_X = 14;

/** Where the lights' centre lands, given an offset — that band's centre. */
export const trafficLightCentreY = (y: number = TRAFFIC_LIGHT_Y): number =>
  y + TRAFFIC_LIGHT_FRAME_INSET + TRAFFIC_LIGHT_D / 2;

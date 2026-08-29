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

/** Offset that centres the lights in the band. Never write this number down. */
export const TRAFFIC_LIGHT_Y = (TOP_BAND_H - TRAFFIC_LIGHT_D) / 2 - TRAFFIC_LIGHT_FRAME_INSET;

/** Distance from the window's leading edge to the first light. */
export const TRAFFIC_LIGHT_X = 14;

/** Where the lights' centre lands, given TRAFFIC_LIGHT_Y — the band's centre. */
export const trafficLightCentreY = (): number =>
  TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_FRAME_INSET + TRAFFIC_LIGHT_D / 2;

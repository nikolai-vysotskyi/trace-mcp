/* Appearance → the native layer (TRA-369).

   The Appearance control writes [data-theme] on <html>. CSS reads that;
   NSVisualEffectView cannot. Until the main process pushes the same choice into
   `nativeTheme.themeSource`, a window set to Light on a dark system draws a dark
   vibrancy sidebar next to a light content pane — and `backgroundColor`, picked
   from `nativeTheme.shouldUseDarkColors` at window construction, is wrong the
   same way.

   The choice itself lives in the renderer's localStorage, which main cannot
   read, so it is mirrored to a one-line file in userData. That is what makes the
   FIRST window of a cold launch open with the material already correct instead
   of flashing the system appearance until the renderer reports in.

   No `electron` import on purpose: the caller passes the userData directory and
   applies the returned themeSource, so this stays testable without a display. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What the user picked. `auto` = follow the system, and is the default. */
export type Appearance = 'auto' | 'light' | 'dark';
/** The matching `nativeTheme.themeSource` value. */
export type ThemeSource = 'system' | 'light' | 'dark';

const APPEARANCE_FILE = 'appearance';

/** Anything that is not an explicit choice means Auto — same rule as the
 *  renderer, where absence of the localStorage key IS Auto. */
export function parseAppearance(raw: unknown): Appearance {
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

export function themeSourceFor(appearance: Appearance): ThemeSource {
  return appearance === 'auto' ? 'system' : appearance;
}

export function readAppearance(userDataDir: string): Appearance {
  try {
    return parseAppearance(readFileSync(path.join(userDataDir, APPEARANCE_FILE), 'utf8').trim());
  } catch {
    return 'auto';
  }
}

export function writeAppearance(userDataDir: string, appearance: Appearance): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(path.join(userDataDir, APPEARANCE_FILE), appearance, 'utf8');
  } catch {
    // An unwritable userData dir costs one frame of the wrong material on the
    // next cold launch. Never worth failing a theme switch over.
  }
}

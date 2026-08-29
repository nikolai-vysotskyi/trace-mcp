/** Absolute path of the repository root. */
export const REPO_ROOT: string;
/** Absolute path of `scripts/screenshots.manifest.json`. */
export const MANIFEST_PATH: string;
/** Absolute path of `docs/images`. */
export const IMAGES_DIR: string;
/** Absolute path of the capture marker (`docs/images/screenshots.json`). */
export const MARKER_PATH: string;
/** Repo-relative directories whose changes invalidate a capture. */
export const UI_PATHS: string[];

export interface CaptureMarkerImage {
  name: string;
  file: string;
  surface: string;
  theme: 'light' | 'dark';
  width: number;
  height: number;
  bytes: number;
  alt: string;
}

export interface CaptureMarker {
  generatedAt: string;
  appVersion: string;
  commit: string;
  uiCommit: string;
  uiPaths: string[];
  images: CaptureMarkerImage[];
}

export interface CaptureState {
  uiCommit: string;
  appVersion: string;
  /** File names present in `docs/images`. */
  presentFiles: string[];
}

/** Whether the committed screenshots still describe the current app, and why not. */
export function checkFreshness(
  marker: Partial<CaptureMarker> | null | undefined,
  current: CaptureState,
): { fresh: boolean; reasons: string[] };

/** First 8 characters of a commit sha. */
export function short(sha: unknown): string;

/** Commit that last touched anything the screenshots show. */
export function uiCommit(repo?: string): string;

/** Parse the capture marker, or `null` when it is missing or unreadable. */
export function readMarker(markerPath?: string): CaptureMarker | null;

/** Top-left region, in CSS px, that must contain the macOS window buttons. */
export const CHROME_STRIP: { width: number; height: number };

/** 8-bit RGBA pixels of a decoded PNG. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG. Throws on anything else. */
export function decodePng(buf: Buffer | Uint8Array): DecodedImage;

/**
 * Whether a captured frame is a photograph of the macOS window — transparent
 * rounded corners and three coloured traffic lights — and why not.
 * `scale` is device px per CSS px.
 */
export function checkWindowChrome(
  image: DecodedImage,
  scale: number,
): { ok: boolean; reasons: string[] };

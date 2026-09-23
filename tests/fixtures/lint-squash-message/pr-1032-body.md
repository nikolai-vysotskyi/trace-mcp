Reported by Nikolai with a dock screenshot: our icon stands noticeably larger than every neighbour. He is right, and it is a regression from #949.

## The measurement

Scanning his screenshot for each icon's plate edges:

| icon | plate height |
|---|---|
| sloth, Craft, Raycast, orange, llama, bell, Gemini | **94 px** |
| trace-mcp | **116 px** |

23% larger than the entire rest of the dock.

## What went wrong

#949 changed the plate from 82% of the canvas to 100%, on the reasoning that our plate rendered *smaller* than its neighbours'. That inverted the actual convention: macOS draws every dock icon into the same slot, and a conforming icon leaves margin inside its own canvas rather than filling it. Apple's grid puts the rounded square at **824 of 1024 — 80.5%**, which is within half a percent of the 82% that was removed.

The model checks out exactly: the dock draws each file at ~117px, so a conforming plate lands at 117 × 0.805 = 94px, and a full-bleed one at 117. Both numbers match the screenshot.

## The fix, and where it lives

The margin goes into `gen-app-icon.mjs` at rasterisation, not back into the master:

```js
const DOCK_MARGIN_RATIO = 824 / 1024;
// viewBox="-124 -124 1272 1272" around the 1024 artwork
```

It is a packaging convention for one platform, not part of the mark — the lockups from #1029 inline the same master and must not inherit a dock margin. The masters keep drawing the plate edge to edge, and their existing test still asserts that.

Rendered at the dock's 117px slot, the plate is now **95px** against the neighbours' 94.

## Test evidence

A new test measures the **shipped** `icon-1024.png` rather than the master — scanning the alpha across the middle row — so the two conventions cannot drift into each other again.

```
packages/app  vitest run       → 71 files, 720 passed
packages/app  tsc              → clean
root          pnpm test        → 10469 passed, 28 skipped
```

Agent: Lead Engineer

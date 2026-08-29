# Design system

This is what the trace-mcp desktop app actually is, not what it aspires to be. Every
value here is read out of merged code and is cited to the file it lives in. If this
document and the code disagree, the code wins and this document is a bug.

The target is macOS 26 (Tahoe). The bar is not "consistent with the rest of the app" —
it is that a stranger opening trace-mcp assumes Apple shipped it.

**Read this before adding a screen.** It is meant to be read once, in order, and then
used as a checklist. Exact token values live in
`packages/app/src/renderer/styles/tokens.css`, which is the reference dump; this
document explains what each one is *for*.

---

## 1. The two-layer material model

There are exactly two layers, and mixing them is the single most common way to make
this app look wrong.

| Layer | What it is | Material |
|---|---|---|
| **Navigation / chrome** | sidebar, toolbars, floating control strips, menus, popovers | translucent — real vibrancy on macOS, `.glass` elsewhere |
| **Content** | everything in the content pane: cards, tables, rows, lists | **opaque** `--surface`, hairline border, no shadow |

Rules that fall out of this:

- **Glass belongs to navigation and controls only. Content is opaque.** A card is
  content. A KPI tile is content. A table is content. None of them get a backdrop
  filter. (`KpiTile.tsx`: "Cards are content, not chrome: opaque surface, 12px radius,
  hairline border, no shadow and no glass.")
- **Never glass on glass.** One translucent layer at a time. The one glass element
  inside the content pane is the floating bulk-actions strip, and it is floating
  *over* content, not part of it (`workspace/BulkActionsBar.tsx`).
- Cards get a hairline (`0.5px solid var(--separator)`), not a shadow. Shadows are for
  things that genuinely float: menus and popovers (`--shadow-panel`, `--menu-shadow`).

### How the glass is produced

On macOS the material is **native**, not CSS. `packages/app/src/main/tray.ts` creates
the window with:

```ts
opts.titleBarStyle = 'hiddenInset';
opts.trafficLightPosition = { x: 14, y: 18 };   // centres the 12px lights on the 44px strip
opts.vibrancy = 'sidebar';
opts.visualEffectState = 'followWindow';
opts.backgroundColor = '#00000000';
opts.transparent = false;
```

That is a real `NSVisualEffectView` behind the whole window. The renderer's job is to
keep the sidebar region *transparent* so the material shows through, and to paint
everything else opaque (`styles/sidebar.css`). `.ws-stage` is transparent on macOS for
the same reason; non-mac stages paint themselves.

`.glass` in `tokens.css` — `color-mix(--surface 62%, transparent)` +
`blur(28px) saturate(180%)` — is the **fallback for non-macOS and for elements that are
not the window's vibrant region** (toolbars, the bulk-actions strip).

We deliberately **did not adopt `electron-liquid-glass`.** The native
`BrowserWindow` vibrancy path gives us the material, desaturates when the window loses
key (`visualEffectState: 'followWindow'`), and honours Reduce Transparency for free —
with no extra native dependency, no feature detection, and no code path that no-ops
below macOS 26.

### A native material samples the desktop, so one background proves nothing

This is the thing to internalise before touching the sidebar's material (TRA-369).

`NSVisualEffectView` blends **the desktop picture** behind the window. So the sidebar's
tone is not a property of our CSS; it is a function of our CSS *and the user's
wallpaper*. Two screenshots of the same build in the same appearance can look completely
different, and both are real.

It is specifically the *wallpaper*, not "whatever is behind the window" (TRA-404). With
an opaque white window filling the area directly behind it — verified in the same
capture, the margin around the material window reads `#ffffff` — the sidebar does not
move by a single level from its black-desktop value. Backing the window with another
window is therefore not a way to test this without touching someone's desktop, and it is
not a cell of the matrix either.

Two rules follow, and neither is optional:

1. **Never validate the material against a single background.** The matrix is: light
   appearance × {black, deep blue, mid-grey, white wallpaper} × {window active, window
   inactive}, then the same set in dark. And it has to be shot in the **Electron
   window** — there is no `NSVisualEffectView` on the Vite dev server, so none of this is
   visible in a browser. `screencapture -R <window rect>` is the capture: a CDP
   screenshot only has the web contents and never the material, and `screencapture
   -l<windowid>` hangs on this window.
2. **The drift is bounded in BOTH appearances, and the bound is a relationship to the
   content pane — not an absolute colour.** The pull goes light over a light desktop and
   dark over a dark one, and either direction ends at mid-grey. Measured on the shipped
   build, dark appearance, sidebar swatch against a `#141414` well: `#222222` over a
   black desktop, `#4f4f4f` over a white one — 45 levels of swing from nothing but the
   user's wallpaper. Light had the same problem mirrored. A one-sided floor fixes one
   half and leaves the other exactly as wrong; that mistake has been made here once
   already.

   The rule: **the sidebar sits just above the content pane's `--surface-sunken` well in
   lightness, by a bounded amount, in both appearances.** `--sidebar-scrim` is what
   enforces it, and every value of it is `--surface` at some alpha — never `transparent`
   (unbounded) and never a colour of its own (a bound that stops tracking the surface it
   is meant to stay near).

   - **Light: flat `--surface`, alpha 1.** No drift term at all. This is the measured
     target, not a retreat from glass: the render Nikolai approved samples `#ffffff` —
     our own `--surface`, uniform top to bottom — against a `#f5f5f7` well, and the one
     he rejected samples `#e4e3e4`. Holding a white floor with a translucent layer lands
     on the same pixel with more machinery and a residual drift to bound anyway, and
     glass in light has the least to give: over a light desktop it is invisible, over a
     dark one it is the defect.
   - **Dark: `--surface` at `.78`.** The glass survives where it has somewhere to go —
     `.22` of the material still comes through, enough to see the desktop in the sidebar
     and not enough to drag it to mid-grey. Shot across the full matrix (TRA-404):
     `#1e1e1e` over black to `#2b2b2b` over white, `+10` to `+23` above the `#141414`
     well — 45 levels of swing compressed to 13, and light held `#ffffff` in all eight
     cells.

   The number to report for any change here is the **delta between the sidebar's rendered
   pixels and the well's**, per cell of the matrix above, plus the spread across cells.
   The spread is the bound; a single cell says nothing about it.

Under `prefers-reduced-transparency: reduce` the sidebar paints `--surface` itself
rather than letting macOS make the effect view opaque: the system's opaque fill follows
the *system* appearance, so left alone it disagrees with our content pane whenever the
app's Appearance choice and the system's differ (`sidebar.css`, accessibility section —
that rule has to out-specify the `[data-platform="mac"]` one above it).

### The native layer has to be told the app's appearance

The Appearance control writes `[data-theme]` on `<html>`. CSS reads that;
`NSVisualEffectView` cannot, and neither can the window's `backgroundColor` — both read
`nativeTheme`. So the renderer mirrors the choice to the main process
(`set-appearance` IPC → `packages/app/src/main/appearance.ts`), which sets
`nativeTheme.themeSource`. Without it, Light on a dark system draws a dark vibrancy
sidebar next to a light content pane.

The choice lives in the renderer's `localStorage`, which main cannot read, so it is also
mirrored to a one-line file in `userData` and restored **before the first window** —
`backgroundColor` is read from `nativeTheme` at construction and cannot be fixed
afterwards.

macOS only. On Windows `nativeTheme.shouldUseDarkColors` also picks the tray icon, which
has to match the taskbar — the system — not the app's own choice, and once `themeSource`
overrides it there is no way to read the system value back.

---

## 2. Tokens

`packages/app/src/renderer/styles/tokens.css` is the single source of truth for colour,
type, geometry and motion. Every component reads from it.

**A raw hex, a `text-gray-*` class, or an off-grid size anywhere under
`packages/app/src/renderer/**` is a build failure.** See §9.

The palette is defined for light and dark. Dark is duplicated across three selectors
(`@media (prefers-color-scheme: dark)`, `:root[data-theme="dark"]`,
`.ws-stage[data-mode="dark"]`) on purpose — a media query cannot be merged into a
selector list, and a stage has to be able to disagree with the root appearance.

### Text

| Token | Use it for | Never use it for |
|---|---|---|
| `--label` | body text, headings, control labels — the default | — |
| `--label-secondary` | secondary text that a user still **reads**: captions, counts, footnotes, group headers, timestamps | — |
| `--label-tertiary` | **decoration only** — disabled glyphs, separators, chart gridlines, placeholder text | any text a user is meant to read |

`--label-tertiary` measures **1.88:1** in light and **2.53:1** in dark on `--surface`.
It is not a text colour. This was the most-repeated bug in the app before the revision
and it is the rule most worth memorising.

`--label-secondary` is `.55` alpha, **not Apple's `.50`** — at `.50` it measures 3.98:1
and fails AA for the body text it actually carries.

### Accent and fills

| Token | Use it for |
|---|---|
| `--accent` | accent-coloured **text** and hairlines |
| `--accent-fill` | the **background** of a filled accent control |
| `--on-accent` | the label on top of `--accent-fill` |
| `--danger-fill` | the background of a destructive filled control |
| `--status-red` | destructive/error **text** |

The split between `--accent` and `--accent-fill` exists because the two directions have
different constraints. In dark, `--accent` has to stay light enough to read *as text*
on `--surface`, which leaves white on it at 3.65:1 — so filled controls use the darker
`--accent-fill` instead. Same story one hue over for `--status-red` / `--danger-fill`.
**Do not use `--accent` as a background, and do not use `--accent-fill` as a text
colour.**

Light accent is `#0069d9`, not Apple's `#007aff`: system blue measures 4.02:1 on
`--surface` and fails AA both as accent text and under a white label.

### Surfaces and fills

- `--surface` — content: cards, tables, the island, the opaque sidebar off-macOS.
- `--surface-sunken` — the frame the content sits on (content pane background).
- `--surface-raised` — floating overlays: menus, popovers.
- `--fill-quaternary` / `--fill-tertiary` / `--fill-secondary` / `--fill-pressed` —
  the interaction fill ramp: hover → selected/recessed track → stronger → pressed.
- `--separator` — every hairline, at `0.5px`.

### Status and badges

`--status-green|orange|red|blue|purple` are tuned to read **as text** on both surfaces
— on `--surface` and `--surface-sunken`, and **nowhere else**. A status token on a tint
of its own hue is a different, unmeasured pair: `--status-red` on a 10% red fill measured
**4.31:1** in light and failed AA. Put status text on a plain surface with a glyph, or
use the `--badge-*-fg` pair, which is the one tinted combination that was verified.
The `--badge-*-fg` tokens are separate: each is that hue walked toward black (light) or
white (dark) until the label clears 4.5:1 over the **18% tint of that same hue**, which
is what `.lx-badge` paints. Badge foreground and status text are not interchangeable.

**Status is never carried by colour alone.** A tone always arrives with a glyph and a
written label (`KpiTile.tsx`, the workspace KPI strip).

### Measured contrast

Run `node packages/app/scripts/design-tokens.mjs` for the current table. As of this
writing every required pair clears AA with margin — the tightest are `--accent` and
`--status-blue` in dark at **4.57:1**, `--label-secondary` in light at **4.76:1** on
`--surface` and **4.66:1** on `--surface-sunken`, and `--on-accent` on `--accent-fill`
at **4.77:1** in dark.

---

## 3. Type

Eight sizes. That is the whole scale. There is nothing at 9, 12.5, 13.5, 14, 16 or 18px.

| Token | Size / leading | For |
|---|---|---|
| `--text-large-title` | 26 / 32 | the one hero line on an empty pane |
| `--text-title-1` | 22 / 26 | page title |
| `--text-title-2` | 17 / 22 | empty-state title, section hero |
| `--text-title-3` | 15 / 20 | subsection heading |
| `--text-body` | 13 / 16 | **the default** — rows, labels, controls, table body |
| `--text-callout` | 12 / 15 | dense secondary text |
| `--text-caption` | 11 / 13 | captions, table headers, badges, counts |
| `--text-caption-2` | 10 / 13 | group headers only |

Weights: `400` regular, `500` medium, `600` semibold. (`590` appears in a few controls
as the macOS "emphasised" weight for a selected segment or a prominent button label.)

Use the utility classes — `.t-body`, `.t-caption`, `.t-title-2`, … — instead of a
one-off `font-size`. They set family, size, leading and tracking together.

**The rules that killed the old drift:**

1. **Nothing below 11px carries reading text.** 10px exists for group headers and
   nothing else. Project Overview had 61 of 100 text nodes at 9–10px before the
   rewrite; that is the failure this rule prevents.
2. **At most three sizes on a screen**, four if it has both a hero and a dense table.
   The same surface had seven.
3. **No ALL CAPS outside a 10px group header.** Badges, chips and column headers are
   sentence case (`.lx-badge` carries an explicit `ponytail:` comment saying so).
4. Numbers that a user compares get `font-variant-numeric: tabular-nums`.

---

## 4. Geometry

### The 4pt grid

Spacing tokens are `--space-2/4/6/8/12/16/20/24/32/40/48`. Nothing at 13, 17 or 25.

This binds the primitives too, not just the surfaces: control padding and gaps are on
the same scale (a 5px gap, a 9px inset, a Tailwind `2.5` half-step are all defects).
The check is a scan of every rendered element's computed padding / gap / margin on the
running renderer, not a read of the stylesheet.

### Control heights: 20 / 24 / 28. Nothing else.

`packages/app/src/renderer/styles/controls.css` declares one geometry for every control
in the app.

| Size | Height | Use |
|---|---|---|
| `small` | 20px | dense toolbars, inline controls |
| `regular` | 24px | **the default** |
| `large` | 28px | the single prominent action on a surface |

### Hit targets: ≥ 24×24, always

Every focusable element gets a 24×24 hit box even when the painted control is smaller.
The two techniques in use, both worth copying:

- **Checkbox**: 16px painted visual inside a 24×24 box, grown by a `4px solid
  transparent` border with `background-clip: padding-box`. Radius `9px` = 5px inner + 4px
  border, so it stays concentric.
- **20px tier**: an overflowing `::after` (`inset: -2px`) grows the clickable box
  without moving a single painted pixel. Small buttons get all four sides; segmented
  items get vertical only, because they already clear 24px wide and the 2px inter-segment
  gap is not wide enough to share.

### Radii — concentric, from the scale

| Token | Value | For |
|---|---|---|
| `--radius-window` / `--radius-panel` / `--radius-card` | 12px | window, panels, cards, islands |
| `--radius-popover` | 10px | menus, popovers |
| `--radius-input` | 8px | text inputs, tabs |
| `--radius-row` | 6px | rows, selection pills, square icon buttons |
| `--radius-capsule` | 999px | every pill-shaped control |

Controls are **capsules**, not rounded rectangles. There are exactly two exceptions,
both in the scale and both asserted by `primitives.test.tsx`: the icon-only button
(24×24 at `--radius-row` 6px with a 16px glyph) and the text field (`--radius-input`
8px — a capsule field sets its first character on a curve). There are no 4/5/9px
control radii.

When one rounded box sits inside another, the inner radius is the outer minus the
inset, so the curves stay concentric. The sidebar's 8px bottom footer inset reads as
concentric with the 12px window corner.

### Motion

`--dur-micro` 120ms (hover, fill changes) · `--dur-standard` 200ms · `--dur-large` 320ms.
Easing: `--ease-out`, `--ease-spring`. Never animate a layout property — the old search
field animated `left` over 0.42s and it is gone.

---

## 5. Components

Import from `packages/app/src/renderer/lattice/ui`. **Do not hand-roll a control that
already exists here** — that is how the app ended up with four different pill rows.

| Primitive | Variants / notes |
|---|---|
| `Button` | sizes `small`/`regular`/`large`; variants `prominent` / `bordered` / `plain` / `icon`. Icon-only requires **both** `aria-label` and `title` at the type level. |
| `SegmentedControl` | a real recessed track (`--fill-tertiary`, 2px inset) with a capsule thumb on `--surface` + hairline. The thumb carries selection, **not** an accent fill and **not** the label colour. |
| `SearchField` | capsule, 24px, leading magnifier, `Esc` clears. Placeholder starts and stays at the leading edge. |
| `Chip` / `ChipGroup` | 24px. Multi-select "on" is a neutral filled state; accent fill is reserved for single-select, where exactly one chip is on. Groups carry a visible label. |
| `Checkbox` | 16px visual in a 24×24 box. The CSS applies to every `input[type=checkbox]` in the renderer. |
| `PopUpButton` | 24px bordered capsule. The native `<select>` menu is kept — that *is* the platform menu; only the chrome is ours. |
| `.lx-input` | Text field. 24px, `--radius-input` (8px), hairline, house focus ring. Add `.mono` for a value that is an identifier or a path: `--font-mono` at 11px, because SF Mono runs optically larger than SF Pro at the same size. A raw `font-family: monospace` resolves to Courier and is a bug. |
| `Badge` / `GradeBadge` | capsule, 11px/500, sentence case, tinted fill with the saturated hue as the label. 18px tall so it fits inside a 24px row. Never white-on-a-light-fill. |
| `StatusDot` | tone dot. Pairs with a written label — never the only signal. |
| `IslandHeader` / `MiniButton` | the canonical 38px island header row. |
| `EmptyState` | full and `compact`. |
| `Menu` / `MenuItem` / `MenuSection` / `MenuSeparator` / `ConfirmPopover` / `useMenuAnchor` | one anchor implementation shared by every surface. |

### An icon names the action

A glyph is a **name**, not decoration. A glyph that decorates rather than names —
sparkles, and anything else that says "exciting" instead of saying what the item does
— does not go into the interface. When an item leads somewhere specific, the glyph
matches the destination: a question mark for help, a document for a changelog.

Two glyphs are **rejected by name**, and a test enforces it
(`lattice/__tests__/icons.test.ts` scans the whole renderer, not just the icon map,
because re-adding a banned body under a new key is the same regression wearing a hat):

| Rejected | Why | Use instead |
|---|---|---|
| `auto_awesome` (sparkles) | Decorates rather than names. It is the AI-marketing glyph; on a developer tool it reads as ornament and says nothing about what the item does. | The glyph for the destination — `scroll` for `View changelog`. |
| `forum` (speech bubbles) | Promises a conversation with a person. Nothing in this app is one: `Get help` opens GitHub issues, `Ask` queries the indexed graph. | `help` (question mark in a circle) for help; `search` for Ask. |

Judge the replacement at the size it renders, not on the 24-grid. `manage_search`
was the first pick for Ask and lost on the render: its two answer lines are 3 units
apart, which is 2.2px at the 18px sidebar size, and they smudge into the magnifier's
handle. A glyph that only reads at 24px is not a glyph this app has a use for.

**When a reference is supplied, match it.** If it looks wrong for us, say so in the PR
and argue it. A substitution nobody mentions costs a review round every time, and it
is how this pair shipped in the first place.

That happened twice on the same item. Sparkles were replaced with `description`, a
plain page — the *category* the reference belonged to, not the glyph in it. The
reference was a rolled sheet, which is now `scroll`, and a changelog is a running
record you scroll through rather than a document you open. **Matching a reference
means the glyph in it**, not the nearest thing already in the set: if the set has no
match, draw one and say in the PR that you did.

### Prominent buttons are flat

macOS 26 dropped the gradient and the bezel. `.lx-btn.v-prominent` is a flat
`--accent-fill` capsule. If you find a triple `box-shadow` bezel, delete it.

### `.lx-btn.is-status:disabled`

A disabled button whose **label is the status readout** ("Indexing…", "Daemon
unreachable") is not an inert control. Dimming it to `opacity: 0.4` put the only
progress text on Project Overview at 2.3:1. `is-status` keeps it unpressable and keeps
the sentence readable (4.76:1 on surface). Use it whenever the label is information.

### The row system — `.ws-sb-row`

A **row** is the sidebar's unit of content: 28px tall, 6px radius, inset 6px from the
sidebar edges, `8px` internal padding, 8px gap, a 16px icon slot, a 13px label that
truncates, and an optional trailing count in tabular figures. Label text starts at
x=38 in every row.

**Anything that lives in the sidebar is a row.** Nav items are rows. Settings is a row.
The idle update banner is a row. The footer was the last strip running its own
geometry, and putting it on the row system is what made the sidebar read as one thing.

**The sidebar carries navigation, not preferences.** The footer is *one* row —
Settings. Appearance briefly lived there as a second row and cost 28px at the bottom of
every window; it belongs in the Settings screen, which is where macOS puts it.

Selection follows the macOS active/inactive pair: `--fill-tertiary` when the sidebar
does not own focus, `--accent-fill` + `--on-accent` when it does
(`.ws-sidebar:focus-within`).

**A row holding a menu open shows its open state, and nothing else.** The trigger
keeps DOM focus while its menu is up, so the house `*:focus-visible` ring — a 3px
accent halo over a **1px inset accent border** — sat on the row for as long as the
menu stayed open whenever it had been opened from the keyboard. On a full-width row
that inset border is a rectangle, and a blue rectangle around a row reads as a
focused text field, not as a trigger holding its state. `--fill-tertiary` is the
whole indicator; the open menu is the rest of it
(`.ws-sb-row[aria-expanded='true']:focus-visible { box-shadow: none }`). The ring
stays for the case it is actually for: the row focused with the menu closed.

### States are part of the component, not an afterthought

Every data surface owes four states, and each has a house form:

- **Loading** — skeleton blocks *at the final geometry*, so nothing shifts when data
  lands. Never a centred spinner, never the word "Loading…". (`.ws-skel`,
  `.ws-sb-skeleton`, `workspace/components/Skeleton.tsx`.)
- **Empty** — real anatomy: glyph → title line → one sentence → one action. 32px glyph
  / 17px-600 / 13px for a pane; `EmptyState compact` for a section inside a card (120px
  tall, 20px glyph, 13px title). An empty section is not a hero.
- **Error** — the chrome stays put; the sentence and its Retry action sit together.
  Each section tracks its own load state. A failed fetch must not pulse a skeleton
  forever promising data that is never coming — settle on an em dash and
  "Couldn't be measured".
- **Unknown ≠ empty ≠ zero.** "The daemon has not answered yet" and "this project was
  never indexed" are different sentences. "0 of 0 dependencies covered" is an empty
  state, not a full green meter.

### One condition gets one sentence, and stale beats empty

Two rules for a surface whose data source can be slow, and both were broken at once in
TRA-397 — a busy daemon produced three different banners in sequence and then replaced
every number with an em dash.

**A timeout threshold is not a diagnosis.** "The request is taking a while", "the feed
dropped" and "the request failed" are one condition — the service is busy — seen at three
moments. Reduce them to one state with one line before they reach the screen, and hold it
steady: degradation waits out a grace period (`DEGRADED_GRACE_MS`) so a feed that blinks
does not blink a banner with it, while recovery publishes immediately. Escalating copy
makes a working app look broken. Keep apart only what the user would act on differently —
"busy" and "not running" are two states because one is a wait and the other is a button.

**Values that were true a minute ago outrank no values at all.** A refresh that fails must
leave the last good ones on screen, cache them across launches, and say once — above them,
where they are read before the numbers are — that they are the last indexed ones. Em dashes
and "Couldn't be measured" are for a number nobody has ever had, not for one that is a few
minutes old. The corollary: that line has to match the screen. Saying "these are the last
indexed numbers" over a row of em dashes is the same lie in the other direction.

---

## 6. Layout skeleton

```
┌─ window: hiddenInset, 12px radius, min 640×420 ───────────────────┐
│ ┌ sidebar (transparent → vibrancy) ┬ content pane (opaque) ─────┐ │
│ │ --top-band-h strip [drag]:       │ --top-band-h band [drag]:  │ │
│ │   lights, then sidebar toggle    │   the surface's toolbar    │ │
│ ├──────────────────────────────────┼────────────────────────────┤ │
│ │ scroll: 6px inset, 28px rows     │ content, opaque, ≤720px    │ │
│ │                                  │                            │ │
│ ├──────────────────────────────────┤                            │ │
│ │ footer: hairline, 6/6/8 inset    │                            │ │
│ └──────────────────────────────────┴────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

- **Sidebar** — 220px default, 180–320px drag range, flush to the window edge: no
  radius, no shadow. The hairline separator and the material *are* the edge. Width and
  collapsed state persist and sync across windows (`renderer/sidebar-prefs.ts`).
- **The traffic-light centre line is the app's top-band baseline.** Every control in a
  top band — the sidebar toggle, the window's own controls, search, segmented controls,
  primary actions — is centred on it. The band height and `trafficLightPosition` are two
  views of ONE number and must be derived from a single source, never written twice.
  That source is `packages/app/src/shared/chrome-metrics.ts`: `TOP_BAND_H` sizes every
  band via `--top-band-h`, and `TRAFFIC_LIGHT_Y` is computed from it. See
  "The top band" below.
- **Traffic lights are native.** When the sidebar is collapsed the content header takes a
  `78px` left pad so the lights land on it instead. **Never draw traffic lights in CSS** —
  the hand-drawn `.ws-lights` circles are gone and must not come back.
- **Whether to reserve that strip is the main process's answer, not the user agent's.**
  Preload exposes `window.electronChrome.insetTitleBar`; the renderer keys the strip and
  `[data-platform]` off it. `navigator.userAgent` says "Mac" in a browser on macOS too,
  so the old gate drew a 44px reservation in `vite dev` for lights that were not there —
  which is why a screenshot from `localhost:5173` is not evidence about this app's
  layout (§9).
- **Drag regions**: exactly two — the sidebar's top band (lights + toggle) and the
  content pane's band. `<main>` is not a drag region. Every interactive child inside a drag region
  needs `-webkit-app-region: no-drag`.
- **The sidebar toggle lives over the sidebar, past the traffic lights** — a 78px left
  pad on `.ws-sidebar-titlebar` clears the three 12px lights (x=14 to ~x=66). That is
  where Finder and Mail put it, and it hands the content band's full width to the
  surface: carrying the toggle there cost 46px of row and wrapped Memory's toolbar onto
  a second line at the default 960px window. It falls back into the band when the
  sidebar is collapsed, or when the window has no inset title bar to draw a strip for.
- **One top band, and it is never empty.** The 44px row across the top of the content
  pane is the window's only piece of top chrome, and the surface on screen renders its
  control row *into* it — `<Toolbar>` (`lattice/ui`)
  portals into `.ws-content-head-slot` whenever the app shell is around it, and draws
  its own 52px glass row only when standing alone (a unit test, a Storybook-style
  harness). **A surface never stacks a control row underneath the band.** Two bands
  where one would do is the defect this rule exists for: on Graph the strip held
  nothing but the toggle while Files / Symbols / Filter / Search / Fit / Live floated
  as a pill ~74px below it, and on Insights and Notebook the surface's own 52px
  toolbar started at y=60 under 44px of nothing.
- **When the surface has nothing to put up there, the band is simply empty and content
  starts immediately below it** — at y=44, the same line the sidebar's first row starts
  on. No unexplained gap between the two columns. Measured after TRA-354: every surface
  reports its control row at y=0 inside a 44px band, against a sidebar first row at
  y=44.
- **Toolbar contents** — **one prominent action per region.** Secondary actions go into
  a labelled pop-up or an overflow menu; thirteen controls in one wrapping row is the
  thing this replaced. The surface title in the band is 15/20/600 — a window title, not
  a page heading; 22px Title 1 belongs on content, not on chrome.
- **A scroll-edge hairline** fades in under the band as content scrolls, never a
  permanent border.
- **Content measure** — capped and centred (720px on Project Overview). Long text and
  grouped lists do not run to a 1640px window edge.
- **A surface that draws its own toolbar owns the whole pane.** Do not wrap it in a
  16px inset — that turns a flush toolbar into a floating band with the sunken
  background showing down both sides.
- **Scroll edges get a hairline.** A pinned footer or a sticky header that content
  slides under is a scroll edge; a sticky header must have an **opaque** backing, or
  rows show through the column labels.
- **The sidebar footer is ONE row, and it opens the app menu.** It is not where
  global actions accumulate — that is what it kept becoming, a row per action plus a
  permanent update strip, 70.5px of chrome under a column meant for navigation
  (TRA-305 → TRA-306 → TRA-363). The row is the product: its name, a chevron, and a
  pop-up. See "Where a global action lives" below.

### The top band

`--top-band-h` (44px) is the height of every top band, and `TOP_BAND_H` in
`packages/app/src/shared/chrome-metrics.ts` is where that number lives. The main process
derives `trafficLightPosition` from it; `tokens.css` declares `--top-band-h` from it;
`.ws-sidebar-titlebar` and `.ws-content-head` read the token. Nothing writes a band
height by hand.

Why this is a rule and not a preference: it was written twice, and the two copies
disagreed. `height: 44px` centres a control at 22; `trafficLightPosition.y = 18` put the
lights' centre at 25 — and the comment above it asserted they were centred. Three pixels
of misalignment on the most-looked-at row in the app, shipped, with a comment vouching
for it (TRA-370).

Two things to know before touching the offset:

- **`trafficLightPosition.y` is not the circle's top edge.** The button's frame carries a
  point above it, so the light renders one point lower than the offset asks for. The
  centring offset is `(TOP_BAND_H − 12) / 2 − 1`, not `(TOP_BAND_H − 12) / 2`. Measured on
  macOS 26 / Electron 41 by screen-capturing the real window and reading the red light's
  row profile: y=18 → centre 25.0, y=15 → centre 22.0.
- **Verify it by measuring, not by looking.** There are no traffic lights on the Vite dev
  server, so a browser cannot show this at all. Launch the Electron window
  (`node packages/app/scripts/electron-cdp.mjs launch`), capture the screen, and compare
  the light's pixel centre against the toggle's `getBoundingClientRect()` centre. Both
  appearances, sidebar expanded and collapsed.

`packages/app/src/main/__tests__/chrome-metrics.test.ts` and the top-band block in
`src/renderer/styles/__tests__/tokens.test.ts` fail if the constant, the token, the
stylesheets and `tray.ts` ever drift apart again.

### The second top band: the native tab bar is macOS's, not ours

Opening a project opens a native macOS **tab**, so the normal state of this app is a
tabbed window — not an edge case. AppKit then draws a tab bar, and because the window is
`titleBarStyle: 'hiddenInset'` (full-size content view) it draws it **over** the web
contents: `innerHeight` stays equal to `outerHeight`, nothing reflows, and the tab bar
simply covers the top 36px of whatever the renderer painted. That is the whole of the
band above, so the surface toolbar and the sidebar toggle went from "misaligned" to
"gone" (TRA-399).

The rule that follows: **a band we do not draw still has to be reserved.** The tab bar is
AppKit's, we cannot restyle it and we cannot ask whether it is up — so:

- `MAC_TAB_BAR_H` (36px, measured, `chrome-metrics.ts`) and `--mac-tabbar-h` are one
  number, exactly like `TOP_BAND_H`. The stage reserves it with `padding-top` while
  `data-tabbar="on"`, and the app's own band starts below it. Never draw into it.
- **The traffic lights belong to whichever band holds the top line**, not to a constant.
  With no tab bar that is our 44px band (centre 22); with one it is AppKit's 36px tab bar
  (centre 18). `trafficLightYFor(tabBarVisible)` is the only place that chooses.
- **`trafficLightPosition` is applied once, at window creation, and AppKit re-lays the
  title bar out under it.** So every event that can change the tab count re-applies it —
  `show`, `focus`, `closed`, `did-finish-load` — synchronously and again a frame later,
  because the tab bar comes and goes asynchronously. Without that, closing back to one tab
  left the lights 6px high until a window resize forced a layout pass, which is the "nudge
  the window and it fixes itself" users report.
- The 78px that clears the lights in `.ws-sidebar-titlebar` goes away with them: while the
  tab bar holds the lights, reserving their width leaves the toggle floating in a gap.

`src/main/__tests__/tab-chrome.test.ts` drives the real window events and fails if any of
those stops firing.

### Where a global action lives

An action that belongs to the app rather than to the surface in front of you —
Settings, Check for updates, View changelog, Get help — has exactly two homes, and
**one definition**: `packages/app/src/shared/global-actions.ts`.

- The **native application menu** (`main/menu.ts`) builds its items from that list.
  On macOS the menu bar is these actions' native home and the place a Mac user
  looks first.
- The **app menu** in the sidebar footer renders the same list. Off macOS there is
  no menu bar in the window, and on macOS it is still the discoverable path for
  someone who has never opened the menu bar.

Neither surface types a label or a key of its own: they read `label`, `accelerator`
/ `shortcut` and `url` from the shared entry. Adding a global action means adding
one object there — it appears in both places, named the same, on the same key.

Two things deliberately stay out of that list. **Appearance** is a preference with
three states, not a command, and lives in the app menu and in Settings only — a
list with one member cannot drift. **Documentation** is native-menu-only for the
same reason.

The footer never grows a second row for any of this. If a new global action needs a
home, it is a menu item.

**Grouping in the app menu is by what an item does, not by what is left over.**
Settings alone, then the choices, then the actions — and inside the actions,
everything that *leaves for a browser* is one group and everything that *acts on
this app* is another. `Check for updates…` sat flush under `Get help` and read as a
third GitHub page. `AppMenu` splits on `url`, which every entry already declares, so
a new action lands in the right group without that file learning its name.

### A choice in a menu is one row, not a group of items

A menu item is a **destination or a command**: you pick it, something happens, the
menu closes. A **choice** is not that — it is a setting with two or three values
that you may want to try, and it does not belong in the same shape.

Appearance shipped as the wrong shape first: an `APPEARANCE` caps header plus three
checked items, four rows for one three-state preference, in a menu whose whole
premise was that the sidebar footer should stop spending a row per thing. A caps
header over a single control is weight without information.

**The rule.** A choice inside a menu is one row: its name on the left, the control
inline on the right, on the same centre line as every item above and below it
(`MenuChoiceRow` in `lattice/ui/Menu.tsx`, `.ws-ctx-row` in `styles/island.css`).
Two to four short values → a segmented pill. More than four, or values that need
words → a pop-up button on the same row shape. Never a section header plus one
item per value.

What the row has to get right, all of it enforced by
`components/__tests__/AppMenu.test.tsx`:

- **Geometry.** Same 30px box and 8px inset as `.ws-ctx-item`, so the label, the
  control and the neighbouring items share one centre line and the control's right
  edge lands in the same column as an item's shortcut. Measured: 214.5px for both.
- **Roles.** `role="group"` + `aria-label` on the row, `role="menuitemradio"` +
  `aria-checked` on each value. Not `radiogroup` / `radio` — a `radiogroup` is not
  a legal child of `role="menu"`, and `aria-pressed` (what the shared
  `SegmentedControl` uses) says "toggled", not "chosen".
- **Two axes on the keyboard.** Up/Down keep moving between menu *rows*: the row is
  a single stop, marked `data-menu-row`, and the stop resolves to whichever segment
  is checked right now. Left/Right move *within* the control and change the value.
  Roving `tabIndex` puts the one Tab stop on the current value.
- **Icon-only segments carry their name in `aria-label` and in `title`.** The
  visible glyph is not a label; screen readers and hover both need the word.
- **Selection needs a second cue when the segments are icons.** The thumb alone is
  1.19:1 (light) / 1.63:1 (dark) against the track — fine for word segments, which
  stay readable regardless, but an icon has nothing else to fall back on, so an
  unselected icon drops to `--label-secondary`.
- **Picking a value does not close the menu.** The point of an inline switcher is
  watching the app change under it. A command still closes; a choice does not.
- **The pill's proportions come from the reference, not from the nearest size
  token.** Icon-only segments shipped on `sz-small`: a 20px track, 16px segments and
  a 14px glyph, which left **1px** of air above and below the icon — while
  `.lx-seg.sz-small`'s `padding: 0 8px` won the cascade and ran the segments 30px
  wide. Squeezed on one axis, loose on the other. The shape to hold is *air inside
  the segment, little outside the pill*: the default 24px track, 24×20 segments, a
  12px glyph — 6px beside the icon, 4px above it, and 3px between pill and row.
  A segment never goes under the 24px hit-target floor to look squarer.

### Every string comes from the catalogue, and the length is not yours to assume

The app ships in more than one language (TRA-379), so a literal typed into a
component is a string that exists in English and nowhere else. User-facing text —
labels, titles, `placeholder`, `aria-label`, empty states, errors — is authored in
`packages/app/src/shared/i18n/catalog/en/<surface>.ts` and read with `t()`.
`packages/app/scripts/check-i18n.mjs` fails the build when one reappears inline in a
surface that was already extracted; how to add a string or a language is in
`docs/development.md`.

Three consequences for layout, all of them the usual way a translated UI breaks:

- **Assume +30% width.** German and Russian run long against English. A control sized
  to its English label — a segmented pill, a button with the label baked into a fixed
  width — has to survive the longest translation or wrap, not clip. This is the
  argument for icon-only segments where the values allow it.
- **Never build a sentence out of pieces.** `{count} + " items"` has no correct
  Russian form; `t('items', { count })` does, because i18next resolves the plural
  through `Intl.PluralRules`. Same for anything glued from a noun and a verb.
- **Dates, numbers and "2h ago" go through `renderer/i18n/format.ts`.** It wraps
  `Intl`, which knows that a Russian relative time is "2 часа назад" but "5 часов
  назад" and that a German date is `29.8.2026`. Note that `Intl`'s `narrow` style is
  not offered: it gives English "2h ago" and Russian "-2 ч".

**The Language control** follows "a choice in a menu is one row" above, and the option
count decides the shape: a segmented pill while there are two to four languages, a
pop-up button on the same row shape once there are more — language names are words,
not glyphs, and the list is only going to grow. Language names are written in their
own language ("Русский", not "Russian"): someone hunting for their language is
looking for what they call it.

### The window minimum is a size that has to work

`main/tray.ts` sets `minWidth: 640, minHeight: 420`. Every surface must be usable
there, not merely render there. Two rules fall out, and the Workspace breaks both if
you undo them:

- **Chrome above content, always.** The toolbar is the top of the pane. Content —
  including a KPI strip — goes *below* it. With the strip first, six 99px tiles
  wrapped to 357px and pushed the toolbar's bottom edge 33px past a 420px window;
  since nothing on this surface scrolls, search, Filter, + Add and the whole project
  list became unreachable rather than merely off-screen.
- **A toolbar wraps; it never clips.** `<Toolbar>` is `flex-wrap` with `min-height:
  52px`, never `height`, and the band it renders into is `min-height: 44px` — a wrapped
  second line grows both instead of spilling. A fixed non-wrapping row inside
  `overflow-x: hidden` ran 51px past a 420px pane and put + Add's chevron and the
  overflow menu outside the window; measured again at 640×420 after TRA-354,
  non-wrapping rows put Graph's Fit / Live / ⋯ and the last segment of Insights' report
  picker out of reach the same way. This lives in the shared `Toolbar` primitive
  (`lattice/ui/Surface.tsx`), so every surface built on it inherits the behaviour — do
  not re-declare a height on top.
- **A control that cannot shrink needs a narrow form, not just a wrapping row.**
  `flex-wrap` gives an oversized control its own line; it cannot make that control
  narrower. A segmented control is sized by its labels and is one flex item, so
  once it is wider than the line it overflows no matter how the row wraps. Give it
  a pop-up button below the width where its segments fit — that is what macOS does,
  and `PopUpButton` already exists. Insights' report picker was 371px in a 262px
  band at the 640px window minimum with the sidebar at `SIDEBAR_MAX`: it ran 96.6px
  past the window and left "Risk hotspots" 14 of its 108px, so that report could not
  be selected at all.
- **Decide a collapse from a width the collapsing thing cannot change.** Measure the
  toolbar, not the control's own slot. The slot is narrower beside a title and
  full-width once the control wraps to a line of its own, so a slot-based threshold
  is bistable — "segments, wrapped" and "pop-up, inline" are both self-consistent at
  the same window size, and which one you get depends on which way the user last
  resized.
- **A control that can shrink declares a length `flex-basis`, not `auto`.** A wrapping
  flex line is laid out from each item's *hypothetical* size, so `flex-basis: auto`
  advertises a control's full content width and breaks the row before it has spent
  the slack it has. `.lx-search` is `flex: 1 1 140px` (its own `min-width`) capped at
  `max-width: max-content`: identical rendered width wherever there is room, 42px of
  give before the toolbar goes to two rows. With `auto` it wrapped Memory's toolbar
  at the *default* 960px window, not just at the minimum.

**Respond to the pane, not to the window.** The sidebar is resizable 180–320px and
collapsible, so window width says almost nothing about the room a surface has. Watch
the pane with one `ResizeObserver` and derive from it. `Workspace.tsx` is the pattern:
`TABLE_MIN_PANE_W` is *computed* from the table's own frozen columns plus a minimum
scroll window, and `isDensePane()` compares the pane's height against
`kpiStripHeight(paneW)` rather than against a guessed breakpoint — which is why it
reproduces the measured 357px exactly instead of drifting from it.

**What gives way, in order.** Never the identity of the screen; always the
elaboration.

1. **A comparison before a value.** A dense `KpiTile` drops the footnote/delta line
   and lays out label ↔ value on one 36px line. The number never goes; the sentence
   an em dash needs moves to the tile's `title`.
2. **A table before a list.** Below `TABLE_MIN_PANE_W` the Workspace renders
   `WorkspaceCompactView` instead of scrolling a 1025px table through a 15px slot.
   The stored preference is **not** rewritten — widening the window brings the user's
   own choice back.
3. **A toggle whose alternatives are unusable is hidden, not disabled.** A disabled
   segment is a control with nothing to choose; it returns with the width.

---

## 7. Accessibility

Not a pass at the end. These are floors.

- **Contrast**: 4.5:1 for anything a user reads, in **both** appearances, verified by
  `scripts/design-tokens.mjs` in CI. `--label-tertiary` is decoration only (§2).
- **Focus ring**: one ring, house-wide. `--focus-ring` on `:focus-visible` globally;
  primitives use `outline: 2px solid var(--accent); outline-offset: 2px`. Keyboard
  only — `*:focus { outline: none }`. Every focusable element must show it.
- **Hit targets**: ≥24×24 for anything focusable (§4).
- **Icon-only controls carry a label and a tooltip.** The `Button` type enforces both
  for the `icon` variant.
- **Never colour alone.** Tones arrive with a glyph and a word. `GradeBadge` spells the
  grade out for assistive tech.
- **`prefers-reduced-motion: reduce`** — global kill switch in `tokens.css` collapses
  all animation and transition to 0.01ms. Prefer `animation`/`transition` over
  JS-driven motion so it is covered for free.
- **`prefers-reduced-transparency: reduce`** — `.glass` becomes opaque `--surface`; the
  macOS sidebar re-paints opaque. macOS turns the `NSVisualEffectView` opaque itself, so
  the native path is covered without us.
- **`prefers-contrast: more`** — separators strengthen, `--label-secondary` goes to
  `.70`/`.75`, `--surface-sunken` goes to pure white/black, the focus ring thickens to
  4px, and selected rows gain an accent outline.
- **Keyboard**: a table is one tab stop with arrow-key navigation and Enter to open,
  not N tab stops. `⌘⌥S` toggles the sidebar; `⌘1…⌘9` select a section; the resize
  handle is tabbable with ←/→/Home/End.
- **Right-click parity**: a context menu offers the same actions as the visible row
  buttons.
- **No hover-only affordances.** Row actions must have a permanent, reachable form —
  an always-visible overflow button opening a `Menu`. A trailing affordance may be
  revealed on hover only if the same action exists elsewhere and it appears on
  `:focus-visible`.

---

## 8. The "never" list

1. Never a raw hex, `rgb()`, or a Tailwind grey (`text-gray-*`, `bg-slate-*`) in the
   renderer. Use a token. **CI fails on new ones.**
2. Never `--label-tertiary` for text a user reads.
3. Never `--accent` as a background, never `--accent-fill` as a text colour.
4. Never glass on content. Never glass on glass.
5. Never a shadow on a card. Hairline instead.
6. Never a control height outside 20/24/28.
7. Never a focusable box under 24×24.
8. Never a control radius outside the scale — capsule for pills, 6px for square icon
   buttons, 50% for dots.
9. Never text below 11px that a user reads. Never 10px outside a group header.
10. Never ALL CAPS outside a 10px group header.
11. Never more than one prominent action per region.
12. Never a centred spinner or the word "Loading…" where a skeleton belongs.
13. Never colour as the only carrier of status.
14. Never an icon-only control without an `aria-label` **and** a `title`.
15. Never an action that exists only on hover.
16. Never draw traffic lights, or any other piece of window chrome, in CSS.
17. Never animate a layout property (`left`, `top`, `width`, `height`). Transform and
    opacity only.
18. Never make `<main>` a drag region.
19. Never report "unknown" as "zero", or a lost connection as lost data.
20. Never hand-roll a control that exists in `lattice/ui`.

---

## 9. Enforcement

`packages/app/scripts/design-tokens.mjs`, asserted by vitest and run in CI:

- **`contrastTable()` / `contrastFailures()`** — WCAG contrast for every text token
  against `--surface` and `--surface-sunken` in both appearances, plus `--on-accent` on
  `--accent-fill`. Any pair under 4.5:1 fails the build.
- **`tokenGuard()`** — scans the renderer for raw hex, raw `rgb()`/`rgba()`, and Tailwind
  greys. It is **baselined** in `scripts/token-guard.baseline.json`: pre-existing
  violations are recorded per file and only an **increase** fails. Every surface migration
  lowers a number; nobody may raise one. If your change drops a file below its baseline,
  the script tells you to lower it — do.

  `rgb()` was added in TRA-355. §8 rule 1 had named it since the revision, but the guard
  only ever counted hex, so two thirds of the rule was enforced and one third was a
  comment. The Workspace toolbar shipped an `inset 1px 0 0 rgb(255 255 255 / 0.25)`
  divider with a green build, and the sidebar kept a `rgba(255, 255, 255, 0.85)` glyph
  colour on `--accent-fill` measuring 4.22:1 light / 3.89:1 dark. When you want "this
  token at some alpha", write `color-mix(in oklab, var(--token) N%, transparent)` — a
  numeric channel is how a value escapes the contrast table.

  **Correction to TRA-355's own commit message**, kept here because the overstatement is
  the more useful lesson: that change was described as fixing an AA failure "for the
  count, a number the user reads". It was not. `.ws-sb-count` is styled in `sidebar.css`
  and rendered by **no component in the app**, so the rule's only live target is
  `.ws-sb-ico` — a glyph, whose floor is 3:1, which the dimmed white already cleared. The
  edit was right (one token, consistent with the shortcut-hint decision, one fewer raw
  `rgb()`); the severity was wrong, because the contrast was computed from the selector
  and never checked against what the selector actually reaches. **Measure the element on
  screen, not the rule in the file.** See TRA-358 for whether sidebar counts get built or
  the dead CSS goes.

`lattice/ui/__tests__/primitives.test.tsx` asserts the height set, the ≥24px boxes, the
radius set, and ≥4.5:1 contrast for all seven badge tones in both appearances.

`styles/__tests__/tokens.test.ts` adds the **tertiary-as-text guard** (TRA-344): no rule
under `renderer/**` may declare `color: var(--label-tertiary)` *and* a `font-size`. Sizing
text is what distinguishes reading text from a glyph, so the pair is the machine-checkable
form of §2's "decoration only". `::placeholder` is the one exempt selector. This closes the
gap the contrast table cannot see — it measures the tokens, not which token a component
reaches for, so quick open sat at 1.88:1 for six weeks with a green build.

Run it locally:

```bash
node packages/app/scripts/design-tokens.mjs                    # contrast table + guard
node packages/app/scripts/design-tokens.mjs --update-baseline  # only ever to LOWER counts
```

The renderer also ships a gallery: `?view=gallery[&theme=dark]` renders every primitive
variant × size × state.

### Judge it in the Electron window. A browser screenshot is not evidence.

`vite dev` in Chrome is a different window from the one we ship: no `hiddenInset` frame,
no traffic lights, no `NSVisualEffectView` behind the sidebar. Until TRA-354 the renderer
even reserved the 44px traffic-light strip in the browser, because the gate read
`navigator.userAgent` — so the one thing under review, the top of the window, was the one
thing the browser got wrong. Screenshots from `localhost:5173` do not settle a layout,
spacing or material question.

```bash
node packages/app/scripts/electron-cdp.mjs launch     # build first: pnpm --filter … build
node packages/app/scripts/electron-cdp.mjs shot before/graph-light.png \
  --url='file://…/dist/renderer/index.html?view=project&root=…' --click=Graph --light
```

`launch` runs the app with `--remote-debugging-port=9222` under its own `--user-data-dir`
(so it does not lose Electron's single-instance lock to an installed trace-mcp.app) and
**never puts a window on screen**. The window is created, loads and paints; it is simply
never mapped, and the process runs as a macOS accessory app, so it takes no Dock tile, no
⌘-Tab entry and no activation. Everything here drives the app over CDP, which does not
care whether the window is visible — and the person at the keyboard does (TRA-403). Any
CDP client can attach to `http://127.0.0.1:9222` once it is up, including `chrome-devtools`
MCP via `--browser-url`.

`launch --visible` puts it on screen for the one case that needs eyes on the running app,
and then also sets `TRACE_MCP_DEV_ALWAYS_ON_TOP=1`: Chromium stops compositing a fully
*occluded* window, and a CDP screenshot of one hands back the frame it painted minutes ago
— a stale-pixel "after" shot that looks like a fix. An unmapped window is not an occluded
one; it keeps painting, and its screenshots are current (measured, not assumed).

The one thing a CDP capture cannot show is the native frame: the traffic lights are drawn
by macOS outside the web contents, so they are absent from the PNG even though the strip
they sit in is real. Measure the reservation, do not look for the lights. The second thing
it cannot show is the sidebar: it is transparent over a native `NSVisualEffectView`, which
a renderer-side capture reads as a hole. Shoot with `--reduce-transparency` when the
sidebar has to be legible — that is a real product state, and CSS paints it opaque.

Not to be confused with `scripts/capture-screenshots.mjs` (TRA-366), which regenerates the
fixed set of images `docs/` and trace-mcp.com ship, from a seeded sandbox, and can check
whether the committed ones are stale. Use that one for anything committed to the repo; use
`electron-cdp.mjs` when you need to point a debugger at the app you are running right now
and shoot a surface it has no manifest entry for.

### A review run never takes the screen from the person using the machine

Design work here runs on a Mac somebody is working on, and macOS follows an app activation
to the Space that app's window is on — so a harness that shows a window yanks them out of
their full-screen app, and hourly runs do it hourly (TRA-403). The rule for anything an
agent launches:

- **The app: never shown.** `electron-cdp.mjs launch` is hidden and accessory by default.
  A visible window needs `--visible` and a reason stated where you use it.
- **The browser: `--headless --isolated`.** Headless removes the window entirely and
  screenshots still come out; `--isolated` gives Chrome a throwaway profile so it can
  never adopt or disturb the one the user has open. Both belong in the MCP server's own
  arguments, not in a per-call flag somebody will forget.
- **Never call `app.focus()`, `win.focus()`, `win.show()`, `showInactive()` or
  `shell.openExternal` from a harness path.** `tests/scripts/capture-screenshots.test.ts`
  reads these files and fails when one appears: in `tray.ts` every show goes through
  `presentWindow`, which returns early under `TRACE_MCP_WINDOW_MODE=hidden` (or
  `TRACE_MCP_AGENT_RUN=1`, the same request from an agent launching the app some other
  way); in `electron-cdp.mjs` there are none at all.
- **The one exception is the publication capture**, which cannot avoid activating the app
  (a window whose app is not active draws grey traffic lights, and those are refused). It
  pays for the exception by waiting for an idle machine — see docs/development.md.

### A published screenshot shows the window, or it is not a screenshot of the app

Anything a reader sees as "trace-mcp" — README, trace-mcp.com, a release note, an issue
that claims a fix landed — must contain the window chrome: traffic lights, rounded corners,
the real sidebar material. A frame without them is a picture of a web page, and a reader
who has never opened the app cannot tell the difference between that and a browser demo.
Three separate rounds shipped one anyway (TRA-354, TRA-366, TRA-390), because the rule
lived only in prose, so `capture-screenshots.mjs` now photographs the window itself
(`screencapture -l<CGWindowID>`) and refuses to write a frame whose corners are opaque or
whose buttons are missing. Shoot published images with that script. `electron-cdp.mjs`
stays a review tool — its CDP shots are for measuring your own work in progress, never for
publication.

### Title a design PR `feat:` / `fix:` / `refactor:` — never `design:`

`design` is not a Conventional Commits type, and `.github/workflows/pr-title-lint.yml`
rejects it. That check is not pedantry: release-please classifies releases from the
squash-merge subject, which GitHub takes from the PR title, so an unclassifiable title
means the change ships and then sits unreleased (TRA-104). Pick by what the change
*does* — a new or rebuilt surface is `feat(app):`, a contrast or spacing correction is
`fix(app):`, a pure restructure is `refactor(app):`.

Two related things that cost a run to rediscover: `gh pr merge` refuses on this repo
because `master` requires signed commits and `gh` pre-checks the branch, while the REST
endpoint (`gh api -X PUT repos/…/pulls/N/merge -f merge_method=squash`) succeeds —
GitHub signs the squash commit itself. And `master` is `strict`, so rebase onto it
before expecting a merge to go through.

---

## 10. Review checklist for a new screen

Run this before opening the PR. Look at the **running renderer**, in both appearances —
code correctness and visual correctness are different claims.

- [ ] Every colour is a token; `design-tokens.mjs` is clean and no baseline count went up.
- [ ] Three sizes on the screen, four at the outside. Nothing under 11px carries reading text.
- [ ] Every control comes from `lattice/ui`. Heights are 20/24/28.
- [ ] Every focusable box measures ≥24×24 (check with `elementFromPoint` 1px inside each edge).
- [ ] Content is opaque. Glass is only on navigation, toolbars, and floating strips.
- [ ] One prominent action in the region. Everything else is bordered, plain, or in an overflow menu.
- [ ] All four states exist and were looked at: loading (skeletons at final geometry), empty (glyph/title/sentence/action), error (chrome intact, Retry adjacent), and populated.
- [ ] Unknown, empty, and zero read as three different things.
- [ ] Every icon-only control has `aria-label` + `title`. Every tone has a glyph and a word.
- [ ] Tab through it: visible focus ring everywhere, tables are one tab stop, no keyboard trap.
- [ ] No action reachable only on hover; right-click offers what the row buttons offer.
- [ ] The surface's control row is IN the top band, not stacked under it, and content starts on the sidebar's first-row line (§6).
- [ ] Screenshots in light **and** dark, plus Reduce Transparency and Increase Contrast wherever material is involved — **taken from the Electron window** (§9), never from `vite dev` in a browser.
- [ ] Resized to **640×420**, the window minimum: no control has a bounding box outside
      the viewport without a scrollable ancestor, and the surface's own content is
      reachable. Walk it — `getBoundingClientRect()` over every focusable, not a glance.

---

## 11. Decision log

One line each, with the reason. These are settled — do not re-litigate them without
new evidence.

| Decision | Why |
|---|---|
| Native `BrowserWindow` vibrancy, **not** `electron-liquid-glass` | Gets the real material, follows system appearance, desaturates off-key, and honours Reduce Transparency for free — no extra native dep, no no-op path below macOS 26. |
| `titleBarStyle: 'hiddenInset'` with native traffic lights | The platform draws them correctly at every size and appearance; the CSS circles never did. |
| Accent `#0069d9`, not Apple's `#007aff` (light) | System blue measures 4.02:1 on `--surface` and fails AA both as text and under a white label. |
| `--label-secondary` at `.55`, not Apple's `.50` | At `.50` it measures 3.98:1 and fails AA for the body text it carries. |
| `--accent` and `--accent-fill` split (same for `--status-red`/`--danger-fill`) | A hue readable *as text* on `--surface` and a hue readable *under a white label* are different colours in dark. |
| `--label-tertiary` is decoration-only, and CI now enforces it | It measures 1.88:1 light / 2.53:1 dark. The sites that read as "quietest text" carry real reading text and use `--label-secondary`; only genuine decoration asks for `--label-tertiary` by name. Written down was not enough — quick open shipped paths, ⌘-hints and group headers on it. A rule that sets `color: var(--label-tertiary)` alongside a `font-size` now fails the build (§9). |
| A shortcut hint on a selected row is full `--on-accent`, not a mix of it | `color-mix(--on-accent 72%, transparent)` on `--accent-fill` measured 3.22:1. Dimming a label to signal "secondary" only works over a surface with headroom; on a filled accent row there is none. |
| One token layer; the legacy aliases are **gone** (TRA-315) | Aliases let surfaces migrate one at a time; once every surface had landed they were inlined to the token they resolved to and deleted. `var(--text-secondary)` and friends no longer exist — there is exactly one name per colour. |
| Baselined token guard (counts, not per-line suppressions) | Counts only ever move down; a line-level baseline churns on every reflow. |
| One top band; `<Toolbar>` portals into it (TRA-354) | The alternative was migrating every surface's header by hand and hoping the next one remembers. Routing the shared primitive means a surface gets the rule by using the component it already uses, and a surface rendered outside the shell still draws a sane row. |
| Window chrome facts come from preload, never `navigator.userAgent` (TRA-354) | The UA says "Mac" in a browser on macOS, so the traffic-light reservation rendered in `vite dev` for lights that were not there — and every design review taken against localhost was measuring the wrong window. |
| The renderer's appearance choice is pushed to `nativeTheme` (TRA-354) | The sidebar is transparent over a native vibrancy view that follows `nativeTheme`, not `[data-theme]`. Picking Dark on a Light Mac left light material behind dark text: the sidebar rendered as an empty pale pane. |
| Control heights fixed at 20/24/28 | Matches the macOS small/regular/large tiers; any fourth height is drift. |
| Capsule radius for controls; 6px square only for icon-only buttons | macOS 26 control shape. Removes the eight-distinct-radii problem measured on Project Overview. |
| 20px controls keep the painted macOS small size, hit target grown by pseudo-element | The painted size is *correct*; only the hit box was wrong. Growing the box moves no pixel. |
| Prominent buttons are a flat accent capsule | macOS 26 dropped the gradient + bezel entirely. |
| Segmented selection is the thumb, and unselected labels stay at `--label` | macOS draws unselected segments at full strength; `--label-secondary` on the recessed track measured 4.45:1. |
| An icon-only segment gets the 24px track, not `sz-small` (TRA-376) | At 20px the track leaves 1px above a 14px glyph, and `sz-small`'s `padding: 0 8px` wins the cascade over the menu's own `padding: 0` — squeezed vertically, loose horizontally. |
| A menu trigger with its menu open draws no focus ring (TRA-376) | The house ring carries a 1px **inset** accent border. On a full-width row, held for as long as the menu is up, that is a blue rectangle that reads as a focused text field. |
| Badge tint at 18% with a per-tone `--badge-*-fg` label | White-on-a-light-fill was 1.6:1. The tone's own hue, darkened until it clears AA over its own tint, is legible in both appearances. |
| Badges/chips/headers are sentence case | ALL CAPS is reserved for the 10px group header and nowhere else. |
| Cards are opaque with a hairline, no shadow, no glass | Cards are content. The active KPI tile painted on accent measured 3.28:1 and pushed its footnote to 4.45:1. |
| `.lx-btn.is-status:disabled` keeps full opacity | A disabled button whose label is the status readout is information, not an inert control; dimming put it at 2.3:1. |
| Skeletons at final geometry instead of spinners or "Loading…" | Nothing shifts when the data lands, and the loading state shows the shape of what is coming. |
| A failed fetch settles on an em dash + "Couldn't be measured" | A skeleton that pulses forever promises data that is never coming. |
| `listPending` separates "daemon hasn't answered" from "never indexed" | `status ?? 'unknown'` blamed the project for the daemon's silence. |
| Sidebar footer is `.ws-sb-row`, not its own geometry | One row system for the whole sidebar; the footer's labels started 26px left of every other label. |
| Appearance is Auto / Light / Dark, with Auto clearing the key | The old `toggle` only ever wrote `light` or `dark`, so one click pinned the app forever and the system listener stopped mattering. |
| Appearance lives in Settings, not the sidebar footer | A preference is not a navigation destination, and a second footer row cost 28px at the bottom of every window. It renders in Settings' daemon-down and loading states too — the theme is localStorage, not daemon config. (TRA-363 added it back *inside* the app menu, as one `Theme` row — a menu row costs no sidebar height, which is what the objection was about.) |
| The sidebar footer is one row, and that row opens a menu | Every global action was costing 28px of a column meant for navigation: Settings, then Appearance, then a permanent "● Up to date · v3.1.1 ⟳" strip — 70.5px measured, of which the update row's entire message was "nothing is wrong". One row is 42.5px and the next global action costs a menu item instead of a row (TRA-363). |
| A choice in a menu is one row with the control inline, not a header plus one item per value | Appearance first shipped as an `APPEARANCE` caps header over three checked items: four rows for one three-state preference, in the menu built to stop the footer spending a row per thing. A header over a single control is weight without information. One row, name left, pill right, on the shared centre line — and the rule is written for every future choice, not solved for Theme (TRA-363). |
| A choice row is `group` + `menuitemradio`, one keyboard stop, and does not close the menu | `radiogroup` is not a legal child of `role="menu"`, and the shared `SegmentedControl`'s `aria-pressed` says "toggled" rather than "chosen". The row is one Up/Down stop resolved to the checked segment, Left/Right move inside it, and picking a value leaves the menu open — an inline switcher exists so you can watch the app change under it. |
| Icon-only segments dim when unselected; word segments do not | The selected thumb is 1.19:1 light / 1.63:1 dark against the track. On a word that is enough because the word stays readable (TRA-292); an icon has no fallback, so the only cue would be a sub-3:1 fill. Unselected icons drop to `--label-secondary` (4.5:1 on the track). |
| A global action is defined once, in `src/shared/global-actions.ts` | The native menu and the app menu both offer Settings / View changelog / Get help / Check for updates. Two hand-maintained lists drift — a relabelled item, a moved key, an action added to one and forgotten in the other. Neither surface types a label; both read the entry. |
| A glyph names the action; sparkles and speech bubbles are banned by name | `auto_awesome` decorates instead of naming — it says "exciting", not what the item does. `forum` promises a person to talk to, and no surface here provides one. Both shipped anyway, against a reference that showed the right glyphs, which is the second half of this decision: when a reference is supplied, match it or argue it in the PR — never substitute silently. |
| "View changelog", not "What's new" | The item opens the releases page. Someone checking whether a specific fix shipped searches for the word "changelog"; "What's new" describes a feeling about the page, not the page. |
| "Up to date" belongs in the app menu's header, not in a sidebar row | It is the answer to a question you only ask when you go looking, and it belongs next to the action that re-asks it. A permanent strip pays 28px in every window, forever, to report the absence of news. The states you can *act* on — update available, restart pending, bundle stuck — still get a card in the sidebar. |
| A menu anchors on the app, because there is no account to anchor on | The pattern this came from is an account menu, held together by an identity at the top. We have no users. The product is the identity: the trigger carries the name, the header carries the version and whether it is current. |
| In a menu, focus IS the highlight — and the only one | Arrowing moves real DOM focus, so `:focus` has to paint the same accent fill `:hover` does. The house `*:focus-visible` ring on top of that fill drew a blue halo round an already-blue row, which reads as a button on a surface; macOS draws the fill and nothing else. |
| A row that opens a menu takes the inactive-selection fill, keyed off `aria-expanded` | Accent fill means "this is the surface you are looking at". A menu is not a surface, and the footer row navigates nowhere — on `.is-selected` it lit up accent-blue the moment its own menu took focus. |
| A surface that draws its own toolbar owns its whole pane | Wrapping it in the pane's `p-4` doubles every inset the surface already declares — the workspace KPI row started at x=32 with its first card at y=76. |
| Paths truncate at the **head**, keeping the tail | The tail is the part that distinguishes siblings; tail-truncation hid the only useful segment. |
| Sidebar file paths use a `dir`/`name` flex split, not `direction: rtl` | The rtl hack mangled any path containing `.` or `_` runs (`.idea/workspace.xml` → `idea/workspace.xml.`). |
| Whitespace separates sidebar groups, not rules | Fewer lines, clearer grouping; matches the platform sidebar. |
| Rows are windowed past 100 items | A thousand projects costs what a hundred does. |
| A surface with extra columns collapses them with a **container query**, trailing column first | At the 640px window minimum the app sidebar already takes 220. Ask's chat rail + inspector left the conversation at zero width and painted the inspector over its own toolbar. The rules must be last in the file — a container query adds no specificity. |
| A side inspector starts **closed** and persists the user's choice | 280px of "this appears after you send a message" is not worth the width. The toolbar toggle is how it is discovered. |
| A failed send puts the question back in the composer | Losing what you typed is a worse cost than the error itself, and it makes "Send again" a single click instead of a retype. |
| A status colour is never put on a tint of its own hue | `--status-red` is verified on `--surface`; on a 10% red fill it measured 4.31:1. An error reads as an error from its glyph, not from a coloured slab. |
| Notebook's per-cell Run is `bordered`, not `prominent` | One accent capsule per cell put N prominent actions on one surface. The rule is one per region, and a notebook has no single default action. |
| Optionality lives in a field's placeholder, not its label | "Kind (optional)" wrapped to two lines in the form's label column and broke the row baseline. `required` is what the code reads anyway. |
| The toolbar sits **above** the KPI strip, not below it | Chrome above content. With the strip first, 357px of tiles pushed the toolbar's bottom 33px past a 420px window and nothing on the surface could scroll it back. |
| A toolbar has `min-height: 52px` and wraps, never a fixed `height` | A non-wrapping 52px row inside `overflow-x: hidden` ran 51px past a 420px pane and put + Add's chevron and the overflow menu outside the window. |
| The wrap rule belongs to the shared `Toolbar`, not to each surface | Fixed on the Workspace header in TRA-292 and nowhere else, so four surfaces built on the primitive still clipped: at 640×420 Memory overflowed 333px with its search, its prominent "Add decision" and its overflow menu at zero visible pixels and no scrollable ancestor. |
| An unshrinkable control gets a narrow form; wrapping alone does not save it | `flex-wrap` gives a segmented control its own line but cannot narrow it. Insights' 371px picker in a 262px band ran 96.6px past a 640px window and left "Risk hotspots" 14 of its 108px — unreachable. Below the width where the segments fit it is a `PopUpButton`. |
| A collapse threshold reads a width the collapsing thing cannot change | Measured against its own slot, the Insights picker was bistable: the slot is narrower beside the title and full-width once the picker wraps, so both controls were self-consistent at one window size and the render depended on which way the user had resized. The toolbar's width is the honest input. |
| A shrinkable control declares a length `flex-basis`, never `auto` | A wrapping flex line breaks on hypothetical sizes, so `flex-basis: auto` spends none of the control's slack first. `.lx-search` on `auto` wrapped Memory's toolbar at the default 960px window; on `1 1 140px` capped at `max-content` it renders identically and holds one row to a 740px pane. |
| Breakpoints are read off the **pane**, and computed rather than picked | The sidebar is resizable 180–320px, so window width is not a proxy for room. `kpiStripHeight()` reproduces the measured 357px; a guessed number drifts the first time a tile changes. |
| Narrow gives up the comparison, then the table, never the value | The number and the project name are the screen; the footnote and the metric columns are elaboration. Compact already renders a legible row at 420px. |
| A view toggle with one usable option is hidden, not disabled | A disabled segment is a control with nothing to choose. The stored preference is untouched and returns with the width. |
| Migrate a screen **whole**, one screen per PR | A half-migrated screen looks worse than the un-migrated one; a big-bang redesign PR never lands. |
| Tokens and primitives land before any surface | A surface migrated against a moving token layer gets migrated twice. |
| A `var(--x, #hex)` fallback is a bug, not a safety net | `--red` and `--orange` were never defined, so four call sites quietly painted Tailwind `#ef4444` (3.76:1) and `#f97316` (2.8:1) on light. A fallback hides exactly the case the token guard exists to catch. |
| A component nothing renders gets deleted, not migrated | `ProjectRow`, `ProjectDetail` and `GuardBadge` lost their host in the workspace rebuild and carried 10 of the guard's raw hex for three weeks. Rung one is always "does this need to exist". |
| Deleting the last host of a feature means **re-homing the feature**, in the same pass or in a filed issue | `GuardBadge` was the guard's only surface *and* the only caller of `guard.initialize`. Deleting it left 670 lines of working main-process code with three of eight IPC channels reachable, and new projects silently skipping the coach grace period for weeks. A dead component is a rendering fact; the feature it carried is a separate question. |
| Per-project state lives on **Project Overview**, not as another workspace-table column | The table is already at nine columns and drops trailing ones under a container query; a status the user needs is the worst candidate for "first to go". Overview is per-project by definition and has the measure for a mode control and a sentence. |
| A control inside a 32px `ListRow` is the **24px tier**, never `small` | Measured on the running renderer: a `small` segment paints 16px inside a 20px hit box and a `small` button paints 20 in 20 — both under the 24×24 floor, and the row has the height for the regular tier anyway. `small` is for a dense toolbar, not for a list row. |
| A loading sentence goes in chrome that is **already** on screen, never a new layer over the content | Graph Explorer put "Building graph…" and a 45% scrim across the whole 1044×760 pane on every re-load, landing on top of the node labels underneath. The stats pill was already in the corner; it says it there, and the graph stays readable. Only a pane with nothing drawn in it yet gets an `EmptyState`. |
| An error the user is meant to act on is never on a timer | Graph Explorer's red toast erased itself after 7s and left a blank pane with no account of what happened. An error persists until it is retried or resolved, and carries the glyph, the sentence and the Retry together. |
| A primitive's verified contrast is verified against `--surface`, so re-check it on glass | `Badge tone="red"` clears AA over an opaque surface; over the graph overlay's `--viz-glass` its backdrop composites to 253, and the pair had to be re-measured on the running renderer (4.75:1) rather than assumed from the primitive's own test. |
| A hand-rolled control still sits on the type and icon scale of the row it lives in | `+ Add` is a split capsule because `Button` has one radius, and that is fine — but it also inherited an 11px label and a `⌄` text character while every regular-tier control beside it labelled at 13px with real icons. The row's one prominent action was the quietest thing on it. Escaping a primitive's *shape* is not licence to escape its *scale*. |
| A contrast number describes an element, never a selector | TRA-355 measured `rgba(255,255,255,.85)` on `--accent-fill` at 3.89:1 and called it an AA failure "for the count". The count is styled and rendered by nothing; the rule's only live target was a glyph, floor 3:1, already passing. Before quoting a ratio as a failure, confirm the thing it describes is on screen — `document.querySelectorAll` in the running app, not a reading of the stylesheet. |
| Verify in the Electron window, not in Chrome | `navigator.userAgent` says "Mac" in Chrome on macOS too, so the renderer draws the 44px traffic-light reservation with no traffic lights in it — a band that does not exist in the real app. A screenshot off `vite dev` in a browser is a different product. (Nikolai, 2026-08-29; the rule itself lands with TRA-354.) |
| A rule the enforcement cannot see is a comment | §8 rule 1 named `rgb()` from day one and `tokenGuard()` never counted it, so the ban held for hex and lapsed for `rgb()` — which is how a 3.89:1 label sat on the sidebar with a green build. When a rule goes into §8, check the script actually implements all of it. |
| A row label never repeats its own control's verb | "Temporary pause" beside a "Pause for 10 minutes" button wrapped to two lines at the 640px minimum and added no meaning. The label names the subject ("Enforcement"), the control names the action. |

---

## 12. Migration status

**Every surface is on this system**: the token layer, the control primitives, the
window chrome, the sidebar and its footer, the workspace dashboard, Project Overview,
Activity, Memory, MCP Clients, Settings, the onboarding sheet, Graph Explorer,
Insights, Ask, and **Notebook** — the last one, migrated in TRA-310.

Graph Explorer's **floating overlay layer** — loading, error and the bottleneck
hotspots panel — came onto the system in TRA-349, the last part of that surface
still on pre-revision styling. Loading no longer paints anything over the graph
(the sentence moves into the stats pill; a pane with nothing drawn yet gets an
`EmptyState`), the error is persistent house anatomy with a Retry instead of a
7-second red toast, and the panel dropped its own four font sizes and its
`opacity` dimming for the caption scale and `--label-secondary`.

Project Overview carries a fifth section as of TRA-334: **Guard** — health as a
`Badge` (tone + glyph + word), mode as a `SegmentedControl`, the coach→strict
date, and the bypass readout with its pause/resume control. It is also what calls
`guard.initialize`, which nothing had called since `GuardBadge` was deleted.

**The legacy alias layer is gone** (TRA-315). `app.css` no longer declares
`--text-primary/secondary/tertiary`, `--bg-*`, `--border*`, `--success`, `--warning`
or `--fill-control`, and `island.css` no longer declares `--text-1/2/3`, `--island`,
`--frame`, `--sep`, `--row-hover` or the `--status-*-hue` pass-throughs. Every one of
them was inlined to the token it already resolved to, so nothing moved on screen and
there is now exactly one name per value. Use the tokens in §2 directly.

What still carries raw colour, and why:

| File | Count | Status |
|---|---|---|
| `tabs/GraphExplorerGPU.tsx` | 46 | Shader and canvas data, not chrome — node/link colours, the theme table cosmos.gl is handed, and the three stops of the bottleneck ramp, which have to stay identical to `bottleneckColor01()` or the key would disagree with the pixels it explains. The chrome is done: the toolbar, popover and legend in TRA-296, the overlay layer (loading, error, hotspots panel) in TRA-349. |
| `styles/island.css` | 36 | The file-tree / graph **domain palette** (`--folder-*`, `--db-*`, `--mod-text`, `--ignored-*`, glass tints). It has hand-picked light *and* dark branches, so it is a deliberate exception, not drift. |
| `lattice/icons.tsx` | 1 | `AgentMark`'s brand purple — artwork, not chrome. |
| `lattice/ui/Badge.tsx` | 2 | Two hex in a comment recording what the primitive replaced. |

Counts in that table are what `tokenGuard()` reports, so `island.css` and
`GraphExplorerGPU.tsx` roughly doubled in TRA-355 when the guard started counting `rgb()`
as well as hex (§9). The files did not change; the guard's eyesight did.

The same change made eight smaller sites visible, all of them **compositing values rather
than palette** — a modal scrim (`app.css`, `ProjectStatsModal.tsx`, `MemoryExplorer.tsx`,
`ToolActivity.tsx`), or the black at low alpha inside a shadow (`controls.css`,
`Settings.tsx`). A scrim is not a colour a token names, so they are baselined where they
are rather than tokenised for the sake of the count.

Two were **not** compositing, and were fixed in the same pass:
`workspace/AddProjectControl.tsx`'s split-button divider (raw white → `color-mix` over
`--on-accent`) and `styles/sidebar.css` (a dimmed white on the selected row, plus two dead
`var(--fill-tertiary, rgba(…))` fallbacks of the kind the decision log already calls a
bug). Both files are now absent from the baseline entirely.

Nothing else in the renderer paints a colour the contrast table cannot see.

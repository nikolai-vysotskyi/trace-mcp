---
layout: default
title: DESIGN-WEB.md — the trace-mcp.com visual standard
description: Internal working document. The visual standard for trace-mcp.com.
noindex: true
---

# DESIGN-WEB.md — the trace-mcp.com visual standard

This file governs **the website only**: `docs/index.html`, `docs/_layouts/`,
`docs/assets/css/`, the documentation pages, and `docs/images`.

It does **not** govern the desktop app. The app follows macOS 26 and the
root `DESIGN.md`, owned by the Design/UX Agent. The two aesthetics are
deliberately different — the app is native to macOS, the site is Nothing.
Never port a decision from one to the other, and never "unify" them.

The site's aesthetic is **Nothing**: monospaced caps for service labels, a dot
lattice, monochrome, generous air, no gradients, no shadows.

---

## 0. Red means something is wrong. Nothing else.

Nikolai's decision, 2026-09-03. It overrides the earlier "red is the single
accent" rule that the rest of this file was written under, and it overrides the
`nothing-design` skill where the two disagree. The copy in the agent brief and
the copy here are the same rule; change one, change both.

Red on our surfaces says **error, regression, degradation, or "here is what it
costs without trace-mcp"**. Nothing else.

Not allowed:

- a red fill on the primary CTA, or on any button meant to be pressed;
- red as a brand accent — dots, chips, outlines, underlines, hover states,
  bullets, glyphs, icons;
- red as decoration in banners, logo lockups, and social previews.

The reason is not taste. Red reads as a warning: a download button in red asks
the reader to be careful rather than to download, and next to an honest
`without trace-mcp — 13,595 tok` — where red is right — one hue is saying two
opposite things on one screen.

What replaces it: the base stays monochrome. An element that needs an accent
takes it from the accent palette below, and red is not in it.

**The accent is cobalt** (TRA-753). TRA-739 removed the red and left the whole
first screen monochrome; Nikolai's verdict on that was that the button had
stopped standing out. Monochrome is the right base, but the one action on the
page is the one thing that is allowed not to be monochrome.

| Role | Token | Dark | Light | Ratio |
|---|---|---|---|---|
| Fill under a white label | `--accent-solid` | `#2B5FE3` | `#2B5FE3` | **5.46** |
| Fill hover | `--accent-solid-hover` | `#1B49B8` | `#1B49B8` | **7.80** |
| Foreground (links, glyphs) | `--accent` | `#5B8CFF` | `#1E4FCB` | **5.50** / **6.07** worst surface |
| Failure, regression, cost | `--negative` | `#E54047` | `#B3151C` | **4.27** / **6.06** worst surface |

Cobalt's hue is 222°: **136° from the negative red** (358°) and **90° from the
success green** (132°), so the `without / with` receipt has no two colours that
argue. Its conventionality is the argument for it rather than against — a blue
button does not ask the reader to hesitate. It also closes the gap the red
never did: `--accent` on `--surface-raised` in dark was 4.27 and forced a "no
accent text on raised" ban; cobalt is 5.50.

The two candidates it beat, measured the same way — white on the fill, worst
surface for the foreground:

| Candidate | Fill | White on fill | Dark fg | worst | Light fg | worst | Why not |
|---|---|---|---|---|---|---|---|
| Indigo | `#5A3FE0` | 6.52 | `#9A87FF` | 6.79 | `#5232C9` | 6.93 | the 2020s AI-startup violet; dates fast |
| Teal | `#0E7C86` | 4.95 | `#2FBECC` | 9.36 | `#0A6670` | 5.85 | 54° from `--success` — argues with `with trace-mcp` |

Rejected before those and not to be re-proposed: pure monochrome, and the four
red-fleck variants — dot, ring, chip, monochrome.

**Cobalt is the accent, not a repaint of everything TRA-739 made monochrome.**
It is spent in exactly two places, both of them "this is the thing you act on":
the primary CTA fill, and a link inside prose. The nav liveness dot, the
problem-list bullets, the category dot and the punchline glyph stay
`--text-display` / `--text-disabled` as TRA-739 left them — they are not
actions, and a page where every mark is accent-coloured has no accent.

Landing and doc pages carry **zero** decorative red as of TRA-739. What used to
be `--accent` (the danger red) is now `--negative`, with its ratios intact,
because the next genuine failure state must not have to re-derive it. Red as a
fill has no job on the site: never reintroduce a red `--accent-solid`.

---

## 1. Tokens

Two surfaces implement these: `docs/index.html` (landing, inline `<style>`) and
`docs/assets/css/docs.css` (every documentation page). The values must match.
A token that exists in only one of them is a component token and must say so
here — otherwise it reads as drift. There are two: `--accent-solid` and
`--accent-solid-hover`, both landing-only fills (§0).

Surfaces — a text token has to clear its ratio against **every** one of these
it is painted on, because all three are in use on the same page:

| | Page | Surface | Raised |
|---|---|---|---|
| Dark | `--black` `#000000` | `--surface` `#111111` | `--surface-raised` `#1A1A1A` |
| Light | `--black` `#F5F5F5` | `--surface` `#FFFFFF` | `--surface-raised` `#F0F0F0` |

Borders: `--border` `#222222` / `#E8E8E8`, `--border-visible` `#333333` /
`#CCCCCC`. Not text — no ratio applies.

Text and accent tokens, with the ratio against each of the three surfaces of
their own theme, **in the column order of the surface table above — page,
surface, raised.** The governing number is bold.

| Token | Dark | page / surface / raised | Light | page / surface / raised |
|---|---|---|---|---|
| `--text-disabled` | `#848484` | 5.61 / 5.05 / **4.65** | `#6D6D6D` | 4.75 / 5.17 / **4.54** |
| `--text-secondary` | `#999999` | 7.37 / 6.63 / **6.11** | `#595959` | 6.42 / 7.00 / **6.15** |
| `--text-primary` | `#E8E8E8` | 17.14 / 15.41 / **14.20** | `#1A1A1A` | 15.96 / 17.40 / **15.27** |
| `--text-display` | `#FFFFFF` | 21.00 / 18.88 / **17.40** | `#000000` | 19.26 / 21.00 / **18.43** |
| `--accent` | `#5B8CFF` | 6.64 / 5.97 / **5.50** | `#1E4FCB` | 6.34 / 6.92 / **6.07** |
| `--negative` | `#E54047` | 5.16 / 4.64 / **4.27** | `#B3151C` | 6.33 / 6.91 / **6.06** |

**`--surface-raised` is always the worst of the three,** in both themes — it is
the lightest surface in dark and the darkest in light, so it is the one every
foreground has the least room against. Never quote a token's ratio from `page`
because it is the biggest number.

`--negative` in dark is the one token that does **not** clear 4.5:1 everywhere:
`#E54047` on `--surface-raised` is 4.27. Red text is therefore not allowed on
`--surface-raised` in dark. It is not currently used there anywhere; the
contrast sweep below is what keeps it that way. Raising the red further to
clear `#1A1A1A` too would push it to roughly `#EA5057`, which reads pink
rather than red, and the negative being *this* red is not negotiable.

**`--negative` is the danger colour and nothing else** (§0). It is currently
painted on no element of either surface; it stays defined, with its ratios,
because the next genuine failure state must not have to re-derive a red that
clears AA. It is lighter in dark and darker in light because a foreground has
to fight its background. Never use it as a fill under white text — `#E54047`
behind white is 4.07 and fails. It was called `--accent` until TRA-753; the
name was the whole problem, since a token named "accent" invites decoration.

**`--accent-solid` `#2B5FE3` and `--accent-solid-hover` `#1B49B8` are the
accent as a fill,** so they are never a foreground and have no ratio against a
surface. The only ratio they have is the white label on them: **5.46** and
**7.80**. Their one consumer is the landing's primary button, so they live in
`docs/index.html` alone; `docs/assets/css/docs.css` has no filled component and
adding them there would be dead tokens. A **red** `--accent-solid` is a
different matter and is banned outright (§4): the old `#D71921` is gone and a
fill red that no element uses is how the CTA got red back the last time.

`--accent` (link/glyph cobalt) is lighter in dark and darker in light because a
foreground has to fight its background; a fill does not. Never use
`--accent-solid` as a text colour, and never use `--accent` as a fill under
white text — `#5B8CFF` behind white is 3.16 and fails.

**Compute a ratio against the surface the text actually sits on, in both
themes.** `#FFFFFF` in light and `#000000` in dark are the most forgiving
backgrounds of their theme and the ones a colour picker defaults to, so a
value checked only against them lands short on the surfaces it ships on. That
error has now shipped twice:

- `--text-disabled` light shipped at `#767676`, recorded here as "4.54:1" —
  its ratio on `#FFFFFF`. On the `#F5F5F5` page it is 4.17, and every
  `scroll →` and `SEE ALSO` label on all 17 doc pages sat under AA for months
  while this file said they passed.
- `--text-disabled` dark shipped at `#666666` with **no ratio recorded at
  all**: 3.66 on `#000000`, 3.29 on `#111111`. That is the `✗` capability
  mark — 161 of them on `comparisons.html` alone — plus every `[OK]` bracket,
  `SCROLL →`, `LICENSE`, and the terminal's comment lines. The "no" answer in
  our own comparison table was the least readable text on the site.

**Raising `--text-disabled` did not flatten the ramp — measured, not assumed.**
The objection to raising it was that `#848484` and `--text-secondary` `#999999`
sit 21 hex steps apart and would stop reading as two levels, trading a contrast
failure for a hierarchy failure. In CIE L\* — which is what the eye separates on,
not hex distance — the four dark levels land at 55.1 / 63.2 / 92.0 / 100.0, and
the four light ones at 46.0 / 37.8 / 9.3 / 0.0. Both ramps step
**8 / 29 / 8**: the disabled-to-secondary gap is 8.1 in dark and 8.2 in light.
Light has always shipped that separation and has always read as four levels, so
dark now reads as four levels for the same reason. Neither of the alternatives —
pushing `--text-secondary` up to keep the gap, or dropping dark to three levels —
is needed. Compare greys in L\*, not in hex; hex distance is not perception, and
it is what made this look like a trade-off.

Dark mode is the default. Light is opt-in and equally first-class — never
ship a change checked in one mode only.

**Theme is one shared decision.** Both surfaces read and write the
`trace-mcp-theme` localStorage key and set `data-theme` on `<html>` in a
blocking inline script before first paint. A reader who picks Light on the
landing page must stay in Light when they open a doc page, with no flash.

### Type

- `--font-body` — Space Grotesk (300–700 variable)
- `--font-mono` — Space Mono (400/700)
- `--font-display` — Doto. Landing hero moments only; never in docs prose.

Self-hosted from `docs/fonts/*.woff2`. Never add a Google Fonts `<link>` —
it costs a third-party connection and a FOUT we already solved. Both families
have metric-matched local fallbacks (`Space Grotesk Fallback` → Arial,
`Space Mono Fallback` → Courier New) so first paint does not reflow.

Budget per page: **2 families, 3 sizes, 2 weights**. Doto is the exception and
counts as the one break.

### Spacing

The lattice is 24px. Vertical rhythm in prose:

| Distance | Meaning |
|---|---|
| 4–8px | one thing (icon + label, number + unit) |
| 20px | paragraph to paragraph |
| 48px | h3 — subsection |
| 80px | h2 — new section, drawn with a hairline |
| 96px+ | new context (header to content, content to footer) |

If a divider is needed, the spacing is probably wrong. Dividers are for
structurally identical rows, and for the h2 section rule.

### Grid

- Prose column: `max-width: 880px`.
- Landing / header: `max-width: 1280px`.
- Gutters: 32px, 20px below 600px.

---

## 1a. The logo is the word

Nikolai's decision, 2026-09-04 (TRA-777): **the wordmark is the logo.** There
is no emblem standing beside it. The square surfaces macOS, Windows and the
browser force on us are served by a *fragment of the wordmark*, never by a
second mark drawn on its own.

### What it is

`trace-mcp` drawn, not set: monolinear lowercase letterforms on one grid, with
**the hyphen redrawn as a step that climbs**. The step is the whole idea — the
word carries the product's meaning in the one place nobody looks — so it is the
only coloured thing in the logo and it is drawn with the same pen as the
letters.

Grid, in units of a 100-unit em:

| | Value |
|---|---|
| ascender / x-height top / baseline / descender | `22` / `48` / `100` / `124` |
| stem weight | `13` |
| corner radius | `14` |
| step rise | `26` — exactly two stem weights, centred on the x-height middle (`74`) |
| step path | `M6 87 H30 V61 H56` — **one path, one subpath** |

The step is a single path on purpose: it survives conversion to outlines and
small-size rasterisation as one shape. If it ever becomes two paths, it will
break at the join before anything else does.

### Colour

| | Ink | Step |
|---|---|---|
| Light | `#000000` | `--accent-solid` `#2B5FE3` |
| Dark | `#F2F2F2` | `--accent` `#5B8CFF` |

The step is the **only** colour in the logo. No second accent, ever — the
contrast between one monochrome word and one coloured connector is what makes
the step read as a trace instead of a hyphen. Red is out here as everywhere
(§0).

### Minimum size, and when the fragment takes over

Measured on a 1× raster, not a retina screenshot — the wordmark is 474 units
wide, so the stroke is `width × 0.0274`:

| Width | Stroke | Verdict |
|---|---|---|
| 520px | 14.3px | display — README banner, social preview |
| 200px | 5.5px | header, docs |
| **104px** | **2.9px** | **minimum — the last size the word survives** |
| 84px | 2.3px | the `e` bar and the `a`/`c` counters start to close |
| 72px | 2.0px | grey mush; do not ship |

**Below 104px wide the word is not used.** What runs there is the step alone,
lifted out of the word — favicon, app icon, GitHub avatar. That fragment is a
crop of the logo, not a logo of its own, and it is never placed next to the
wordmark: if the word is on screen, the fragment is redundant.

### Lockups

- **Site header** — the word alone at 132px. No mark beside it.
- **README banner** — the word alone, centred, on `--black`.
- **Social preview** — the word is the subject of the frame; the domain and the
  line of copy are Space Mono caps at `--text-disabled`. Nothing else in frame.
- **Square surfaces** (`.icns`, `.ico`, favicons, `apple-touch-icon`, avatar) —
  the step fragment on a near-black plate. The craft of that square — squircle,
  optical sizing, stroke weight at 16px — is TRA-780, owned by the Design/UX
  Agent, and it works from this file.

### Never

- Do not set the wordmark in Space Mono or Space Grotesk with tracking and call
  it the logo — the drawn outlines are the logo.
- Do not put the brackets back around it.
- Do not colour anything in it but the step.
- Do not place the fragment next to the word.
- Do not use the word below 104px wide.

---

## 2. Documentation page anatomy

Doc pages are Markdown rendered by kramdown through `_layouts/default.html`.
There is no per-page HTML, so **every visual decision lives in
`docs/assets/css/docs.css`** and applies to all 17 pages at once.

The stock GitHub Pages Primer stylesheet is **not** used and must not be
re-linked. It shipped 76.5 KB, zero `prefers-color-scheme` rules, system
fonts and zebra-striped tables — three of those are outright violations below.

Order: sticky header (brand + theme toggle) → `h1` → prose → `Last updated`
→ `See also` footer.

- `h1` is the one display element on the page: `clamp(38px, 6vw, 56px)`,
  weight 500, `-0.03em`. One per page.
- `h2` owns its section break: 80px above, hairline `border-top`. When the
  Markdown writes `---` directly before a `##`, the `<hr>` keeps the rule and
  the `h2` drops its own — never two hairlines around an empty band.
- `h4`–`h6` are Space Mono 11px caps at `--text-secondary`, not scaled-down
  headings.
- Links are `--text-display` with a 40%-opacity underline of the same colour
  that goes solid on hover. **A doc page has no chrome colour at all** (§0):
  the link is the brightest text in its paragraph *and* the only underlined
  one, so the affordance survives greyscale and colour blindness, which the
  old red-plus-underline never needed to. Blockquotes take
  `--border-visible`, not an accent.
- Tables: **no zebra striping.** Rows separate on a `--border` hairline; the
  head is a Space Mono 10px caps label, not a bold band. Every table is
  wrapped in a focusable `.table-scroll` region by the layout script, so a
  wide tool table scrolls itself instead of the page.
- **Every table column is left-aligned, except numbers, which go right.**
  Centring is for a single glyph in a fixed-width column and nothing else: a
  centred cell holding a phrase has two ragged edges, no common start to scan
  down, and sits in a row whose label column is left-aligned — left → centre →
  centre across one row. Measured on the published site, 409 cells on
  `/comparisons.html` were centred and 130 of them wrapped to two or more
  lines, with each line starting somewhere different. Right alignment stays
  where it earns its keep: `toon-savings.html` right-aligns its numeric
  columns so the digits line up on their units.
  The alignment does not come from this stylesheet — kramdown turns a
  `|:---:|` delimiter row into an inline `style="text-align: center"` on every
  cell of that column, and an inline style outranks any rule here. So the
  override is `.prose td[style*="center"] { text-align: left !important }`,
  which also catches the next table someone writes with `:---:`. **Fix it in
  the CSS, never by editing the Markdown** — content files belong to the SEO
  agent, and a per-file fix is exactly how this drifted onto twelve tables.
- **A scroll region says so.** A region with more to the right carries a
  `scroll →` label — Space Mono 10px caps at `--text-disabled`, right-aligned
  10px above the head row, the same instrument-label voice as the `thead`.
  The script adds it only while the region is genuinely scrollable and not
  yet at its end, and re-measures on resize and after the webfonts land.
  Without it the last column simply ends mid-word: macOS hides the overlay
  scrollbar at rest and a phone never draws one, so nothing on screen
  distinguishes "scrolls" from "clipped". This is not a mobile-only case —
  three of the five tables on `comparisons.html` overflow the 880px prose
  column at 1440px. No fade or gradient mask: gradients in chrome are out
  (§4), and a fade states less than a word does.
- Capability marks in a comparison table are **`✓` and `✗` text, never `✅`
  and `❌`**. The emoji pair is a filled multi-colour icon and a second and
  third accent colour — 305 of them on `comparisons.html` alone painted the
  page green and red, which is the one thing red is reserved for. Yes and no
  separate on **opacity**: `✓` at `--text-display`, `✗` at `--text-disabled`.
  The layout script wraps each mark in `.mark-yes` / `.mark-no` with
  `role="img"` and an `aria-label`, so a screen reader reads "Yes" / "No"
  rather than "check mark" — the emoji's one advantage, kept. Markdown source
  stays the bare glyph so the table is still scannable in a diff.
- Code: `--surface` fill, `--border` outline, 4px radius inline / 8px block.
  Syntax highlighting differentiates by **weight and opacity**, not hue.
- The `See also` footer is a **grid, one cell per link**
  (`repeat(auto-fill, minmax(200px, 1fr))`) — 3 columns at 1440px, 2 at
  500px. Never an inline `·`-separated strip: at 17 entries that wrapped
  mid-label, so no link read as a single target.

**Who owns the footer nav.** Which pages are listed, what they are called, and
in what order is `docs/_data/docs_nav.yml`, and that belongs to the **SEO
agent** — it is internal-link structure. This file governs only how the
resulting list is laid out. Adding, renaming, or reordering an entry to suit
the layout is out of bounds; if the list needs to change shape, ask.

---

## 3. Screenshots of the app

The capture script `scripts/capture-screenshots.mjs` is owned by the
Design/UX Agent. **Do not write another capture path and do not edit that
script.** Need a different angle or a new surface? File an issue against it.

This file governs presentation only. The rule below is `.app-frame` /
`.app-gallery` in `docs/index.html`, which is what ships today — measured in
the browser, not aspirational:

**The frame.** Every app screenshot sits in a `<figure class="app-frame">`:

- `1px solid var(--border-visible)` outline, `var(--surface)` fill, `20px`
  padding. **Square corners — `border-radius: 0`,** on the frame and on the
  image. The rounding a reader sees belongs to the macOS window inside the
  shot; a second radius on the frame would read as a second window.
- The image is `width: 100%`, `display: block`, and carries **no fill of its
  own**. The shots are window photographs with transparent rounded corners;
  a `--ghost` plate behind them paints four grey blocks into those corners.
  The frame's `--surface` is what shows through.
- Hover raises the outline to `--text-display`. That is the only state.

**The caption sits above the image, not below it** — a `.app-frame-meta` row
in Space Mono 10px caps at `--text-disabled`, `0.1em` tracking, `20px` above
the image. It reads as an instrument label on the bezel: subject on the left
(`--text-display`), a hairline rule spanning the gap, context on the right.
A caption below would read as body prose and compete with the section text.

**Never butt two screenshots together.** Grid gap is `24px` on desktop, `16px`
below 900px. Never zero.

**A light/dark pair is one image, not two.** Show the appearance the reader
already chose — `img.theme-light-only` / `img.theme-dark-only`, switched off
`data-theme` — never stacked one above the other. Two appearances of the same
screen stacked read as one broken image, and they double the bytes for a view
the reader did not ask for.

Write those selectors as `img.theme-*`, not `.theme-*`: the bare class (0,1,0)
loses to `.app-frame img` (0,1,1), the `display: none` never lands, and both
appearances render stacked — which is exactly how the pair shipped and how
TRA-390 was reported. Check `display` in the browser, in both themes; the
markup alone does not tell you which rule won.

**Content.** Shot from the real Electron window — traffic lights and rounded
window corners must be present. No traffic lights means it came from a
browser: reject it. No visible errors, skeletons, scratch directories, or
personal paths.

**Weight.** WebP, `loading="lazy"`, and explicit `width`/`height` so the
image reserves its box and costs no CLS. The four app shots are 39–132 KB
each. A PNG app screenshot is a bug — the pair alone was megabytes before the
WebP conversion.

---

## 4. Never

- Gradients in UI chrome.
- Shadows, blur as decoration (the header's backdrop blur is the one exception).
- Zebra-striped tables.
- Skeleton loaders — use `[LOADING...]`.
- Toast popups — use inline `[SAVED]` / `[ERROR: …]`.
- Filled or multi-colour icons, emoji as UI — including `✅` / `❌` / `⚠️`
  as capability marks in a table.
- **Red on anything that is not a failure, a regression, or a cost** (§0):
  no red CTA, dot, chip, bullet, outline, underline, hover, icon, banner or
  social preview. This overrides the old "red is the single accent" rule.
- Reintroducing a **red** `--accent-solid`, or any red fill.
- Setting the wordmark in a system font instead of its drawn outlines,
  bracketing it, or giving it a second accent colour (§1a).
- A second accent colour. Cobalt is the only one; `--accent` and
  `--accent-solid` are two lightnesses of it for two jobs (§1), not two
  accents. `--negative` is not an accent — it is the danger colour, §0.
- Spending the accent on anything that is not an action. The CTA fill and a
  prose link are the whole list; dots, bullets, glyphs and tags stay
  monochrome (§0). A page where every mark is accent-coloured has no accent.
- `--accent` as a fill under white text (3.16, fails), or `--accent-solid` as
  a text colour.
- Red text on `--surface-raised` in dark — 4.27:1, the one gap in §1.
- A colour value recorded with a ratio against a background it is not painted
  on. Quote the worst of the three surfaces, in both themes.
- `border-radius` over 16px on a card.
- Spring or bounce easing. Only `cubic-bezier(0.25, 0.1, 0.25, 1)`.
- Parallax or scroll-jacking.
- Re-linking the Primer stylesheet, or adding a Google Fonts `<link>`.
- Shipping a colour change verified in one theme only.
- Two screenshots butted together, or a light/dark pair stacked rather than
  theme-switched.
- A PNG app screenshot. WebP only.
- A long link list as an inline `·`-separated strip.

---

## 5. Review checklist

Run before opening any PR that touches the site. An assertion about
appearance without a screenshot or a measurement is not a finding.

**Both themes**
- [ ] Dark and light both screenshotted, no unstyled flash on load.
- [ ] Exactly one image of a light/dark pair has computed `display: block` —
      read it off the element, in each theme.
- [ ] Theme choice survives landing → doc page navigation.
- [ ] Contrast sweep is green. Not a claim — a command:

      ```
      node scripts/contrast-sweep.mjs
      ```

      It serves `docs/` locally, renders the landing and every doc page —
      recursively, so `docs/vs/*` is included — in headless Chrome in both
      themes, and for every element carrying its own text reads the computed
      `color` against its nearest opaque ancestor background, the real
      painted background rather than an assumed surface. Body text needs
      4.5:1, large text (≥24px, or ≥18.66px bold) 3:1, with no tolerance:
      4.49 fails. `aria-hidden="true"` subtrees are skipped as decoration.
      Exit code is non-zero on any failure; pass paths
      (`node scripts/contrast-sweep.mjs / /comparisons.html`) for a subset.

      **Know what it does not cover.** Without a Jekyll build it re-renders
      Markdown with its own small converter, so a construct that converter
      does not implement paints no element and any selector styling that
      construct goes untested. It is a regression gate on the token ladder,
      not proof of full coverage. For the real published DOM, build the site
      first — the sweep serves `docs/_site` verbatim when it exists. Run it
      that way before changing anything structural, not just a token.

      This bullet used to say "measure it, don't check the token table" and
      the table was still wrong in both themes at the time. Eyeballing a grey
      is exactly what failed here, twice — so the check is a command that
      fails, not a sentence that asks you to be careful. The landing is swept
      alongside the doc pages because it carries its own copy of the tokens
      (§7) and has drifted from this table before.
- [ ] A new `aria-hidden` on anything the sweep now skips is deliberate
      decoration, not a way to silence a failure. `aria-hidden` means "not for
      the AT tree"; it does not exempt painted text from 1.4.3, and the two are
      not the same axis. `scroll →` is the case that proves it — correctly
      `aria-hidden` (a screen reader navigates the region directly and never
      scrolls it) yet visible functional text, and on top of that `display:none`
      until the region actually overflows. Both of the sweep's skips dropped it,
      so the one label §2 argues hardest for was the one label nothing measured:
      44 of them on `/` and `/configuration.html` alone. The sweep now reveals
      every `.scroll-hint` and checks it despite `aria-hidden`. Anything else
      given `aria-hidden` must be decoration you would not mind being illegible
      — currently the YC badge mark, the `MIT` and licence badge marks, the
      terminal's `$` prompt, and the landing's 400px ghost `94%`.

**Widths**
- [ ] Desktop (1440px) and narrow (≤500px) both screenshotted.
- [ ] `document.documentElement.scrollWidth === window.innerWidth` at the
      narrow width — no sideways page scroll.
- [ ] Wide tables scroll themselves, not the page.
- [ ] No table cell computes to `text-align: center` — read it off the
      elements, not off the stylesheet, because the alignment arrives as an
      inline style from kramdown and never appears in a `.css` diff:
      `[...document.querySelectorAll('.prose td, .prose th')]
      .filter(c => getComputedStyle(c).textAlign === 'center').length`
      must be 0 on every page with a table. Right-aligned numeric columns are
      expected and stay.
- [ ] No footer nav label breaks into fragments — count links taller than one
      line at 1440px, 1200px and 390px, not at 1440px alone. The landing
      footer's sub-column width falls by ~13px in the 1184–1262px band and
      that is where a long label first breaks (§9).
- [ ] Every region where `scrollWidth > clientWidth` shows the `scroll →`
      label, and every region that fits does not — count both, at 1440px and
      at 390px. A region is any element that scrolls itself: the table
      wrapper *and* every `pre` *and* the landing page's `.terminal-body`.
      Code blocks and the landing terminal were each read out of this line
      once and shipped clipped and unlabelled for months.

**Colour**
- [ ] No red outside a failure state. Not a claim — a command:

      ```
      grep -ni 'var(--negative)\|#D71921\|#E54047\|#B3151C' \
        docs/index.html docs/assets/css/docs.css
      ```

      Every hit must be either a token definition or an element that means
      something is wrong (§0). Today the correct output is the two
      `--negative` definitions per file and nothing else. `#D71921` — the old
      red fill — must never appear at all.
- [ ] The accent is spent only on actions. Also a command:

      ```
      grep -n 'var(--accent)\|var(--accent-solid' \
        docs/index.html docs/assets/css/docs.css
      ```

      Every hit must be a token definition, `.btn-primary`, or `.prose a`
      (§0). A dot, bullet, glyph or tag in the output is the finding.

**Type & spacing**
- [ ] Within the 2 families / 3 sizes / 2 weights budget.
- [ ] Service labels are Space Mono caps; nothing else is.
- [ ] No emoji in any rendered page — `grep -c '✅\|❌\|⚠️' docs/*.md
      docs/vs/*.md` returns 0 for every file.
- [ ] Exactly one h1; section breaks are 80px, not ad hoc.
- [ ] Exactly one deliberate pattern break on the page.

**Accessibility**
- [ ] Visible focus ring on every link, button, and scroll region — read
      `outlineColor` off a focused element, in both themes. It must be
      `--text-display`. Chrome's default is `rgb(153, 200, 255)`; a blue ring
      means no author rule matched, which is a second accent colour and a
      finding. The rule is a `:where()` list, so a new kind of tab stop is
      invisible to it until its selector is added — check the ring on every
      element that takes a `tabindex`, not only the ones that look clickable.
- [ ] Only a region that actually overflows is a tab stop. 27 focusable code
      blocks on a desktop where 4 of them scroll is 23 dead stops.
- [ ] Skip link present and reachable.
- [ ] `prefers-reduced-motion` honoured.
- [ ] Tables carry `scope`; images carry `alt`.

**Weight**
- [ ] No new third-party origin.
- [ ] Image format and page weight agreed with the SEO agent.

---

## 6. Boundaries

- **Design/UX Agent** owns the desktop app, `DESIGN.md`, and
  `scripts/capture-screenshots.mjs`.
- **SEO Agent** (autopilot "trace-mcp.com SEO & Marketing") owns keywords,
  copy, indexation, and Core Web Vitals as a metric. It decides what belongs
  on a page and why; this file decides how it looks. Image format and page
  weight are shared — agree, don't silently redo.

## 7. Known deliberate debt

The landing page keeps its own inline copy of the tokens rather than importing
`docs/assets/css/docs.css`. `docs/index.html` is a 3,000-line hand-written
single file that the SEO agent edits constantly; extracting a shared sheet
would be a large refactor with a live merge-conflict cost. The tokens in
Section 1 are the contract — change one, change both files in the same PR.

The same duplication applies to the accessibility layer, and it is easier to
forget than a token because nothing looks wrong until you press Tab. The
landing page must carry its own copy of the skip link, the
`:where(a, button, summary, …):focus-visible` ring, and the
`prefers-reduced-motion` block. It shipped without all three while every doc
page had them, so the busiest page on the site was the only one handing
readers Chrome's blue ring and playing its count-up animation at people who
asked the OS for less motion.

The scroll-region rule (§2) counts the landing page too: **`.terminal-body`
in `docs/index.html` is a scroll region** and carries its own copy of the
mechanism — the `scroll →` label, the conditional `tabindex`, and a place in
the focus-ring list. It sat there for months with `overflow-x: auto` and
nothing else, clipping the quickstart's payoff line mid-word on every phone,
purely because the fix landed in `_layouts/default.html` and the landing page
does not use that layout. Its label lives in the terminal header rather than
above the block — the header is already a mono caps row — and its focus ring
is `outline-offset: -3px`, because `.terminal` clips its children and an
outside ring would be cut off. Anything else on this page that scrolls
sideways needs the same three parts wired by hand.

The CSS `prefers-reduced-motion` block stops transitions and keyframes, not
motion driven from JavaScript. The landing page animates a stat count-up over
1400ms and staggers a segmented bar at 30ms per cell from `setTimeout`; both
read a `reduceMotion` flag off `matchMedia`. Any new JS-driven motion has to
read it too — the media query alone will not catch it.

---

## 8. The landing hero

Numbered last because §1–§7 were written before this section existed; renumbering
would break the `§` references inside this file and the one in `docs/index.html`.
Read it as the landing-page counterpart to §2.

**Centred, one column, and this order** (TRA-738, from Nikolai's mock): eyebrow →
headline → one line of what it is → one button → the platforms it is not offering
→ the npm box → the trust line at the fold. That is the whole first screen.
Anything else belongs below the fold or one click away, and the burden is on the
addition, not on the removal.

The list of what used to sit here is the point: a service label
(`/ Recomputation → Reuse · AI Execution Layer`), a version + licence row, a
two-sentence description, two actions of different natures, an
alternative-architecture link, and a three-item trust row — eight blocks above
the fold where Ollama, the reference, has three. Left-aligned, they read as a
paragraph the visitor had to finish before finding the download.

**Centred, and this is the one place on the site where it is.** §2.7 prefers
asymmetry, and it is right everywhere there is a second column to balance
against. There is none here: one sentence and one button, alone, off to the
left, with the whole right half empty is not asymmetry, it is a page that
started and gave up. `.hero { text-align: center }` plus `margin: 0 auto` on
`.hero-headline` (900px) and `.hero-desc` (660px).

**One action. The button.** `.btn .btn-primary .btn-lg` — an `--accent-solid`
cobalt fill under a white label, 5.46:1 in both themes. It shipped red until
TRA-739 (§0 is why it is not red), then spent one release as a full inversion,
which fixed the meaning but read as one more monochrome slab on a monochrome
page and stopped being the loudest thing on the screen. Cobalt is the system
accent (§0) and this button is the main place it is spent. It ships labelled `Download` pointing at `/releases/latest` so it works
without JS (TRA-440), and `resolveDownload()` narrows it to a single file and
renames it only once it has found that file in the release JSON. The label names
the exact machine — `Download for Mac (Apple Silicon)`, `Download for Mac
(Intel)`, `Download for Windows` — never a platform the page has not confirmed
and never an architecture the visitor is left to guess at.

**Three mono caps rows, one treatment, three greys.** `.hero-eyebrow`
(`--text-secondary`, above the headline, carrying the service label and the
version + licence the old two-column `.hero-meta` used to spend a whole row on),
`.hero-alt` (`--text-secondary`, the platforms the button is not offering) and
`.hero-trust` (`--text-disabled`, at the fold). Distance from the button and
grey level are the only things separating them; do not give any of them their
own font size, weight or border.

**Platform detection covers macOS arm64, macOS x64 and Windows x64** (TRA-738).
It used to `btn.remove()` on everything that was not a Mac, which left every
Windows visitor with no button at all while the release had shipped
`trace-mcp.Setup.<version>.exe` since v3.14.0. arm64-unless-proven-Intel is the
Mac default and stays that way. On Linux the button is still removed — the
release has no installer to offer there, and the npm line below is the whole
install path.

**`.hero-alt` holds exactly the platforms the button is not offering**, plus
`all downloads`. On an Apple Silicon Mac that is `Intel Mac · Windows · all
downloads`; on Windows, both Macs. Each is a direct link to a file once JS has
resolved the release, and a link to the releases page before that — never a
question the visitor has to answer before downloading (TRA-440).

**`.hero-install` is a `<button>`, and it sits on its own row below the
button, not beside it.** A `<span onclick>` gave the copy action no tab stop,
no focus ring and nothing for a screen reader; the `$` is `aria-hidden`, the
`copy` label is `aria-live="polite"` so `copied` is announced. It keeps its
technical 8px box on `--surface` — but side by side with the filled pill that box
read as a second button of equal weight, which is what this hero keeps being
pulled back into, so it is a full row down instead. That verdict predates the
inversion and survives it: an outlined box next to a solid block of the
opposite end still reads as a second button when the two sit side by side. Off macOS and Windows it
gains `.is-primary` and is the hero's only action.

**The headline is measured, not guessed.** `clamp(36px, 5.2vw, 60px)` over
`max-width: 900px` is the pair that breaks the current wording after
"intelligence" and nowhere else; at `72px/820px` it ran to three lines and split
"AI coding agents" across two of them. Change the wording, re-measure the line
count at 1440px and at 390px.

**The mono caps row stacks below 700px, and is never a wrapped flex row on a
phone** (TRA-607, inherited by `.hero-note` in TRA-738). A `flex-wrap` row of
mono caps always fails the same way: it wraps mid-list and a `.dot` separator
ends the line. Measured on the last box of each line, not judged by eye — on
the row this replaced a dot was the rightmost box at 660, 600, 520, 430, 390,
360 and 320px, and at none of 700, 760, 820, 900, 1024 or 1440px. This is §9's
"no label breaks into fragments" rule one section up the page. At 700px and
below all three rows keep their dots hidden and their gaps tightened, so a wrap
never lands on a separator.

`@media (max-width: 700px)` includes 700px itself, so the stacked form starts
*at* 700px while the defect it fixes starts just below — the rule is applied
one tested step wider than the failure. Inline behaviour is what you get above
700px, not at it.

**The first screen fits a 13" laptop, and that is a measurement.** At
1440×900 with the header, `.hero` bottom sits at 720px, the button at 483px and
the trust line at 656px — 180px of clearance, with the metrics strip already
showing underneath.
Re-measure `getBoundingClientRect().bottom` on `.hero` after any change to the
headline wording, the description, or the hero's padding; a first screen whose
button falls below 900px is a regression however good it looks at 1440×1080.

---

## 9. The landing footer

The counterpart to §2's `See also` block: the same 22 pages, from the same
`docs/_data/docs_nav.yml`, on a page that does not use the layout. It used to
be two hand-written columns naming 12 of them, and it had drifted past the
whole `/vs/` cluster (TRA-629). **Never hand-write this list.** Which pages
are in it, what they are called and in what order is the SEO agent's, exactly
as in §2 — this section governs the layout only.

**`/ Docs` spans two of the four grid tracks, and two rows.** Two tracks
because 22 links in one track runs 22 rows deep beside a 4-row `/ Product`.
Two rows because `/ Product` + `/ Docs` + `/ Source` already fill row one, so
`/ Contact` lands on a row of its own with three empty tracks beside it;
letting `/ Docs` claim the second row pulls `/ Contact` up under `/ Product`
and takes 129px of dead space out of the footer. Below 700px the grid is two
tracks, `/ Docs` takes a full row anyway, and the span is reset to `auto`.

**The sub-columns are `columns`, not a grid** — the one place on the site
where multi-column beats it. Its sub-columns read top-to-bottom, the same
direction as the plain `/ Product` and `/ Source` lists either side; a
row-flow grid puts items 1, 4, 7 down the first sub-column, which scatters
`docs_nav.yml`'s order — the five `/vs/` pages landed one per row across all
three. That order is not ours to scatter. It also removes the ragged rows: two
labels wrap to a second line, and in a grid they set the height of every cell
in their row, opening 48px gaps that read as group breaks (§1: 32–48px means
"new group starts here") where nothing begins.

§2's `See also` block keeps its grid. It is a standalone block with no
vertical list beside it to disagree with, and it skips the current page, so a
column count is not stable there anyway.

**The floor is 176px, and it is measured.** `vs codebase-memory-mcp` sets on
one line at 173px. 160px looks fine at 1440px only because the sub-column
happens to resolve to 176 there; between roughly 1184px and 1262px of viewport
it resolves to 163 and the label breaks into two fragments. Dropping to two
sub-columns is the better answer, which is what the floor buys. Re-measure it
against the longest label whenever `docs_nav.yml` gains one — the intrinsic
width of a Space Mono 12px label at `0.04em`, not an estimate.

`PR review context benchmark` and `Cut Claude Code token usage` are 212px and
take two lines in every layout; a sub-column wide enough for them fits two,
not three. `break-inside: avoid` keeps each one whole so it still reads as a
single target, the same one-cell-per-link rule as §2.

---

## 10. The README header

The README is a site surface too — it is the first screen for anyone arriving
from GitHub, and GitHub's own stylesheet is the one thing we cannot override.
So the header is **pictures**, not markup GitHub gets to style. Regenerate with:

```
node scripts/gen-readme-banner.mjs
```

**PNG @2x, never SVG.** GitHub renders README images in an isolated context
where an SVG's `@font-face` never loads: Space Grotesk falls back to a system
font and the layout shifts. The script renders real HTML in headless Chrome
with the self-hosted `docs/fonts/*.woff2`, at `deviceScaleFactor: 2`. Verify
on github.com itself, not in a local Markdown preview — the local preview does
load the fonts and will tell you it is fine when it is not.

**Both appearances, one `<picture>`.** Each image ships as
`<source media="(prefers-color-scheme: light)">` plus a dark `<img>`. GitHub
honours it. Never stack the two.

**Two cuts of the banner, one for the phone.** GitHub scales README images to
the column, and on a phone that column is about 390 CSS px — the 1200px banner
arrives at 0.33 scale, which puts its 25px tagline at 8px and the receipt below
legibility. So the banner also ships at 480 CSS px in one column, selected with
`<source media="(max-width: 500px)">` (plus the light pair) placed **above** the
theme source: the first matching source wins, so a theme source above them takes
the phone back to the wide cut. `media` is the only responsive lever GitHub's
sanitiser leaves in a README, and it takes any media query, not just
`prefers-color-scheme`. One catch, and it is not cosmetic: GitHub wraps every
README `<picture>` in a `<themed-picture>` element that substring-matches
`(prefers-color-scheme: light)` and, for a reader who pinned Light in Appearance,
rewrites that source's media to match every viewport. Written with the space, the
compound narrow source is classified as themed and wins on a 1440px desktop — the
phone cut at 750px. So the narrow one is spelled `(prefers-color-scheme:light)`,
no space: still valid CSS, still preserved by the sanitiser, invisible to that
match. The wide source keeps the spaced form, where the rewrite is what a pinned
reader wants. The narrow cut is a CSS modifier in the generator
(`.banner.narrow`) overriding only the sizes that break — palette and copy stay
shared, so a wording change lands in both. `tests/docs/readme-header-images.test.ts`
guards the files, both cuts, and that ordering.

**The buttons need no narrow cut.** At `width="250"` a button plate is already
narrower than a phone column, so the three simply stack at full size.

**Every number is generated.** The banner reads `docs/_data/counts.yml` and
`docs/_data/pr_context_bench.json` — the same sources the site uses. A hand-
retouched PNG turns "177 tools" into a silent lie two releases later. This is
the one place in the site where extra code is the right answer.

**The words have to exist as text as well.** A picture is invisible to search
and to a screen reader. So: a meaningful `alt` carrying the full claim, plus
the description sentence kept as a real paragraph below the buttons. The two
say the same thing; change them together.

**Geometry.** Banner 1200×340 CSS px, rendered at 2×, shown at `width="750"`.
Three button plates of 400×108, shown at `width="250"` each — 750 total, so
they line up under the banner and do not wrap: GitHub's README column is about
807px on a wide window and narrower on the readme tab, and a 900px strip wraps
the third button onto its own line. Each plate carries its own background so the
strip continues the banner instead of floating on GitHub's canvas; **keep the
three anchors on one source line**, because any whitespace between them paints
a seam of GitHub's background through the strip.

**Buttons.** macOS first and filled with `--accent-solid` — it is the platform
most visitors are on and the only one with a signed installer. Windows and npm
are outlined. Sub-labels are full white on the fill (5.46:1); the tinted
`#DCE5FF` that reads better as hierarchy is 4.34 and fails.

**The button label is body type, not a service label.** Space Grotesk 600 at
17px in sentence case, tracking `-0.01em`. It shipped once as Space Mono caps
at 14px and was unreadable, for a reason worth keeping: a monospace gives every
letter the same width and caps removes the ascenders and descenders, so both
cues a reader recognises a whole word by are gone at once. The 10px technical
sub-label stays monospaced caps — it is short, and it holds the link to the
site's language.

**A shell command is never set in caps.** The npm button read
`NPM INSTALL -G TRACE-MCP`, and `-G` is a different npm flag from `-g`: anyone
retyping it off the picture gets an error. The command belongs in the sub-label,
lowercase, no tracking, exactly as a terminal shows it (`.btn .s.cmd`), with
`Install via npm` as the label above it.

**Weight.** The dot lattice is most of the file, and it quantises to a palette
with no visible loss: the generator pipes each PNG through `pngquant` when it
is on `PATH` — 230 KB → 80 KB for the banner, 25 KB → 7 KB per button, so one
appearance of the whole header is ~104 KB. `pngquant` is optional so a
contributor without it can still regenerate; the run says so when it skips.

**Badges: five maximum, real sources only.** Currently three — CI, npm version,
licence. No badge for a number we could state in words.

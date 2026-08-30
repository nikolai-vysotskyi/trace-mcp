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
lattice, near-monochrome, red as the single accent, generous air, no gradients,
no shadows.

---

## 1. Tokens

Two surfaces implement these: `docs/index.html` (landing, inline `<style>`) and
`docs/assets/css/docs.css` (every documentation page). The values must match.

| Token | Dark | Light |
|---|---|---|
| `--black` (page) | `#000000` | `#F5F5F5` |
| `--surface` | `#111111` | `#FFFFFF` |
| `--surface-raised` | `#1A1A1A` | `#F0F0F0` |
| `--border` | `#222222` | `#E8E8E8` |
| `--border-visible` | `#333333` | `#CCCCCC` |
| `--text-disabled` | `#666666` | `#767676` |
| `--text-secondary` | `#999999` | `#595959` |
| `--text-primary` | `#E8E8E8` | `#1A1A1A` |
| `--text-display` | `#FFFFFF` | `#000000` |
| `--accent` | `#D71921` | `#B3151C` |

Two light-mode values intentionally diverge from the landing page's inline
copy, both for contrast on `#F5F5F5`:

- `--text-disabled` is `#767676` (4.54:1), not `#999999` (2.8:1).
- `--accent` is `#B3151C` (6.1:1) for body-size link text; `#D71921` is 4.3:1,
  which passes for large text but not for a 16px inline link.

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
- Links are `--accent` with a 40%-opacity underline that goes solid on hover.
  Red is the only chrome colour on a doc page.
- Tables: **no zebra striping.** Rows separate on a `--border` hairline; the
  head is a Space Mono 10px caps label, not a bold band. Every table is
  wrapped in a focusable `.table-scroll` region by the layout script, so a
  wide tool table scrolls itself instead of the page.
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
- A second accent colour. Red is the only one.
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
- [ ] Body text ≥ 4.5:1, large text ≥ 3:1, in both.

**Widths**
- [ ] Desktop (1440px) and narrow (≤500px) both screenshotted.
- [ ] `document.documentElement.scrollWidth === window.innerWidth` at the
      narrow width — no sideways page scroll.
- [ ] Wide tables scroll themselves, not the page.
- [ ] Every region where `scrollWidth > clientWidth` shows the `scroll →`
      label, and every region that fits does not — count both, at 1440px and
      at 390px. A region is any element that scrolls itself: the table
      wrapper, every `pre`, **and the landing page's quickstart
      `.terminal-body`**. Code blocks were read out of this line once and
      shipped clipped and unlabelled for months; the landing terminal was
      missed twice more, because the fix each time landed in `docs.css` and
      the landing page has its own copy of everything (§7).

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

That duplication is not only a maintenance cost — it is where fixes go
missing. Twice now a scroll-region rule shipped to all 17 doc pages and left
the landing page, the busiest page on the site, behaving the old way. The
landing's quickstart terminal is a scroll region: it carries its own
`scroll →` label on the terminal header bezel (11px, inheriting that row's
Space Mono caps, rather than the 10px label a doc page puts above the
region), becomes a tab stop only while it actually overflows, and is named in
the page's own `:where(...):focus-visible` list. **Any rule added to
`docs/assets/css/docs.css` for a scroll region has to be checked against the
landing page in the same PR.**

The same duplication applies to the accessibility layer, and it is easier to
forget than a token because nothing looks wrong until you press Tab. The
landing page must carry its own copy of the skip link, the
`:where(a, button, summary):focus-visible` ring, and the
`prefers-reduced-motion` block. It shipped without all three while every doc
page had them, so the busiest page on the site was the only one handing
readers Chrome's blue ring and playing its count-up animation at people who
asked the OS for less motion.

The CSS `prefers-reduced-motion` block stops transitions and keyframes, not
motion driven from JavaScript. The landing page animates a stat count-up over
1400ms and staggers a segmented bar at 30ms per cell from `setTimeout`; both
read a `reduceMotion` flag off `matchMedia`. Any new JS-driven motion has to
read it too — the media query alone will not catch it.

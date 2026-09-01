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
A token that exists in only one of them is a component token and must say so
here — otherwise it reads as drift. There is exactly one: `--accent-solid`.

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
| `--accent` | `#E54047` | 5.16 / 4.64 / **4.27** | `#B3151C` | 6.33 / 6.91 / **6.06** |

**`--surface-raised` is always the worst of the three,** in both themes — it is
the lightest surface in dark and the darkest in light, so it is the one every
foreground has the least room against. Never quote a token's ratio from `page`
because it is the biggest number.

`--accent` in dark is the one token that does **not** clear 4.5:1 everywhere:
`#E54047` on `--surface-raised` is 4.27. Red text is therefore not allowed on
`--surface-raised` in dark. It is not currently used there anywhere; the
contrast sweep below is what keeps it that way. Raising the red further to
clear `#1A1A1A` too would push it to roughly `#EA5057`, which reads pink
rather than red, and red being *this* red is not negotiable.

**`--accent-solid` `#D71921` is not in the table above and is not a shared
token.** It is the brand red as a **fill** — the landing's primary button —
so it is never a foreground and has no ratio against a surface. The only
ratio it has is white text on it: **5.18**. It lives in `docs/index.html`
alone and is deliberately absent from `docs/assets/css/docs.css`, which has
no filled-red component; adding it there would be a dead token. If a doc page
ever grows one, define it there in the same PR.

`--accent` (link/glyph red) is lighter in dark and darker in light because a
foreground has to fight its background; a fill does not. Never use
`--accent-solid` as a text colour, and never use `--accent` as a fill under
white text — `#E54047` behind white is 4.07 and fails.

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
- A second accent colour. Red is the only one. `--accent` and `--accent-solid`
  are two lightnesses of the same red for two jobs (§1), not two accents.
- `--accent` as a fill under white text, or `--accent-solid` as a text colour.
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
      decoration, not a way to silence a failure. Only two exist: the YC badge
      mark and the landing's 400px ghost `94%`.

**Widths**
- [ ] Desktop (1440px) and narrow (≤500px) both screenshotted.
- [ ] `document.documentElement.scrollWidth === window.innerWidth` at the
      narrow width — no sideways page scroll.
- [ ] Wide tables scroll themselves, not the page.
- [ ] Every region where `scrollWidth > clientWidth` shows the `scroll →`
      label, and every region that fits does not — count both, at 1440px and
      at 390px. A region is any element that scrolls itself: the table
      wrapper *and* every `pre` *and* the landing page's `.terminal-body`.
      Code blocks and the landing terminal were each read out of this line
      once and shipped clipped and unlabelled for months.

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

**Two actions. Never three** (TRA-609). The hero carries the DMG button and the
install command, and nothing else. It shipped with four competing elements —
`Download for macOS`, `Analyze your AI system`, `View on GitHub`, and the install
line — which is not a hierarchy, it is a row. Both of the removed buttons already
had a home: the header links to the repo and to `#install`, on desktop and on a
phone. Check that before adding a fifth thing back.

**The two actions do not look alike.** The DMG is `.btn .btn-primary .btn-lg` — a
red pill, the one red on the screen. The install line is `.hero-install` — a
technical 8px box on `--surface` with a `$` prompt, the command, and a `COPY`
label behind a hairline. A pill next to a pill reads as two buttons of equal
weight; that is what the dashed pill it replaced did.

**`.hero-install` is a `<button>`.** It was a `<span onclick>`, so the only way to
copy the command was a mouse — no tab stop, no focus ring, nothing for a screen
reader. The `$` is `aria-hidden`; the `copy` label is `aria-live="polite"` so the
`copied` state is announced.

**It is visible on a phone.** It used to be `display: none` under 700px, which
left a phone visitor with a DMG button and no copyable command at all. Below
700px the row becomes one column, both actions go full width, and `.copy` pins
right on `margin-left: auto`.

**Off macOS the DMG button is removed** (TRA-440) and `.hero-install` gains
`.is-primary`, which raises its border to `--text-display`. Without that the
hero has no primary action anywhere outside a Mac. When you read that border
back in the browser, wait out the 200ms `border-color` transition — a
`getComputedStyle` fired in the same tick as the `classList.add` returns the
*start* colour and looks like the rule never matched.

**The headline is measured, not guessed.** `clamp(36px, 5.2vw, 60px)` over
`max-width: 900px` is the pair that breaks the current wording after
"intelligence" and nowhere else; at `72px/820px` it ran to three lines and split
"AI coding agents" across two of them. Change the wording, re-measure the line
count at 1440px and at 390px.

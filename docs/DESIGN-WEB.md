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
- Code: `--surface` fill, `--border` outline, 4px radius inline / 8px block.
  Syntax highlighting differentiates by **weight and opacity**, not hue.

---

## 3. Screenshots of the app

The capture script `scripts/capture-screenshots.mjs` is owned by the
Design/UX Agent. **Do not write another capture path and do not edit that
script.** Need a different angle or a new surface? File an issue against it.

This file governs presentation only:

- Shot from the real Electron window — traffic lights and rounded corners
  must be present. No traffic lights means it came from a browser: reject it.
- Never butt two screenshots together. Minimum 24px between them.
- One border (`--border`) and one radius (8px) for every image on the site.
- No visible errors, skeletons, scratch directories, or personal paths.
- Caption in Space Mono 11px caps at `--text-secondary`, below the image.

---

## 4. Never

- Gradients in UI chrome.
- Shadows, blur as decoration (the header's backdrop blur is the one exception).
- Zebra-striped tables.
- Skeleton loaders — use `[LOADING...]`.
- Toast popups — use inline `[SAVED]` / `[ERROR: …]`.
- Filled or multi-colour icons, emoji as UI.
- A second accent colour. Red is the only one.
- `border-radius` over 16px on a card.
- Spring or bounce easing. Only `cubic-bezier(0.25, 0.1, 0.25, 1)`.
- Parallax or scroll-jacking.
- Re-linking the Primer stylesheet, or adding a Google Fonts `<link>`.
- Shipping a colour change verified in one theme only.

---

## 5. Review checklist

Run before opening any PR that touches the site. An assertion about
appearance without a screenshot or a measurement is not a finding.

**Both themes**
- [ ] Dark and light both screenshotted, no unstyled flash on load.
- [ ] Theme choice survives landing → doc page navigation.
- [ ] Body text ≥ 4.5:1, large text ≥ 3:1, in both.

**Widths**
- [ ] Desktop (1440px) and narrow (≤500px) both screenshotted.
- [ ] `document.documentElement.scrollWidth === window.innerWidth` at the
      narrow width — no sideways page scroll.
- [ ] Wide tables scroll themselves, not the page.

**Type & spacing**
- [ ] Within the 2 families / 3 sizes / 2 weights budget.
- [ ] Service labels are Space Mono caps; nothing else is.
- [ ] Exactly one h1; section breaks are 80px, not ad hoc.
- [ ] Exactly one deliberate pattern break on the page.

**Accessibility**
- [ ] Visible focus ring on every link, button, and scroll region.
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

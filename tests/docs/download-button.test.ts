import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Landing-page download button guard (TRA-440).
 *
 * The hero's "Download for macOS" button resolves the release asset at runtime
 * from the GitHub API. Two properties have to hold or the button quietly rots:
 *
 *  - No version string is written into the markup. A hardcoded
 *    `trace-mcp-3.9.0-arm64.dmg` keeps 404-ing from the next release onwards,
 *    and nobody notices because the button still looks fine.
 *  - The href in the source is the releases page, not `#` or `javascript:`.
 *    That is what a visitor without JavaScript gets, and it has to work.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const INDEX = join(REPO_ROOT, 'docs', 'index.html');

describe('docs landing page — macOS download button', () => {
  const html = readFileSync(INDEX, 'utf-8');
  const button = html.match(/<a[^>]*\bdata-dmg\b[^>]*>/)?.[0];

  it('renders a download button in the markup', () => {
    expect(button, 'no [data-dmg] anchor in docs/index.html').toBeDefined();
  });

  it('falls back to the releases page without JavaScript', () => {
    expect(button).toMatch(
      /href="https:\/\/github\.com\/nikolai-vysotskyi\/trace-mcp\/releases\/latest"/,
    );
  });

  it('hardcodes no DMG filename or version anywhere on the page', () => {
    // Asset names are `trace-mcp-<version>-<arch>.dmg`; the only correct source
    // for one is the release JSON the page fetches at runtime.
    expect(html).not.toMatch(/trace-mcp-\d+\.\d+\.\d+[-\w]*\.(dmg|zip)/);
  });

  it('offers the other platforms under the button, not as a choice in front of it', () => {
    // The alternatives are a quiet row below the single button (TRA-738), and they
    // are links, so a visitor without JS still reaches every build.
    const alt = html.match(/<p class="hero-alt">[\s\S]*?<\/p>/)?.[0];
    expect(alt, 'no .hero-alt row in docs/index.html').toBeDefined();
    expect(alt!).toMatch(/data-alt-1/);
    expect(alt!).toMatch(/data-alt-2/);
    expect(alt!).toMatch(/all downloads/);
    // Every one of them points somewhere real without JavaScript.
    expect(alt!.match(/href="https:\/\/github\.com[^"]+"/g)?.length).toBe(3);
  });

  it('resolves a Windows installer too, not only a DMG (TRA-738)', () => {
    // `btn.remove()` on every non-Mac left Windows visitors with no button at all,
    // while the release has shipped an .exe since v3.14.0.
    expect(html).toMatch(/const isWin = /);
    expect(html).toMatch(/\\\.exe\$/);
    expect(html).toMatch(/Download for Windows/);
  });

  it('names the architecture on the button, not just the platform', () => {
    // "Download for macOS" sends an Intel Mac a file it cannot tell apart from the
    // arm64 one until it has downloaded it.
    expect(html).toMatch(/Download for Mac \(/);
    expect(html).toMatch(/Apple Silicon/);
    expect(html).toMatch(/Intel/);
  });

  it('defaults to arm64 when architecture detection is inconclusive', () => {
    const fn = html.match(/const detectArch = async \(\) => \{[\s\S]*?\n    \};/)?.[0];
    expect(fn, 'detectArch() not found — the button no longer detects architecture').toBeDefined();
    expect(fn!.trimEnd().endsWith("return 'arm64';\n    };")).toBe(true);
  });
});

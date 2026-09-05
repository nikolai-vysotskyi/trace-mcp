import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The home page has to name its category in the words people type.
 *
 * DataForSEO (Google Ads, US/English, 2026-09-05) returns no volume record at
 * all for `precomputed code intelligence` or `code intelligence for ai agents`
 * — they are our coinages, so the only distinctive indexable token on the page
 * was the brand string. GSC for the same 30 days shows what that costs: the two
 * largest non-brand impression sources on the home page were `traceix mcp` (61)
 * and `mcp tracing` (50), 111 impressions and zero clicks, both name lookalikes
 * Google matched because there was no category phrase to match instead.
 *
 * `code graph mcp` (70/mo, 10 → 140 over twelve months, LOW competition) is the
 * cluster we can actually win: its live top-20 is standalone product sites, not
 * listicles, and `comparisons.html` already ranks #1–2 on that vocabulary's long
 * tail. This test guards eligibility for its head term — a copy pass that
 * reverts these strings to positioning prose would take it away silently, with
 * no other test failing. (TRA-950)
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const index = readFileSync(join(REPO_ROOT, 'docs/index.html'), 'utf-8');

describe('the home page names the code graph category', () => {
  it('the title and og:title carry the head term', () => {
    expect(index).toMatch(/<title>[^<]*code graph MCP server[^<]*<\/title>/);
    expect(index).toMatch(/property="og:title" content="[^"]*code graph MCP server[^"]*"/);
  });

  it('the meta description carries it, not only the number', () => {
    expect(index).toMatch(/name="description" content="[^"]*code graph MCP server[^"]*"/);
  });

  it('the visible body copy carries it, not only the metadata', () => {
    // Tags stripped: metadata alone matches the SERP snippet while the page a
    // visitor lands on says something else, which is what Google demotes. It
    // lives on the graph section's own heading, not in the hero — the hero
    // sentence is the position claim and `ops/positioning.md` forbids narrowing
    // it back to the graph.
    const body = index.slice(index.indexOf('<body'));
    const visible = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    expect(visible).toMatch(/code graph/i);
  });
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', '..', 'scripts', 'verify-release-assets.mjs');

const { auditReleaseAssets, expectedAssets } = (await import(MODULE_PATH)) as {
  auditReleaseAssets: (version: string, assets: { name: string; size?: number }[]) => string[];
  expectedAssets: (version: string) => string[];
};

/** The shape `gh release view <tag> --json assets -q '.assets'` emits. */
function completeRelease(version: string) {
  return expectedAssets(version).map((name) => ({
    name,
    size: name.endsWith('.sha256') ? 65 : 110_897_057,
  }));
}

describe('verify-release-assets', () => {
  it('accepts a release carrying every artifact and checksum', () => {
    expect(auditReleaseAssets('3.1.1', completeRelease('3.1.1'))).toEqual([]);
  });

  it('names the six zips/DMGs/installers plus one .sha256 each', () => {
    expect(expectedAssets('3.1.1')).toEqual([
      'trace-mcp-3.1.1-arm64-mac.zip',
      'trace-mcp-3.1.1-arm64-mac.zip.sha256',
      'trace-mcp-3.1.1-mac.zip',
      'trace-mcp-3.1.1-mac.zip.sha256',
      'trace-mcp-3.1.1-arm64.dmg',
      'trace-mcp-3.1.1-arm64.dmg.sha256',
      'trace-mcp-3.1.1-x64.dmg',
      'trace-mcp-3.1.1-x64.dmg.sha256',
      'trace-mcp-3.1.1-win.zip',
      'trace-mcp-3.1.1-win.zip.sha256',
      'trace-mcp.Setup.3.1.1.exe',
      'trace-mcp.Setup.3.1.1.exe.sha256',
    ]);
  });

  // The DMG is what a browser download gets; losing it strands that arch.
  it('fails when a macOS DMG is missing', () => {
    const assets = completeRelease('3.1.1').filter(
      (a) => !a.name.startsWith('trace-mcp-3.1.1-arm64.dmg'),
    );
    expect(auditReleaseAssets('3.1.1', assets)).toEqual([
      'missing: trace-mcp-3.1.1-arm64.dmg',
      'missing: trace-mcp-3.1.1-arm64.dmg.sha256',
    ]);
  });

  // The failure this gate exists for: one matrix leg does not upload, npm
  // publishes anyway, and every Intel Mac silently keeps the old bundle.
  it('fails when a single arch is missing', () => {
    const assets = completeRelease('3.1.1').filter(
      (a) => !a.name.startsWith('trace-mcp-3.1.1-mac'),
    );
    expect(auditReleaseAssets('3.1.1', assets)).toEqual([
      'missing: trace-mcp-3.1.1-mac.zip',
      'missing: trace-mcp-3.1.1-mac.zip.sha256',
    ]);
  });

  // postinstall aborts without a sibling checksum, leaving the old .app in place.
  it('fails when a zip is present but its checksum is not', () => {
    const assets = completeRelease('3.1.1').filter(
      (a) => a.name !== 'trace-mcp-3.1.1-arm64-mac.zip.sha256',
    );
    expect(auditReleaseAssets('3.1.1', assets)).toEqual([
      'missing: trace-mcp-3.1.1-arm64-mac.zip.sha256',
    ]);
  });

  it('fails on a truncated upload that kept its name', () => {
    const assets = completeRelease('3.1.1').map((a) =>
      a.name === 'trace-mcp-3.1.1-win.zip' ? { ...a, size: 0 } : a,
    );
    expect(auditReleaseAssets('3.1.1', assets)).toEqual([
      'empty or truncated: trace-mcp-3.1.1-win.zip (0 bytes)',
    ]);
  });

  it('fails on a checksum file too short to hold a sha256 digest', () => {
    const assets = completeRelease('3.1.1').map((a) =>
      a.name === 'trace-mcp-3.1.1-win.zip.sha256' ? { ...a, size: 12 } : a,
    );
    expect(auditReleaseAssets('3.1.1', assets)).toEqual([
      'empty or truncated: trace-mcp-3.1.1-win.zip.sha256 (12 bytes)',
    ]);
  });

  // A release-please tag is `v3.1.1`; asset names use the bare version. Passing
  // the tag through unstripped would report every asset as missing.
  it('reports everything missing when handed a tag instead of a version', () => {
    expect(auditReleaseAssets('v3.1.1', completeRelease('3.1.1'))).toHaveLength(12);
  });
});

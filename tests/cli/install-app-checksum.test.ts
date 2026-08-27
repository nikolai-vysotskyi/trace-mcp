/**
 * Regression tests for TRA-219: `trace-mcp install-app` downloaded a release
 * asset and immediately unzipped it (macOS) or executed it (Windows NSIS
 * `.exe`) without ever verifying its SHA-256, while the sibling auto-update
 * path (`scripts/postinstall-app.mjs`) has always verified and aborted on a
 * missing or mismatched digest.
 *
 * `findChecksumAsset`, `parseSha256Manifest`, and `assertDigestMatches` are
 * exported so the fail-closed behaviour can be asserted directly, without
 * mocking the network/download layer — same approach as
 * install-app-security.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  assertDigestMatches,
  findChecksumAsset,
  parseSha256Manifest,
} from '../../src/cli/install-app.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

// Real asset shapes, confirmed against the v1.48.x releases.
const MAC_ASSET = 'trace-mcp-1.48.5-arm64-mac.zip';
const WIN_EXE_ASSET = 'trace-mcp.Setup.1.48.5.exe';

describe('install-app checksum verification (TRA-219)', () => {
  describe('findChecksumAsset', () => {
    it('finds the .sha256 sibling for a macOS zip', () => {
      const assets = [
        { name: MAC_ASSET, url: 'https://x/mac.zip' },
        { name: `${MAC_ASSET}.sha256`, url: 'https://x/mac.zip.sha256' },
      ];
      expect(findChecksumAsset(assets, MAC_ASSET)?.url).toBe('https://x/mac.zip.sha256');
    });

    it('finds the .sha256 sibling for the Windows NSIS installer', () => {
      const assets = [
        { name: WIN_EXE_ASSET, url: 'https://x/setup.exe' },
        { name: `${WIN_EXE_ASSET}.sha256`, url: 'https://x/setup.exe.sha256' },
      ];
      expect(findChecksumAsset(assets, WIN_EXE_ASSET)?.url).toBe('https://x/setup.exe.sha256');
    });

    it('returns undefined when no checksum is published (install must fail closed)', () => {
      const assets = [
        { name: MAC_ASSET, url: 'https://x/mac.zip' },
        { name: WIN_EXE_ASSET, url: 'https://x/setup.exe' },
        // A checksum for a *different* asset must not be accepted.
        { name: 'trace-mcp-1.48.5-mac.zip.sha256', url: 'https://x/other.sha256' },
      ];
      expect(findChecksumAsset(assets, MAC_ASSET)).toBeUndefined();
      expect(findChecksumAsset(assets, WIN_EXE_ASSET)).toBeUndefined();
    });
  });

  describe('parseSha256Manifest', () => {
    it('accepts the bare-digest format the releases actually publish', () => {
      expect(parseSha256Manifest(`${DIGEST}\n`, MAC_ASSET)).toBe(DIGEST);
    });

    it('accepts sha256sum `<digest>  <filename>` lines matching the asset', () => {
      expect(parseSha256Manifest(`${DIGEST}  ${MAC_ASSET}\n`, MAC_ASSET)).toBe(DIGEST);
      expect(parseSha256Manifest(`${DIGEST} *${WIN_EXE_ASSET}\r\n`, WIN_EXE_ASSET)).toBe(DIGEST);
    });

    it('rejects a sha256sum line naming a different asset', () => {
      expect(parseSha256Manifest(`${DIGEST}  some-other-asset.zip`, MAC_ASSET)).toBeNull();
    });

    it('returns null for garbage', () => {
      expect(parseSha256Manifest('not a digest', MAC_ASSET)).toBeNull();
      expect(parseSha256Manifest('', MAC_ASSET)).toBeNull();
    });
  });

  describe('assertDigestMatches', () => {
    it('passes when the macOS zip digest matches', () => {
      expect(() => assertDigestMatches(DIGEST, `${DIGEST}\n`, MAC_ASSET)).not.toThrow();
    });

    it('is case-insensitive about the digest encoding', () => {
      expect(() =>
        assertDigestMatches(DIGEST.toUpperCase(), `${DIGEST}\n`, MAC_ASSET),
      ).not.toThrow();
    });

    it('throws on a mismatched macOS zip digest', () => {
      expect(() => assertDigestMatches(OTHER_DIGEST, `${DIGEST}\n`, MAC_ASSET)).toThrow(
        /Checksum mismatch/,
      );
    });

    it('throws on a mismatched Windows installer digest (never executes the .exe)', () => {
      expect(() =>
        assertDigestMatches(OTHER_DIGEST, `${DIGEST}  ${WIN_EXE_ASSET}`, WIN_EXE_ASSET),
      ).toThrow(/Checksum mismatch/);
    });

    it('throws when the manifest is unreadable rather than falling through', () => {
      expect(() => assertDigestMatches(DIGEST, 'corrupted', MAC_ASSET)).toThrow(/unreadable/);
    });
  });
});

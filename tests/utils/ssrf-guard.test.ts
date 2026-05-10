import { describe, expect, it } from 'vitest';
import {
  checkOutboundUrl,
  checkOutboundUrlSync,
  isExplicitlyLocalUrl,
  safeFetch,
} from '../../src/utils/ssrf-guard.js';

describe('checkOutboundUrlSync — literal-IP shape checks', () => {
  it('accepts public IPv4 literals', () => {
    expect(checkOutboundUrlSync('https://1.1.1.1/').ok).toBe(true);
    expect(checkOutboundUrlSync('https://8.8.8.8/').ok).toBe(true);
  });

  it('rejects RFC 1918 private addresses', () => {
    expect(checkOutboundUrlSync('http://10.0.0.1/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://172.16.5.5/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://192.168.0.1/').ok).toBe(false);
  });

  it('rejects loopback', () => {
    expect(checkOutboundUrlSync('http://127.0.0.1/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://127.42.42.42/').ok).toBe(false);
  });

  it('rejects link-local (cloud metadata)', () => {
    expect(checkOutboundUrlSync('http://169.254.169.254/').ok).toBe(false);
  });

  it('rejects RFC 6598 carrier-grade NAT (graphify v0.7.9)', () => {
    expect(checkOutboundUrlSync('http://100.64.0.1/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://100.127.255.254/').ok).toBe(false);
  });

  it('accepts an address adjacent to but outside the CGN range', () => {
    expect(checkOutboundUrlSync('http://100.63.255.255/').ok).toBe(true);
    expect(checkOutboundUrlSync('http://100.128.0.1/').ok).toBe(true);
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(checkOutboundUrlSync('http://[::1]/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://[fe80::1]/').ok).toBe(false);
    expect(checkOutboundUrlSync('http://[fc00::1]/').ok).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 of private address', () => {
    expect(checkOutboundUrlSync('http://[::ffff:127.0.0.1]/').ok).toBe(false);
  });

  it('rejects non-http schemes by default', () => {
    expect(checkOutboundUrlSync('file:///etc/passwd').ok).toBe(false);
    expect(checkOutboundUrlSync('gopher://1.1.1.1/').ok).toBe(false);
    expect(checkOutboundUrlSync('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(checkOutboundUrlSync('not a url').ok).toBe(false);
    expect(checkOutboundUrlSync('').ok).toBe(false);
  });
});

describe('checkOutboundUrlSync — allowPrivateNetworks opt-in', () => {
  it('accepts loopback / RFC 1918 / Tailscale CGN when explicitly allowed', () => {
    const opts = { allowPrivateNetworks: true };
    // typical local LLM endpoints
    expect(checkOutboundUrlSync('http://127.0.0.1:11434/', opts).ok).toBe(true);
    expect(checkOutboundUrlSync('http://192.168.1.50:1234/', opts).ok).toBe(true);
    expect(checkOutboundUrlSync('http://10.0.0.20:8080/', opts).ok).toBe(true);
    // Tailscale homelab — mempalace #1225
    expect(checkOutboundUrlSync('http://100.64.0.5:11434/', opts).ok).toBe(true);
    // IPv6 ULA + loopback
    expect(checkOutboundUrlSync('http://[::1]/', opts).ok).toBe(true);
    expect(checkOutboundUrlSync('http://[fc00::1]/', opts).ok).toBe(true);
  });

  it('still blocks cloud-metadata link-local even with allowPrivateNetworks', () => {
    const opts = { allowPrivateNetworks: true };
    expect(checkOutboundUrlSync('http://169.254.169.254/', opts).ok).toBe(false);
    expect(checkOutboundUrlSync('http://[fe80::1]/', opts).ok).toBe(false);
  });

  it('still blocks unspecified, multicast, and reserved blocks', () => {
    const opts = { allowPrivateNetworks: true };
    expect(checkOutboundUrlSync('http://0.0.0.0/', opts).ok).toBe(false);
    expect(checkOutboundUrlSync('http://224.0.0.1/', opts).ok).toBe(false);
    expect(checkOutboundUrlSync('http://240.0.0.1/', opts).ok).toBe(false);
    expect(checkOutboundUrlSync('http://198.51.100.1/', opts).ok).toBe(false);
  });

  it('still blocks non-http schemes even with allowPrivateNetworks', () => {
    const opts = { allowPrivateNetworks: true };
    expect(checkOutboundUrlSync('file:///etc/passwd', opts).ok).toBe(false);
  });
});

describe('checkOutboundUrl — async with DNS', () => {
  it('rejects literal private IPs without doing DNS', async () => {
    const r = await checkOutboundUrl('http://127.0.0.1/');
    expect(r.ok).toBe(false);
  });

  it('skipDns:true accepts a hostname without resolving', async () => {
    const r = await checkOutboundUrl('https://does-not-exist.invalid./', { skipDns: true });
    expect(r.ok).toBe(true);
  });

  it('reports DNS failures as refusals', async () => {
    // .invalid is reserved for failure by RFC 6761
    const r = await checkOutboundUrl('https://does-not-exist.invalid./');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DNS lookup failed/);
  });
});

describe('isExplicitlyLocalUrl', () => {
  it('treats `localhost` as explicitly local', () => {
    expect(isExplicitlyLocalUrl('http://localhost:11434')).toBe(true);
    expect(isExplicitlyLocalUrl('http://localhost')).toBe(true);
  });

  it('treats RFC 1918 / loopback / CGN literals as explicitly local', () => {
    expect(isExplicitlyLocalUrl('http://127.0.0.1/')).toBe(true);
    expect(isExplicitlyLocalUrl('http://192.168.1.5/')).toBe(true);
    expect(isExplicitlyLocalUrl('http://10.0.0.1/')).toBe(true);
    expect(isExplicitlyLocalUrl('http://100.64.0.1/')).toBe(true);
    expect(isExplicitlyLocalUrl('http://[::1]/')).toBe(true);
    expect(isExplicitlyLocalUrl('http://[fc00::1]/')).toBe(true);
  });

  it('returns false for public hosts', () => {
    expect(isExplicitlyLocalUrl('https://api.openai.com/v1')).toBe(false);
    expect(isExplicitlyLocalUrl('https://github.com/owner/repo')).toBe(false);
    expect(isExplicitlyLocalUrl('https://1.1.1.1/')).toBe(false);
  });

  it('returns false for malformed input', () => {
    expect(isExplicitlyLocalUrl('not a url')).toBe(false);
    expect(isExplicitlyLocalUrl('')).toBe(false);
  });

  it('returns false for cloud-metadata link-local (always blocked, never "own network")', () => {
    expect(isExplicitlyLocalUrl('http://169.254.169.254/')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('throws before reaching the network when the URL is blocked', async () => {
    // 0.0.0.0 is unspecified — always blocked by the guard, even with
    // allowPrivateNetworks. fetch should never run.
    await expect(safeFetch('http://0.0.0.0/x')).rejects.toThrow(/SSRF guard refused/);
  });

  it('throws on disallowed schemes', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/SSRF guard refused/);
  });

  it('does not invoke fetch when the URL is malformed', async () => {
    await expect(safeFetch('not a url')).rejects.toThrow(/SSRF guard refused/);
  });
});

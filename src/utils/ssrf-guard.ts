/**
 * SSRF guard for outbound HTTP traffic that originates from user-controllable
 * configuration (e.g. OLLAMA_BASE_URL, future plug-in endpoints, package
 * registry mirrors). Refuses URLs that resolve to loopback, private RFC1918,
 * link-local (cloud-metadata), shared address space (CGN, RFC 6598), or any
 * non-http(s) scheme.
 *
 * The graphify v0.5.4 / v0.7.9 SSRF advisories specifically called out the
 * 100.64.0.0/10 CGN range and DNS rebinding via a host that resolves to a
 * public IP at validation time and a private IP at fetch time. We block the
 * CGN range here and recommend callers pass the resolved IP into the fetch
 * itself once full DNS rebinding protection lands.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** Blocked IPv4 CIDRs. Each tuple is [ip-as-bigint-style-number, prefix]. */
const BLOCKED_V4_CIDRS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // RFC 6598 CGN — graphify v0.7.9 advisory
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — AWS / GCP / Azure metadata
  ['172.16.0.0', 12], // RFC 1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** Blocked IPv6 prefixes (lowercased, no zone id). */
const BLOCKED_V6_PREFIXES: ReadonlyArray<string> = [
  '::1', // loopback
  '::', // unspecified
  'fc', // fc00::/7 — unique local
  'fd', // fc00::/7 — unique local (second nibble)
  'fe8', // fe80::/10 — link-local
  'fe9',
  'fea',
  'feb',
  'ff', // ff00::/8 — multicast
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  // Force unsigned 32-bit
  return n >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // malformed — fail closed
  for (const [base, prefix] of BLOCKED_V4_CIDRS) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((n & mask) === (baseInt & mask)) return true;
  }
  return false;
}

function isBlockedV6(ip: string): boolean {
  // Strip zone identifier (e.g. `%eth0`) and lowercase.
  const cleaned = ip.split('%')[0].toLowerCase();
  if (cleaned === '::1' || cleaned === '::' || cleaned === '0:0:0:0:0:0:0:0') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — recurse into IPv4 check
  const v4Match = cleaned.match(/^::ffff:([\d.]+)$/);
  if (v4Match) return isBlockedV4(v4Match[1]);
  for (const prefix of BLOCKED_V6_PREFIXES) {
    if (cleaned.startsWith(prefix)) return true;
  }
  return false;
}

export interface SsrfGuardOptions {
  /** Allowed schemes. Defaults to http/https only. */
  allowSchemes?: ReadonlyArray<string>;
  /**
   * Skip DNS resolution and only check literal IPs in the URL host. Useful in
   * tests or when callers will resolve themselves and pass the IP back in.
   * Default false.
   */
  skipDns?: boolean;
}

export interface SsrfGuardResult {
  ok: boolean;
  /** Reason for refusal. Undefined when ok=true. */
  reason?: string;
  /** Resolved IP (when DNS lookup ran). */
  resolvedIp?: string;
}

const DEFAULT_SCHEMES = ['http:', 'https:'] as const;

/**
 * Asynchronously check that `url` is safe to fetch from. Returns `{ok: true}`
 * when the URL is well-formed, uses an allowed scheme, and resolves to a
 * public address.
 */
export async function checkOutboundUrl(
  url: string,
  opts: SsrfGuardOptions = {},
): Promise<SsrfGuardResult> {
  const allowSchemes = opts.allowSchemes ?? DEFAULT_SCHEMES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }

  if (!allowSchemes.includes(parsed.protocol)) {
    return { ok: false, reason: `Disallowed scheme: ${parsed.protocol}` };
  }

  // Strip surrounding brackets that URL keeps for IPv6 hosts.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return { ok: false, reason: 'Empty host' };

  const literal = net.isIP(host);
  if (literal === 4) {
    if (isBlockedV4(host)) return { ok: false, reason: `Private/loopback IPv4: ${host}` };
    return { ok: true, resolvedIp: host };
  }
  if (literal === 6) {
    if (isBlockedV6(host)) return { ok: false, reason: `Private/loopback IPv6: ${host}` };
    return { ok: true, resolvedIp: host };
  }

  if (opts.skipDns) {
    // Hostname not resolved — accept only when caller is happy with that.
    return { ok: true };
  }

  // Resolve all addresses; refuse if *any* falls in a blocked range, since
  // a multi-A DNS response could otherwise be used to exfiltrate via a
  // private fallback address.
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    return {
      ok: false,
      reason: `DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  for (const a of addrs) {
    if (a.family === 4 && isBlockedV4(a.address)) {
      return { ok: false, reason: `Host ${host} resolves to private IPv4 ${a.address}` };
    }
    if (a.family === 6 && isBlockedV6(a.address)) {
      return { ok: false, reason: `Host ${host} resolves to private IPv6 ${a.address}` };
    }
  }

  return { ok: true, resolvedIp: addrs[0]?.address };
}

/**
 * Synchronous variant for cases where DNS is not available or callers do not
 * want to await: only inspects the URL itself. Returns ok=true for hostnames
 * (since we cannot resolve them), but blocks literal private IPs and
 * non-allowed schemes outright.
 */
export function checkOutboundUrlSync(url: string, opts: SsrfGuardOptions = {}): SsrfGuardResult {
  const allowSchemes = opts.allowSchemes ?? DEFAULT_SCHEMES;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }
  if (!allowSchemes.includes(parsed.protocol)) {
    return { ok: false, reason: `Disallowed scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return { ok: false, reason: 'Empty host' };

  const literal = net.isIP(host);
  if (literal === 4 && isBlockedV4(host)) {
    return { ok: false, reason: `Private/loopback IPv4: ${host}` };
  }
  if (literal === 6 && isBlockedV6(host)) {
    return { ok: false, reason: `Private/loopback IPv6: ${host}` };
  }
  return { ok: true, resolvedIp: literal ? host : undefined };
}

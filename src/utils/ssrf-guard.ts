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
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * IPv4 CIDRs that are private but represent a "user's own network" — those
 * become allowed when `allowPrivateNetworks: true`. Includes RFC 1918, RFC
 * 6598 (CGN / Tailscale), and loopback.
 */
const PRIVATE_OWN_NETWORK_V4_CIDRS: ReadonlyArray<[string, number]> = [
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // RFC 6598 CGN — Tailscale, mempalace #1225
  ['127.0.0.0', 8], // loopback
  ['172.16.0.0', 12], // RFC 1918 private
  ['192.168.0.0', 16], // RFC 1918 private
];

/**
 * IPv4 CIDRs that are blocked unconditionally — even with
 * `allowPrivateNetworks: true`. Cloud metadata (link-local), unspecified,
 * test/benchmark/multicast/reserved blocks remain off-limits.
 */
const ALWAYS_BLOCKED_V4_CIDRS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['169.254.0.0', 16], // link-local — AWS / GCP / Azure metadata
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/**
 * IPv6 prefixes that represent a "user's own network" — ULA only here. The
 * loopback `::1` is handled by exact match in `isBlockedV6` (a startsWith
 * check would incorrectly catch `::` too).
 */
const PRIVATE_OWN_NETWORK_V6_PREFIXES: ReadonlyArray<string> = [
  'fc', // fc00::/7 — unique local
  'fd',
];

/**
 * IPv6 prefixes blocked unconditionally (link-local metadata, multicast). The
 * unspecified `::` is handled by exact match in `isBlockedV6`.
 */
const ALWAYS_BLOCKED_V6_PREFIXES: ReadonlyArray<string> = [
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

function matchesV4Cidr(n: number, cidrs: ReadonlyArray<[string, number]>): boolean {
  for (const [base, prefix] of cidrs) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((n & mask) === (baseInt & mask)) return true;
  }
  return false;
}

function isBlockedV4(ip: string, allowPrivate = false): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // malformed — fail closed
  if (matchesV4Cidr(n, ALWAYS_BLOCKED_V4_CIDRS)) return true;
  if (!allowPrivate && matchesV4Cidr(n, PRIVATE_OWN_NETWORK_V4_CIDRS)) return true;
  return false;
}

/**
 * Decode an `::ffff:a.b.c.d` IPv4-mapped IPv6 to its IPv4 dotted form. Node's
 * URL parser may canonicalise either as `::ffff:127.0.0.1` (dotted) or as
 * `::ffff:7f00:1` (hex), so handle both.
 */
function ipv4MappedToV4(cleaned: string): string | null {
  const dotted = cleaned.match(/^::ffff:([\d.]+)$/);
  if (dotted) return dotted[1];
  const hex = cleaned.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

function isBlockedV6(ip: string, allowPrivate = false): boolean {
  // Strip zone identifier (e.g. `%eth0`) and lowercase.
  const cleaned = ip.split('%')[0].toLowerCase();
  // Unspecified always blocked (cannot be "user's own network")
  if (cleaned === '::' || cleaned === '0:0:0:0:0:0:0:0') return true;
  // Loopback — private own-network: blocked unless allowPrivate=true
  if (cleaned === '::1') return !allowPrivate;
  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:HEX:HEX) — recurse into IPv4 check
  const mappedV4 = ipv4MappedToV4(cleaned);
  if (mappedV4 !== null) return isBlockedV4(mappedV4, allowPrivate);
  for (const prefix of ALWAYS_BLOCKED_V6_PREFIXES) {
    if (cleaned.startsWith(prefix)) return true;
  }
  if (!allowPrivate) {
    for (const prefix of PRIVATE_OWN_NETWORK_V6_PREFIXES) {
      if (cleaned.startsWith(prefix)) return true;
    }
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
  /**
   * Opt-in: treat RFC 1918 private space, RFC 6598 CGN (Tailscale), loopback,
   * and IPv6 ULA as allowed. Useful when the URL is a deliberately configured
   * local LLM endpoint (Ollama on a Tailscale homelab, LM Studio on
   * 192.168.x.x, llama.cpp on 127.0.0.1). Link-local (cloud-metadata),
   * unspecified (0.0.0.0), test/multicast/reserved blocks remain blocked even
   * when this is true. Default false.
   */
  allowPrivateNetworks?: boolean;
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
  const allowPrivate = opts.allowPrivateNetworks ?? false;

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
    if (isBlockedV4(host, allowPrivate))
      return { ok: false, reason: `Private/loopback IPv4: ${host}` };
    return { ok: true, resolvedIp: host };
  }
  if (literal === 6) {
    if (isBlockedV6(host, allowPrivate))
      return { ok: false, reason: `Private/loopback IPv6: ${host}` };
    return { ok: true, resolvedIp: host };
  }

  if (opts.skipDns) {
    // Hostname not resolved — accept only when caller is happy with that.
    return { ok: true };
  }

  // Resolve all addresses; refuse if *any* falls in a blocked range, since
  // a multi-A DNS response could otherwise be used to exfiltrate via a
  // private fallback address.
  let addrs: LookupAddress[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    return {
      ok: false,
      reason: `DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  for (const a of addrs) {
    if (a.family === 4 && isBlockedV4(a.address, allowPrivate)) {
      return { ok: false, reason: `Host ${host} resolves to private IPv4 ${a.address}` };
    }
    if (a.family === 6 && isBlockedV6(a.address, allowPrivate)) {
      return { ok: false, reason: `Host ${host} resolves to private IPv6 ${a.address}` };
    }
  }

  return { ok: true, resolvedIp: addrs[0]?.address };
}

/**
 * Wraps `fetch` with `checkOutboundUrl` so a single misconfigured baseUrl
 * cannot reach a private / loopback / metadata endpoint. Throws on guard
 * refusal — callers see a regular Error their existing retry/error-handling
 * path already covers, instead of a successful fetch to an internal IP.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  guardOpts: SsrfGuardOptions = {},
): Promise<Response> {
  const guard = await checkOutboundUrl(url, guardOpts);
  if (!guard.ok) {
    throw new Error(`SSRF guard refused ${url}: ${guard.reason ?? 'blocked'}`);
  }
  return fetch(url, init);
}

/**
 * Returns true when `url` is a deliberately-local endpoint: `localhost`, a
 * literal RFC 1918 / RFC 6598 IP, IPv4/IPv6 loopback, or an IPv6 ULA. The
 * presence of such a URL in user config is treated as an explicit opt-in for
 * the SSRF guard's `allowPrivateNetworks` mode — they typed
 * `http://localhost:11434`, so we honour it. URLs whose host is a public
 * domain (e.g. `https://api.openai.com`) return false even if DNS would later
 * resolve to a private IP — those are the rebinding/SSRF cases we still block.
 */
export function isExplicitlyLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost') return true;
  // Strict check rejects literal private IPs; lax check accepts them. The
  // private/loopback bucket is exactly the set blocked by the first and
  // accepted by the second — no need to duplicate the CIDR tables here.
  const strict = checkOutboundUrlSync(url, { allowPrivateNetworks: false });
  if (strict.ok) return false;
  const lax = checkOutboundUrlSync(url, { allowPrivateNetworks: true });
  return lax.ok;
}

/**
 * Synchronous variant for cases where DNS is not available or callers do not
 * want to await: only inspects the URL itself. Returns ok=true for hostnames
 * (since we cannot resolve them), but blocks literal private IPs and
 * non-allowed schemes outright.
 */
export function checkOutboundUrlSync(url: string, opts: SsrfGuardOptions = {}): SsrfGuardResult {
  const allowSchemes = opts.allowSchemes ?? DEFAULT_SCHEMES;
  const allowPrivate = opts.allowPrivateNetworks ?? false;
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
  if (literal === 4 && isBlockedV4(host, allowPrivate)) {
    return { ok: false, reason: `Private/loopback IPv4: ${host}` };
  }
  if (literal === 6 && isBlockedV6(host, allowPrivate)) {
    return { ok: false, reason: `Private/loopback IPv6: ${host}` };
  }
  return { ok: true, resolvedIp: literal ? host : undefined };
}

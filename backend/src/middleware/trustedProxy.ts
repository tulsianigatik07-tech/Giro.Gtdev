import { isIP } from "node:net";

type AddressFamily = 4 | 6;

interface ParsedAddress {
  family: AddressFamily;
  value: bigint;
  normalized: string;
}

interface ParsedCidr {
  family: AddressFamily;
  network: bigint;
  prefix: number;
}

function ipv4(input: string): ParsedAddress | null {
  if (isIP(input) !== 4) return null;
  const octets = input.split(".").map(Number);
  const value = octets.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
  return { family: 4, value, normalized: octets.join(".") };
}

function ipv6(input: string): ParsedAddress | null {
  const zoneIndex = input.indexOf("%");
  const withoutZone = zoneIndex === -1 ? input : input.slice(0, zoneIndex);
  if (isIP(withoutZone) !== 6) return null;
  let source = withoutZone.toLowerCase();
  const embedded = source.match(/([0-9]+(?:\.[0-9]+){3})$/)?.[1];
  if (embedded) {
    const parsed = ipv4(embedded);
    if (!parsed) return null;
    source = source.slice(0, -embedded.length) +
      `${Number((parsed.value >> 16n) & 0xffffn).toString(16)}:${Number(parsed.value & 0xffffn).toString(16)}`;
  }
  const halves = source.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return null;
  const value = groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || "0"}`), 0n);
  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const mapped = value & 0xffffffffn;
    return {
      family: 4,
      value: mapped,
      normalized: [24n, 16n, 8n, 0n].map((shift) => Number((mapped >> shift) & 0xffn)).join("."),
    };
  }
  const normalized = groups.map((group) => Number.parseInt(group || "0", 16).toString(16)).join(":");
  return { family: 6, value, normalized };
}

export function normalizeIpAddress(input: string | undefined): string | null {
  if (!input) return null;
  let candidate = input.trim();
  if (candidate.startsWith("[") && candidate.includes("]")) candidate = candidate.slice(1, candidate.indexOf("]"));
  const parsed = ipv4(candidate) ?? ipv6(candidate);
  return parsed?.normalized ?? null;
}

function parseAddress(input: string): ParsedAddress | null {
  const normalized = normalizeIpAddress(input);
  return normalized ? ipv4(normalized) ?? ipv6(normalized) : null;
}

function parseCidr(input: string): ParsedCidr {
  const [rawAddress, rawPrefix] = input.trim().split("/");
  const address = rawAddress ? parseAddress(rawAddress) : null;
  if (!address) throw new TypeError(`Invalid trusted proxy CIDR: ${input}`);
  let prefix = rawPrefix === undefined ? (address.family === 4 ? 32 : 128) : Number(rawPrefix);
  if (!Number.isInteger(prefix)) throw new TypeError(`Invalid trusted proxy CIDR: ${input}`);
  if (address.family === 4 && rawAddress?.toLowerCase().includes(":") && prefix >= 96) prefix -= 96;
  const bits = address.family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > bits) throw new TypeError(`Invalid trusted proxy CIDR: ${input}`);
  const shift = BigInt(bits - prefix);
  return { family: address.family, prefix, network: (address.value >> shift) << shift };
}

export function validateTrustedProxyCidrs(cidrs: readonly string[]): void {
  cidrs.forEach(parseCidr);
}

function contains(cidr: ParsedCidr, address: ParsedAddress): boolean {
  if (cidr.family !== address.family) return false;
  const bits = address.family === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);
  return (address.value >> shift) === (cidr.network >> shift);
}

export function resolveClientIp(input: {
  remoteAddress?: string;
  forwardedFor?: string;
  trustedProxyCidrs: readonly string[];
}): string {
  const peer = parseAddress(input.remoteAddress ?? "") ?? parseAddress("127.0.0.1")!;
  const trusted = input.trustedProxyCidrs.map(parseCidr);
  if (!trusted.some((cidr) => contains(cidr, peer)) || !input.forwardedFor) return peer.normalized;
  const forwarded = input.forwardedFor.split(",").map((value) => parseAddress(value.trim()));
  if (forwarded.some((value) => value === null)) return peer.normalized;
  const chain = [...forwarded as ParsedAddress[], peer];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = chain[index]!;
    if (!trusted.some((cidr) => contains(cidr, address))) return address.normalized;
  }
  return chain[0]!.normalized;
}

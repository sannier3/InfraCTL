import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HMAC_HEADERS, HMAC_PROTOCOL_VERSION } from "@infra/types";

export { HMAC_HEADERS, HMAC_PROTOCOL_VERSION };

export class CanonicalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalRequestError";
  }
}

export type SignatureMaterial = {
  method: string;
  pathname: string;
  query: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer;
};

function assertField(name: string, value: string): void {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new CanonicalRequestError(`${name} contient un caractère interdit`);
  }
}

/**
 * Chaîne canonique versionnée.
 *
 * INFRACTL-HMAC-V1\n
 * METHOD\n
 * PATHNAME\n
 * QUERY\n
 * TIMESTAMP\n
 * NONCE\n
 * SHA256(body)\n
 *
 * QUERY est la query string brute sans « ? ». Elle est vide si absente.
 * Le corps signé est exactement les octets envoyés. Un corps vide vaut SHA256("").
 */
export function canonicalString(input: SignatureMaterial): string {
  const method = input.method.toUpperCase();
  const pathname = input.pathname;
  const query = input.query;
  if (!pathname.startsWith("/") || pathname.includes("?")) {
    throw new CanonicalRequestError("pathname invalide");
  }
  assertField("method", method);
  assertField("pathname", pathname);
  assertField("query", query);
  assertField("timestamp", input.timestamp);
  assertField("nonce", input.nonce);
  const bodyHash = hashBody(input.body);
  return [
    HMAC_PROTOCOL_VERSION,
    method,
    pathname,
    query,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n") + "\n";
}

export function hashBody(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function sign(secret: string, material: SignatureMaterial): string {
  return createHmac("sha256", secret).update(canonicalString(material)).digest("hex");
}

export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(providedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  return timingSafeEqual(expected, provided);
}

export function verify(secret: string, material: SignatureMaterial, providedHex: string): boolean {
  const expected = sign(secret, material);
  return signaturesMatch(expected, providedHex);
}

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

export function splitUrl(url: URL): { pathname: string; query: string } {
  return {
    pathname: url.pathname,
    query: url.search.startsWith("?") ? url.search.slice(1) : url.search,
  };
}

export function headerValues(input: {
  agentId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}): Record<string, string> {
  return {
    [HMAC_HEADERS.agentId]: input.agentId,
    [HMAC_HEADERS.timestamp]: input.timestamp,
    [HMAC_HEADERS.nonce]: input.nonce,
    [HMAC_HEADERS.signature]: input.signature,
  };
}

export function timestampFresh(timestampMs: string, nowMs: number, windowMs: number): boolean {
  if (!/^\d{13}$/.test(timestampMs)) {
    return false;
  }
  const timestamp = Number(timestampMs);
  if (!Number.isSafeInteger(timestamp)) {
    return false;
  }
  return Math.abs(nowMs - timestamp) <= windowMs;
}

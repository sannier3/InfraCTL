import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function decodeCredentialsKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("security.credentialsKey doit être du base64 décodant exactement 32 octets");
  }
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc", "v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(
    ":",
  );
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("secret chiffré illisible");
  }
  const ivPart = parts[2];
  const tagPart = parts[3];
  const dataPart = parts[4];
  if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
    throw new Error("secret chiffré illisible");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const data = Buffer.from(dataPart, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function tokenMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalString,
  hashBody,
  sign,
  timestampFresh,
  verify,
} from "../src/index.js";

const material = {
  method: "post",
  pathname: "/api/v1/agent/heartbeat",
  query: "",
  timestamp: "1760000000000",
  nonce: "aabbccddeeff00112233445566778899",
  body: '{"agentId":"pve01"}',
};

describe("HMAC", () => {
  it("signe et vérifie une requête", () => {
    const secret = "test-secret-value";
    const signature = sign(secret, material);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verify(secret, material, signature)).toBe(true);
  });

  it("refuse un corps modifié", () => {
    const secret = "test-secret-value";
    const signature = sign(secret, material);
    expect(
      verify(secret, { ...material, body: '{"agentId":"pve02"}' }, signature),
    ).toBe(false);
  });

  it("refuse un autre secret", () => {
    const signature = sign("secret-a-123456", material);
    expect(verify("secret-b-123456", material, signature)).toBe(false);
  });

  it("inclut la méthode, le chemin, le timestamp, le nonce et le hash du corps", () => {
    const text = canonicalString(material);
    expect(text.startsWith("INFRACTL-HMAC-V1\n")).toBe(true);
    expect(text).toContain("\nPOST\n/api/v1/agent/heartbeat\n\n1760000000000\n");
    expect(text).toContain(hashBody(material.body));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("hash un corps vide de façon stable", () => {
    expect(hashBody("")).toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });

  it("refuse une pathname injectable", () => {
    expect(() =>
      canonicalString({ ...material, pathname: "/api\nGET /admin" }),
    ).toThrow(/interdit|invalide/);
  });

  it("borne la fenêtre temporelle", () => {
    const now = 1_760_000_000_000;
    expect(timestampFresh(String(now), now, 60_000)).toBe(true);
    expect(timestampFresh(String(now - 59_000), now, 60_000)).toBe(true);
    expect(timestampFresh(String(now - 61_000), now, 60_000)).toBe(false);
    expect(timestampFresh(String(now + 61_000), now, 60_000)).toBe(false);
    expect(timestampFresh(String(Math.floor(now / 1000)), now, 60_000)).toBe(false);
  });
});

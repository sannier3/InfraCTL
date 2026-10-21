import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "../src/backoff.js";
import { redact } from "../src/redact.js";

describe("redaction", () => {
  it("masque les secrets connus et les clés sensibles", () => {
    const secret = "super-secret-value";
    const redacted = redact(
      {
        authorization: "Bearer abc",
        nested: { agentSecret: secret, ok: true },
        message: `token=${secret}`,
      },
      [secret],
    );
    expect(redacted).toEqual({
      authorization: "[redacted]",
      nested: { agentSecret: "[redacted]", ok: true },
      message: "token=[redacted]",
    });
  });
});

describe("backoff", () => {
  it("suit les paliers et ajoute au plus 20 % de jitter", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(1000);
    expect(backoffDelayMs(1, () => 0)).toBe(2000);
    expect(backoffDelayMs(2, () => 0)).toBe(5000);
    expect(backoffDelayMs(3, () => 0)).toBe(10000);
    expect(backoffDelayMs(4, () => 0)).toBe(30000);
    expect(backoffDelayMs(20, () => 0)).toBe(30000);
    expect(backoffDelayMs(0, () => 1)).toBe(1200);
    expect(backoffDelayMs(4, () => 1)).toBe(30000);
  });
});

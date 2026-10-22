import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "infra_session";
const LABEL = "infra-ui-session-v1";

export type SessionService = {
  valid(cookieHeader: string | undefined, now: number): boolean;
  issue(now: number): string;
  setCookie(token: string, secure: boolean): string;
  clearCookie(secure: boolean): string;
};

export function createSessionService(key: Buffer, timing: { sessionTtlMs: number }): SessionService {
  const signingKey = createHmac("sha256", key).update(LABEL).digest();
  return {
    valid(cookieHeader, now) {
      const token = readCookie(cookieHeader, COOKIE);
      if (!token) {
        return false;
      }
      const dot = token.indexOf(".");
      if (dot <= 0) {
        return false;
      }
      const payload = token.slice(0, dot);
      const mac = token.slice(dot + 1);
      const expected = createHmac("sha256", signingKey).update(payload).digest("base64url");
      const left = Buffer.from(mac);
      const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return false;
      }
      try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
        return typeof parsed.exp === "number" && parsed.exp > now;
      } catch {
        return false;
      }
    },
    issue(now) {
      const payload = Buffer.from(JSON.stringify({ exp: now + timing.sessionTtlMs }), "utf8").toString("base64url");
      const mac = createHmac("sha256", signingKey).update(payload).digest("base64url");
      return `${payload}.${mac}`;
    },
    setCookie(token, secure) {
      return cookieHeader(COOKIE, token, secure, Math.floor(timing.sessionTtlMs / 1000));
    },
    clearCookie(secure) {
      return cookieHeader(COOKIE, "", secure, 0);
    },
  };
}

function cookieHeader(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

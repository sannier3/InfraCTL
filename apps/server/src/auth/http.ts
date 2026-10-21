import type { FastifyRequest } from "fastify";
import { hmacHeaderSchema } from "@infra/schemas";
import { ERROR_CODES, HMAC_HEADERS } from "@infra/types";
import { splitUrl, timestampFresh, verify } from "@infra/protocol";
import { decryptSecret, tokenMatches } from "../crypto/secrets.js";
import type { Store } from "../database/store.js";
import { AppError } from "../errors.js";
import type { Principal } from "../jobs/service.js";

export function createAgentAuth(deps: {
  store: Store;
  key: Buffer;
  windowMs: number;
  now: () => Date;
}) {
  return async function agentAuth(request: FastifyRequest): Promise<void> {
    const parsed = hmacHeaderSchema.safeParse({
      agentId: headerValue(request, HMAC_HEADERS.agentId),
      timestamp: headerValue(request, HMAC_HEADERS.timestamp),
      nonce: headerValue(request, HMAC_HEADERS.nonce),
      signature: headerValue(request, HMAC_HEADERS.signature),
    });
    if (!parsed.success) {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    if (!timestampFresh(parsed.data.timestamp, deps.now().getTime(), deps.windowMs)) {
      throw new AppError(401, ERROR_CODES.TIMESTAMP_OUT_OF_WINDOW, "timestamp hors fenêtre");
    }
    const ciphertext = await deps.store.findAgentSecret(parsed.data.agentId);
    if (!ciphertext) {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    let secret: string;
    try {
      secret = decryptSecret(ciphertext, deps.key);
    } catch {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    const url = new URL(request.url, "http://infra.local");
    const parts = splitUrl(url);
    const valid = verify(
      secret,
      {
        method: request.method,
        pathname: parts.pathname,
        query: parts.query,
        timestamp: parsed.data.timestamp,
        nonce: parsed.data.nonce,
        body: request.rawBody ?? "",
      },
      parsed.data.signature,
    );
    if (!valid) {
      throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
    }
    const nonce = await deps.store.insertNonce({
      agentId: parsed.data.agentId,
      nonce: parsed.data.nonce,
      timestamp: new Date(Number(parsed.data.timestamp)),
      expiresAt: new Date(deps.now().getTime() + deps.windowMs),
    });
    if (nonce === "replay") {
      throw new AppError(401, ERROR_CODES.REPLAY_DETECTED, "nonce déjà utilisé");
    }
    request.agentId = parsed.data.agentId;
  };
}

export function createApiAuth(tokens: { admin: string; reader?: string }) {
  return async function apiAuth(request: FastifyRequest): Promise<void> {
    const header = headerValue(request, "authorization");
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (provided.length === 0) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "jeton API requis");
    }
    if (tokenMatches(provided, tokens.admin)) {
      request.principal = { kind: "admin" };
      return;
    }
    if (tokens.reader && tokenMatches(provided, tokens.reader)) {
      request.principal = { kind: "reader" };
      return;
    }
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "jeton API refusé");
  };
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "jeton API requis");
  }
  return request.principal;
}

export function requireAgentId(request: FastifyRequest): string {
  if (!request.agentId) {
    throw new AppError(401, ERROR_CODES.AGENT_UNAUTHORIZED, "authentification agent refusée");
  }
  return request.agentId;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}

import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { MemoryStore } from "../src/database/memory-store.js";
import { signed, testConfig } from "./helpers.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const ADMIN = { authorization: "Bearer dev-admin-token-change", "content-type": "application/json" };
const READER = { authorization: "Bearer dev-reader-token-change", "content-type": "application/json" };
const SECRET = "agent-secret-value-1";

describe("gestion des agents", () => {
  it("enregistre, modifie, renouvelle et retire un agent sans renvoyer le secret", async () => {
    const store = new MemoryStore();
    const built = await buildApp({ config: testConfig(), store, now: () => NOW, startScheduler: false });
    const base = await listen(built.app);

    const created = await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ id: "edge-01", type: "linux-node", secret: SECRET, name: "Bordure" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { id: string; name: string; presence: string; secret?: string };
    expect(createdBody).toMatchObject({ id: "edge-01", name: "Bordure", presence: "OFFLINE" });
    expect(JSON.stringify(createdBody)).not.toContain(SECRET);
    expect(createdBody.secret).toBeUndefined();

    const duplicate = await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ id: "edge-01", type: "linux-node", secret: SECRET }),
    });
    expect(duplicate.status).toBe(409);

    const forbidden = await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: READER,
      body: JSON.stringify({ id: "edge-02", type: "linux-node", secret: SECRET }),
    });
    expect(forbidden.status).toBe(403);

    const renamed = await fetch(`${base}/api/v1/agents/edge-01`, {
      method: "PATCH",
      headers: ADMIN,
      body: JSON.stringify({ name: "Bordure nord", maxConcurrency: 2 }),
    });
    expect(await renamed.json()).toMatchObject({ name: "Bordure nord", maxConcurrency: 2 });

    const heartbeat = heartbeatRequest(SECRET, "nonce-create-0000000000000001");
    expect((await fetch(`${base}/api/v1/agent/heartbeat`, heartbeat)).status).toBe(200);

    const rotatedSecret = "agent-secret-value-2";
    const rotated = await fetch(`${base}/api/v1/agents/edge-01/secret`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ secret: rotatedSecret }),
    });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(await rotated.json())).not.toContain(rotatedSecret);
    const stale = heartbeatRequest(SECRET, "nonce-stale-00000000000000001");
    expect((await fetch(`${base}/api/v1/agent/heartbeat`, stale)).status).toBe(401);
    const fresh = heartbeatRequest(rotatedSecret, "nonce-fresh-00000000000000001");
    expect((await fetch(`${base}/api/v1/agent/heartbeat`, fresh)).status).toBe(200);

    const removed = await fetch(`${base}/api/v1/agents/edge-01`, { method: "DELETE", headers: ADMIN });
    expect(removed.status).toBe(204);
    expect((await fetch(`${base}/api/v1/agents/edge-01`, { headers: ADMIN })).status).toBe(404);
    await built.app.close();
  });
});

function heartbeatRequest(secret: string, nonce: string): { method: "POST"; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    agentId: "edge-01",
    version: "1.0.0",
    type: "linux-node",
    jobs: { running: 0, queued: 0, capacity: 4 },
    capabilities: ["system", "apt", "local.metrics"],
  });
  const signedRequest = signed({
    method: "POST",
    path: "/api/v1/agent/heartbeat",
    body,
    secret,
    agentId: "edge-01",
    now: NOW,
    nonce,
  });
  return { method: "POST", headers: signedRequest.headers, body: signedRequest.payload ?? body };
}

async function listen(app: {
  listen: (options: { host: string; port: number }) => Promise<string>;
  server: { address: () => string | { port: number } | null };
}): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("port introuvable");
  }
  return `http://127.0.0.1:${address.port}`;
}

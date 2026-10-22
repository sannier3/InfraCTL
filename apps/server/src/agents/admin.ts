import { DEFAULT_CAPABILITIES, ERROR_CODES } from "@infra/types";
import type { AgentCreateBody, AgentSecretBody, AgentUpdateBody } from "@infra/schemas";
import { encryptSecret } from "../crypto/secrets.js";
import type { AgentRecord } from "../database/records.js";
import type { Store } from "../database/store.js";
import { AppError } from "../errors.js";

export class AgentAdmin {
  constructor(
    private readonly store: Store,
    private readonly credentialsKey: Buffer,
  ) {}

  async register(body: AgentCreateBody, now: Date): Promise<AgentRecord> {
    const result = await this.store.insertAgent({
      secretCiphertext: encryptSecret(body.secret, this.credentialsKey),
      agent: {
        id: body.id,
        name: body.name ?? body.id,
        type: body.type,
        version: "0.0.0",
        presence: "OFFLINE",
        lastSeenAt: null,
        registeredAt: now,
        maxConcurrency: body.maxConcurrency ?? 4,
        capabilities: [...(body.capabilities ?? DEFAULT_CAPABILITIES[body.type])],
        reportedRunning: 0,
        reportedQueued: 0,
        reportedCapacity: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (result === "exists") {
      throw new AppError(409, ERROR_CODES.CONFLICT, "agent déjà enregistré");
    }
    const created = await this.store.findAgent(body.id);
    if (!created) {
      throw new AppError(500, "INTERNAL", "agent introuvable après enregistrement");
    }
    return created;
  }

  async update(id: string, body: AgentUpdateBody): Promise<AgentRecord> {
    const updated = await this.store.updateAgent(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.maxConcurrency !== undefined ? { maxConcurrency: body.maxConcurrency } : {}),
      ...(body.capabilities !== undefined ? { capabilities: [...body.capabilities] } : {}),
    });
    if (!updated) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
    }
    return updated;
  }

  async rotateSecret(id: string, body: AgentSecretBody): Promise<AgentRecord> {
    const rotated = await this.store.rotateAgentSecret(id, encryptSecret(body.secret, this.credentialsKey));
    if (!rotated) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
    }
    const agent = await this.store.findAgent(id);
    if (!agent) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
    }
    return agent;
  }

  async remove(id: string): Promise<void> {
    const removed = await this.store.deleteAgent(id);
    if (!removed) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "agent introuvable");
    }
  }
}

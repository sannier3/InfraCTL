import "fastify";
import type { Principal } from "../jobs/service.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    agentId?: string;
    principal?: Principal;
    authMethod?: "bearer" | "session";
  }
}

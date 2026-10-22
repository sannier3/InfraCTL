import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { tokenMatches } from "../crypto/secrets.js";
import type { SessionService } from "./session.js";

const ASSET_NAME = /^[A-Za-z0-9._-]+$/;

export function uiDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
}

export type UiState = {
  password: string;
  noCache: boolean;
};

export function registerUi(
  app: FastifyInstance,
  deps: {
    ui: UiState;
    session: SessionService;
    now: () => Date;
    directory: string;
  },
): void {
  app.get("/ui/login", async (request, reply) => {
    if (deps.session.valid(request.headers.cookie, deps.now().getTime())) {
      return reply.redirect("/ui");
    }
    return sendHtml(reply, path.join(deps.directory, "login.html"), deps.ui.noCache);
  });

  app.post("/ui/login", async (request, reply) => {
    const password = formPassword(request.body);
    if (!tokenMatches(password, deps.ui.password)) {
      await delay(300);
    return reply.redirect("/ui/login?e=1", 303);
    }
    const secure = request.protocol === "https";
    reply.header("set-cookie", deps.session.setCookie(deps.session.issue(deps.now().getTime()), secure));
    return reply.redirect("/ui", 303);
  });

  app.post("/ui/logout", async (request, reply) => {
    if (!deps.session.valid(request.headers.cookie, deps.now().getTime())) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "session absente" } });
    }
    const secure = request.protocol === "https";
    reply.header("set-cookie", deps.session.clearCookie(secure));
    return reply.code(204).send();
  });

  app.get("/ui/assets/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    if (!ASSET_NAME.test(name)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "fichier introuvable" } });
    }
    const file = path.join(deps.directory, "assets", name);
    if (!file.startsWith(path.join(deps.directory, "assets"))) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "fichier introuvable" } });
    }
    try {
      await access(file);
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "fichier introuvable" } });
    }
    return reply.type(contentType(name)).header("cache-control", cacheHeader(deps.ui.noCache, false)).header("pragma", "no-cache").send(createReadStream(file));
  });

  app.get("/ui", async (request, reply) => sendApp(request, reply, deps));
  app.get("/ui/*", async (request, reply) => sendApp(request, reply, deps));
}

async function sendApp(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { ui: UiState; session: SessionService; now: () => Date; directory: string },
): Promise<FastifyReply> {
  if (!deps.session.valid(request.headers.cookie, deps.now().getTime())) {
    return reply.redirect("/ui/login");
  }
  return sendHtml(reply, path.join(deps.directory, "index.html"), deps.ui.noCache);
}

function cacheHeader(noCache: boolean, document: boolean): string {
  if (noCache) {
    return "no-cache, no-store, must-revalidate";
  }
  return document ? "no-store" : "no-cache";
}

async function sendHtml(reply: FastifyReply, file: string, noCache: boolean): Promise<FastifyReply> {
  const html = await readFile(file, "utf8");
  return reply
    .type("text/html; charset=utf-8")
    .header("cache-control", cacheHeader(noCache, true))
    .header("pragma", "no-cache")
    .header("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
    .header("referrer-policy", "no-referrer")
    .header("x-robots-tag", "noindex")
    .send(html);
}

function formPassword(body: unknown): string {
  if (typeof body === "object" && body !== null && "password" in body) {
    const value = body.password;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function contentType(name: string): string {
  if (name.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (name.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

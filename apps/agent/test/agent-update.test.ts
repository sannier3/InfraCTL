import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packTar } from "@infra/utils";
import { applyServerBundle, scriptUpdateCommand } from "../src/actions/agent/update.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mise à jour de l'agent", () => {
  it("lance le script sans redémarrer et sans changer la racine", () => {
    expect(scriptUpdateCommand("/opt/infra-agent")).toEqual({
      executable: join("/opt/infra-agent", "run-infractl.sh"),
      args: ["--mode", "agent", "--update", "--no-restart", "--root", "/opt/infra-agent"],
    });
  });

  it("installe le code reçu et remplace le dossier déjà présent", async () => {
    const root = await mkdtemp(join(tmpdir(), "infra-agent-"));
    roots.push(root);
    await mkdir(join(root, "apps", "agent", "dist"), { recursive: true });
    await writeFile(join(root, "apps", "agent", "dist", "index.js"), "ancien", "utf8");
    const packed = packTar([
      { name: "apps/agent/dist/index.js", data: Buffer.from("nouveau") },
      { name: "packages/utils/dist/index.js", data: Buffer.from("utils") },
    ]);
    await expect(applyServerBundle(root, packed)).resolves.toBe(2);
    await expect(readFile(join(root, "apps", "agent", "dist", "index.js"), "utf8")).resolves.toBe("nouveau");
    await expect(readFile(join(root, "packages", "utils", "dist", "index.js"), "utf8")).resolves.toBe("utils");
  });

  it("refuse un fichier hors du code de l'agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "infra-agent-"));
    roots.push(root);
    const packed = packTar([{ name: "apps/server/dist/index.js", data: Buffer.from("serveur") }]);
    await expect(applyServerBundle(root, packed)).rejects.toThrow(/hors du code agent|sans le programme/);
    await expect(readFile(join(root, "apps", "server", "dist", "index.js"), "utf8")).rejects.toThrow();
  });
});

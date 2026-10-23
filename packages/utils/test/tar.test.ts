import { describe, expect, it } from "vitest";
import { packTar, unpackTar } from "../src/tar.js";

describe("archive tar", () => {
  it("restaure les fichiers empaquetés", () => {
    const packed = packTar([
      { name: "apps/agent/dist/index.js", data: Buffer.from("agent") },
      { name: "packages/types/dist/index.js", data: Buffer.from("types") },
    ]);
    expect(unpackTar(packed)).toEqual([
      { name: "apps/agent/dist/index.js", data: Buffer.from("agent") },
      { name: "packages/types/dist/index.js", data: Buffer.from("types") },
    ]);
  });

  it("refuse un chemin qui sort de l'archive", () => {
    const packed = packTar([{ name: "../secret", data: Buffer.from("nope") }]);
    expect(() => unpackTar(packed)).toThrow(/chemin d'archive refusé/);
  });
});

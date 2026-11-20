import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const REPO = resolve(import.meta.dir, "../..");
const BUILD = join(REPO, "scripts/build.ts");
const PKG_VERSION = "7.7.7";
// a linux-x64 binary does not run on darwin/arm64, so the target the test builds and
// executes is derived, not fixed
const HOST = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/**
 * scripts/build.ts is the only place RELEASE_TAG turns into a --define, and release.yml only
 * looks at the result after four binaries are built (a build that dropped the define would
 * ship four binaries naming package.json's version). Compiling here proves the tag reaches a
 * binary at all, and that a build without a tag still reads package.json.
 *
 * Only the host target is compiled: the other three cannot be run on this machine, and their
 * shape and embedded tag are scripts/check-binaries.sh's job.
 */
let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  // src is copied, not symlinked: a symlink would resolve ../package.json to the real one
  cpSync(join(REPO, "src"), join(sb.dir, "src"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(sb.dir, "node_modules"));
  writeFileSync(
    join(sb.dir, "package.json"),
    JSON.stringify({ name: "x", type: "module", version: PKG_VERSION }),
  );
});
afterEach(() => removeSandbox(sb));

function build(env: Record<string, string>): void {
  const run = Bun.spawnSync([process.execPath, BUILD, HOST], {
    cwd: sb.dir,
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...env },
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
}

function version(env: Record<string, string> = {}): string {
  const run = Bun.spawnSync([join(sb.dir, `dist/beeminder-cli-${HOST}`), "--version"], {
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...env },
  });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().trim();
}

describe("scripts/build.ts", () => {
  test("a binary built with RELEASE_TAG names that version (without the leading v)", () => {
    build({ RELEASE_TAG: "v3.2.1-rc.4" });

    expect(version()).toBe("3.2.1-rc.4");
  });

  test("without RELEASE_TAG it names the package.json version, and env cannot forge it", () => {
    build({});

    expect(version({ __BUILD_VERSION__: "0.0.1" })).toBe(PKG_VERSION);
  });

  test("naming a target builds only that target", () => {
    build({ RELEASE_TAG: "v3.2.1-rc.4" });

    expect(existsSync(join(sb.dir, `dist/beeminder-cli-${HOST}`))).toBe(true);
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      if (target === HOST) continue;
      expect(existsSync(join(sb.dir, `dist/beeminder-cli-${target}`))).toBe(false);
    }
  });
});

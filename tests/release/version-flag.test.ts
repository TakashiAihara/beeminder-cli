import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { makeSandbox, removeSandbox, runCli, type Sandbox } from "./helpers/cli.ts";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => removeSandbox(sb));

describe("--version", () => {
  // the version identifier is substituted at compile time, not read from env at runtime;
  // even a development run cannot be made to name an embedded version via the user's env
  test("a development run names the package.json version even when the define identifier is in env", async () => {
    const r = await runCli(sb, ["--version"], { __BUILD_VERSION__: "0.0.1" });

    expect(r.code).toBe(0);
    expect(r.out).toBe(`${pkg.version}\n`);
  });

  test("a binary built with a define names the version that was defined", async () => {
    const out = join(sb.dir, "cli.js");
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      CLI,
      "--target=bun",
      "--define",
      '__BUILD_VERSION__="9.8.7-rc.6"',
      "--outfile",
      out,
    ]);
    expect(build.exitCode).toBe(0);

    const run = Bun.spawnSync([process.execPath, out, "--version"], {
      // the user's env cannot forge the version
      env: { PATH: process.env.PATH, HOME: sb.home, __BUILD_VERSION__: "0.0.1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("9.8.7-rc.6\n");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/run-binary.sh");

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => removeSandbox(sb));

// instead of a real binary, place an sh script that answers --help and --version per case
function fakeBinary(body: string): string {
  const file = join(sb.dir, "beeminder-cli-linux-x64");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o644);
  return file;
}

const run = (file: string, tag: string) =>
  Bun.spawnSync(["/bin/sh", SCRIPT, file, tag], { cwd: sb.dir, env: { PATH: process.env.PATH } });

describe("scripts/run-binary.sh", () => {
  const good = `case "$1" in --help) echo usage ;; --version) echo 0.4.2-rc.7 ;; *) exit 9 ;; esac`;

  test("exits 0 when --help passes and --version matches the tag (v removed), chmod +x'ing first", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("0.4.2-rc.7");
  });

  test("exits 1 when --version differs from the tag, and prints both values", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.8");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("0.4.2-rc.7");
    expect(r.stderr.toString()).toContain("0.4.2-rc.8");
  });

  test("exits 1 when --help fails, and never asks --version", () => {
    const r = run(
      fakeBinary(
        `case "$1" in --help) echo broken >&2; exit 3 ;; --version) touch "${sb.dir}/version-was-run"; echo 0.4.2-rc.7 ;; esac`,
      ),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--help");
    expect(existsSync(join(sb.dir, "version-was-run"))).toBe(false);
  });

  test("exits 1 when --version fails", () => {
    const r = run(
      fakeBinary(`case "$1" in --help) echo usage ;; --version) exit 4 ;; esac`),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--version");
  });

  test("exits 1 when the file is missing", () => {
    const r = run(join(sb.dir, "beeminder-cli-darwin-arm64"), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("beeminder-cli-darwin-arm64 does not exist");
  });

  test("exits 2 when arguments are missing", () => {
    const r = Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: { PATH: process.env.PATH } });

    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage:");
  });
});

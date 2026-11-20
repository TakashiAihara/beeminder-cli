import { setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// the tests here spawn subprocesses (a compile, install.sh) that take more than the default 5s
setDefaultTimeout(30_000);

const CLI = resolve(import.meta.dir, "../../../src/cli.ts");
const HANG_LIMIT_MS = 20_000;

export type Env = Record<string, string | undefined>;
export type Ran = { code: number; out: string; err: string };

export type Sandbox = { dir: string; home: string };

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "beeminder-cli-test-"));
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, home };
}

export function removeSandbox(sb: Sandbox): void {
  rmSync(sb.dir, { recursive: true, force: true });
}

// env is rebuilt rather than inherited so a real BEEMINDER_* or user config cannot leak in
function cliEnv(sb: Sandbox, env: Env): Record<string, string> {
  const merged = { PATH: process.env.PATH, HOME: sb.home, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

export function startCli(sb: Sandbox, args: string[], env: Env = {}) {
  return Bun.spawn([process.execPath, CLI, ...args], {
    cwd: sb.dir,
    env: cliEnv(sb, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function finishCli(proc: ReturnType<typeof startCli>): Promise<Ran> {
  const killer = setTimeout(() => proc.kill(), HANG_LIMIT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(killer);
  }
}

export async function runCli(sb: Sandbox, args: string[], env: Env = {}): Promise<Ran> {
  return finishCli(startCli(sb, args, env));
}

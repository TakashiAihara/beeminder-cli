import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-binaries.sh");
const TAG = "v0.1.1-rc.2";
const VERSION = "0.1.1-rc.2";
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

// what `file -b` really prints, trimmed to the image and CPU words
const IMAGES: Record<(typeof TARGETS)[number], string> = {
  "linux-x64": "ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked",
  "linux-arm64": "ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), dynamically linked",
  "darwin-x64": "Mach-O 64-bit x86_64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
  "darwin-arm64": "Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
};

let sb: Sandbox;
// a fake file(1): each target's description lives in descs/<name>.txt so a test can swap
// the reported image
let descs: string;

beforeEach(() => {
  sb = makeSandbox();
  descs = join(sb.dir, "descs");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  mkdirSync(descs);

  const file = join(sb.dir, "bin", "file");
  writeFileSync(
    file,
    `#!/bin/sh
for last; do :; done
name="\${last##*/}"
[ -f "${descs}/\${name}.txt" ] || { echo "cannot open \${last}" >&2; exit 1; }
cat "${descs}/\${name}.txt"
`,
  );
  chmodSync(file, 0o755);
});
afterEach(() => removeSandbox(sb));

/** swap what file(1) reports for this target */
function imageOf(target: (typeof TARGETS)[number], image: string): void {
  writeFileSync(join(descs, `beeminder-cli-${target}.txt`), image);
}

/**
 * a fake binary: only `site` is shaped like the real --define output, which is what the tag
 * is checked against
 */
type Opts = {
  /** the definition --define emits, verbatim (default: the Bun 1.4.5 shape); until changed, the check sees the real thing */
  site?: string;
  /** what --version answers (default: the embedded version) */
  says?: string;
  /** extra bytes a real binary carries but a define does not; each line is prefixed with # to stay a comment */
  extra?: string;
};

/** extra bytes go in as comments so the fake still runs under /bin/sh */
function asComments(text: string): string {
  return text
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

/** a fake binary that carries the tag in the --define shape but answers --version with another value */
function writeBinary(target: (typeof TARGETS)[number], embedded: string, opts: Opts = {}): void {
  const path = join(sb.dir, "dist", `beeminder-cli-${target}`);
  writeFileSync(
    path,
    `#!/bin/sh
# ${opts.site ?? `var VERSION = "${embedded}";`}
${opts.extra ? asComments(opts.extra) : ""}
case "$1" in
  --version) echo ${opts.says ?? embedded} ;;
  --help) echo "usage: beeminder-cli" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

/** prepare a dist where all four claim their own target's image and carry the tag */
function built(opts: { only?: (typeof TARGETS)[number]; version?: string } = {}): void {
  for (const target of TARGETS) {
    imageOf(target, IMAGES[target]);
    if (opts.only && target !== opts.only) continue;
    writeBinary(target, opts.version ?? VERSION);
  }
}

function check(env: Record<string, string | undefined> = {}, path?: string) {
  const merged = {
    PATH: path ?? `${join(sb.dir, "bin")}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    TAG,
    ...env,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  return Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: clean });
}

describe("check-binaries.sh", () => {
  test("passes when all four claim their own image and carry the tag", () => {
    built();

    const r = check();

    expect(r.exitCode).toBe(0);
  });

  test("fails when a binary claims another CPU's image", () => {
    built();
    // if the build produced four host binaries, --version only looks at linux-x64
    imageOf("linux-arm64", IMAGES["linux-x64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/beeminder-cli-linux-arm64");
  });

  test("fails when a Mach-O is misread as ELF", () => {
    built();
    imageOf("darwin-arm64", IMAGES["linux-arm64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/beeminder-cli-darwin-arm64");
  });

  test("fails when a binary does not carry the tag (the embedding did not take)", () => {
    built();
    writeBinary("darwin-x64", "0.1.0");

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/beeminder-cli-darwin-x64 does not carry the tag");
  });

  test("fails when the runnable binary names a version other than the tag", () => {
    built();
    // even when the tag is embedded, different syntax makes --version answer another value
    writeBinary("linux-x64", VERSION, { says: "0.1.0" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`says 0.1.0, tag is ${TAG}`);
  });

  test("fails when the three that cannot run are missing (build succeeded but files are not there)", () => {
    built({ only: "linux-x64" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/beeminder-cli-linux-arm64 was not built");
  });

  test("stops without TAG", () => {
    built();

    const r = check({ TAG: undefined });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("TAG");
  });

  // without file(1) there is no way to check the three this runner cannot run, so do not
  // pass silently
  test("stops without file(1)", () => {
    built();

    const r = check({}, "/nonexistent");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("file(1)");
  });
});

// part of the `bun create` template every Bun binary bundles. A real binary carries this
// "version": "0.1.0" three times. Its version digits are not glued to other version
// characters, so a check that only looks at what surrounds the version always matches and
// an rc.2 binary would pass a v0.1.0 tag. That is why counting the tag is limited to the
// line --define emits.
const BUN_TEMPLATE = `{
  "name": "bun-react-template",
  "version": "0.1.0",
  "private": true,
  "type": "module",
}`;

// the embedded version is counted as the tag only in the --define shape
describe("the embedded version is counted as the tag only in the --define shape", () => {
  const TAG_010 = "v0.1.0";
  const noTag = "dist/beeminder-cli-darwin-x64 does not carry the tag";

  test("passes when the tag's define is there (all four)", () => {
    built({ version: "0.1.0" });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(0);
  });

  test("a define with a different version is not counted as the tag", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0-rc.2");

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });

  // the real collision: an rc.2 binary carries the bundled template's 0.1.0. Without
  // reading the define, a v0.1.0 tag would pass and the rc.2 binary would ship as 0.1.0
  test("an rc.2 binary does not pass a v0.1.0 tag just because the bundled template has 0.1.0", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.1-rc.2", { extra: BUN_TEMPLATE });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
    // also prints the needle it searched for, so a drift shows in the log what was looked
    // for and not found
    expect(r.stderr.toString()).toContain(`no 'var VERSION = "0.1.0";' in it`);
  });

  // bun is pinned to 1.4.5 via mise. If the emitted shape drifts the match is lost.
  // Stopping the release rather than shipping green is intentional: fix the shape each
  // time it changes.
  test("a define shape different from Bun 1.4.5's does not pass (drift closes the release)", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0", { site: `var VERSION="0.1.0"` });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });
});

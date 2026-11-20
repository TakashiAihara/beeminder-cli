import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/publish-release.sh");
const TAG = "v0.1.1-rc.2";
const BUILT = "aaa  beeminder-cli-linux-x64\n";
const OTHER = "bbb  beeminder-cli-linux-x64\n";

let sb: Sandbox;
let calls: string;

// the temp repo's commits must not see the user config: a commit.gpgsign=true there would
// make every commit fail, and a missing user.name the opposite. Identity comes from the
// explicit author/committer variables instead.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const git = (...a: string[]) =>
  Bun.spawnSync(["git", ...a], {
    cwd: sb.dir,
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...GIT_ENV },
  });

beforeEach(() => {
  sb = makeSandbox();
  calls = join(sb.dir, "gh-calls");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), BUILT);
  writeFileSync(join(sb.dir, "dist", "beeminder-cli-linux-x64"), "binary");
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");

  // a fake gh that logs the arguments it was called with; CREATE / VIEW / PUBLISHED_SUMS /
  // PUBLISHED_BINARIES / IS_DRAFT decide the outcome
  const gh = join(sb.dir, "bin", "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$1" = api ]; then
  case "$*" in
    *"--method POST"*git/refs*)
      if [ -n "\${REF_CREATE_ERROR:-}" ]; then echo "\${REF_CREATE_ERROR}" >&2; exit 1; fi
      if [ -n "\${REF_EXISTING:-}" ]; then echo "gh: Reference already exists (HTTP 422)" >&2; exit 1; fi
      if [ -n "\${REF_422_OTHER:-}" ]; then echo "gh: \${REF_422_OTHER} (HTTP 422)" >&2; exit 1; fi
      exit 0 ;;
    *"--method DELETE"*git/refs/tags/*) exit 0 ;;
    *git/ref/tags/*)
      if [ -n "\${REF_READ_ERROR:-}" ]; then echo "\${REF_READ_ERROR}" >&2; exit 1; fi
      echo "\${REF_TYPE:-commit} \${REF_NOW:-\${REF_EXISTING:-}}" ;;
    *git/tags/*)
      if [ -n "\${TAG_READ_ERROR:-}" ]; then echo "\${TAG_READ_ERROR}" >&2; exit 1; fi
      echo "\${TAG_TARGET:-}" ;;
    *) exit 98 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "release create") exit "\${CREATE:-0}" ;;
  "release view")
    case "$*" in
      *isDraft*) echo "\${IS_DRAFT:-false}" ;;
      *assets*) printf '%s\n' "\${PUBLISHED_BINARIES:-}" ;;
      *)
        if [ -n "\${VIEW_ERROR:-}" ]; then echo "\${VIEW_ERROR}" >&2; exit 1; fi
        if [ "\${VIEW:-0}" != 0 ]; then echo "release not found" >&2; fi
        exit "\${VIEW:-0}" ;;
    esac ;;
  "release list")
    if [ -n "\${LIST_ERROR:-}" ]; then echo "\${LIST_ERROR}" >&2; exit 1; fi
    if [ -n "\${PUBLISHED_TAGS+x}" ]; then printf '%s\n' "\${PUBLISHED_TAGS}"; else git tag --list 'v*'; fi ;;
  "release download")
    [ -n "$PUBLISHED_SUMS" ] || exit 1
    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    cp "$PUBLISHED_SUMS" "$dir/SHA256SUMS" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});
afterEach(() => removeSandbox(sb));

const head = () =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: sb.dir,
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...GIT_ENV },
  })
    .stdout.toString()
    .trim();

function publish(env: Record<string, string | undefined> = {}) {
  const published = join(sb.dir, "published");
  return Bun.spawnSync(["/bin/sh", SCRIPT], {
    cwd: sb.dir,
    env: {
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      HOME: sb.home,
      ...GIT_ENV,
      TAG,
      MAIN_SHA: head(),
      RELEASE_TRIGGER: "push",
      PUBLISHED_SUMS: published,
      PUBLISHED_BINARIES: "beeminder-cli-linux-x64",
      ...env,
    },
  });
}

/** the SHA256SUMS of the already published release */
function published(sums: string): void {
  writeFileSync(join(sb.dir, "published"), sums);
}

const ghCalls = () => readFileSync(calls, "utf8");

describe("publish-release.sh", () => {
  test("creates a release that does not exist yet", () => {
    const r = publish();

    expect(r.exitCode).toBe(0);
    expect(head()).toMatch(/^[0-9a-f]{40}$/);
    expect(ghCalls()).toContain(`release create v0.1.1-rc.2 --target ${head()} --latest=true `);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("a release for a commit that is not main's head is not made Latest", () => {
    const r = publish({ MAIN_SHA: "0123456789abcdef0123456789abcdef01234567" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`--target ${head()} --latest=false `);
  });

  // even with nothing to compare against, the comparison must not die failing to find a
  // partner
  test("a checkout with no tags at all is not stopped by the version comparison", () => {
    const r = publish({ MAIN_SHA: "0123456789abcdef0123456789abcdef01234567", VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} --latest=false `);
  });

  test("stops without making a release when MAIN_SHA is missing", () => {
    const r = publish({ MAIN_SHA: "" });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("MAIN_SHA");
    expect(existsSync(calls)).toBe(false);
  });

  test("already published with the same SHA256SUMS succeeds doing nothing", () => {
    published(BUILT);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
    // says success only after reading the release's asset list, not just the sums
    expect(ghCalls()).toContain(`release view ${TAG} --json assets`);
  });

  // a draft is not pointed to by /releases/latest, so it cannot count as published
  test("an existing release left as a draft is not a success", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", IS_DRAFT: "true" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} is a draft`);
    expect(r.stdout.toString()).not.toContain("already published");
  });

  // same SHA256SUMS but missing binaries on the release would be a broken distribution
  test("same SHA256SUMS but missing binaries is not a success", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_BINARIES: "SHA256SUMS" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} has no asset beeminder-cli-linux-x64`);
  });

  test("an empty SHA256SUMS is not read as equal; it fails", () => {
    published("");
    writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), "");

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("empty SHA256SUMS");
  });

  test("a published release with different SHA256SUMS fails without overwriting", () => {
    published(OTHER);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("not overwriting");
  });

  test("an unreadable release means create's failure was the real one and it fails", () => {
    const r = publish({ CREATE: "1", VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("the failure above is the real one");
  });

  test("a published release without SHA256SUMS is not read as equal; it fails", () => {
    const r = publish({ CREATE: "1", PUBLISHED_SUMS: "" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("without SHA256SUMS");
  });

  test("never uploads nor --clobbers onto a published release whose SHA256SUMS differ", () => {
    published(OTHER);
    publish({ CREATE: "1" });

    expect(ghCalls()).not.toContain("upload");
    expect(ghCalls()).not.toContain("--clobber");
  });

  // gh release create uses --target only when it makes the tag itself. With the tag
  // already there it stays on another commit, so binaries from a different commit would
  // ship under the tag that was downloaded.
  describe("when the tag already points at another commit", () => {
    test("stops without making a release", () => {
      git("tag", TAG);
      const tagged = head();
      writeFileSync(join(sb.dir, "file"), "x");
      git("add", "-A");
      git("commit", "-q", "-m", "y");
      expect(head()).not.toBe(tagged);

      const r = publish();

      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(`tag ${TAG} already points at ${tagged}`);
      expect(existsSync(calls)).toBe(false);
    });

    // a re-run on the same commit (re-running a dead run, dispatching an existing tag)
    // must pass
    test("a tag on the same commit goes on to make the release", () => {
      git("tag", TAG);

      const r = publish();

      expect(r.exitCode).toBe(0);
      expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} `);
    });
  });
});

describe("publish-release.sh: a newer version on an old commit", () => {
  // v0.1.0 on old (HEAD), v0.2.0-rc.3 on the main ahead of it; HEAD is put back on old
  let oldSha: string;
  let mainSha: string;
  beforeEach(() => {
    oldSha = head();
    git("tag", "v0.1.0");
    git("commit", "-q", "--allow-empty", "-m", "main");
    mainSha = head();
    git("tag", "v0.2.0-rc.3");
    git("checkout", "-q", oldSha);
  });

  test("a new tag whose version outranks main's is not published from an old commit", () => {
    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.3");
    expect(r.stderr.toString()).toContain("git push origin :refs/tags/v0.2.0");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("a hand-pushed new tag already in the checkout is still stopped, compared against everything but itself", () => {
    git("tag", "v0.2.0");

    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.3");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("a version below the existing highest is published even from an old commit, and not made Latest", () => {
    const r = publish({ TAG: "v0.0.9", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.0.9 --target ${oldSha} --latest=false `);
  });

  test("a re-run for an already published tag is not stopped even on an old commit", () => {
    git("tag", "v0.3.0");
    published(BUILT);

    const r = publish({ TAG: "v0.3.0", MAIN_SHA: mainSha, CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  // rc's n is not a string: rc.10 and rc.9 are compared, and a textual sort would flip
  // the order
  test("rc numbers are compared as numbers", () => {
    git("tag", "v0.2.0-rc.9");

    const r = publish({ TAG: "v0.2.0-rc.10", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.9");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("a normal final version on main's head is made Latest", () => {
    git("checkout", "-q", mainSha);

    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.2.0 --target ${mainSha} --latest=true `);
  });
});

describe("publish-release.sh: version ordering and the three paths", () => {
  // lexically v0.1.0 < v0.10.0-rc.1 < v0.2.0 < v0.9.0; the semver highest v0.10.0-rc.1
  // sits neither first nor last
  let oldSha: string;
  let mainSha: string;
  beforeEach(() => {
    oldSha = head();
    git("tag", "v0.1.0");
    git("tag", "v0.2.0");
    git("tag", "v0.9.0");
    git("commit", "-q", "--allow-empty", "-m", "main");
    mainSha = head();
    git("tag", "v0.10.0-rc.1");
    git("checkout", "-q", oldSha);
  });
  const old = (env: Record<string, string | undefined>) =>
    publish({ MAIN_SHA: mainSha, VIEW: "1", ...env });

  test("minor is compared as a number: v0.9.5 is below v0.10.0-rc.1 so it is published", () => {
    const r = old({ TAG: "v0.9.5" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.9.5 --target ${oldSha} --latest=false `);
  });

  test("a final version outranks its rcs: v0.10.0 is stopped", () => {
    const r = old({ TAG: "v0.10.0" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("decided by major: v1.0.0 is stopped", () => {
    const r = old({ TAG: "v1.0.0" });

    expect(r.exitCode).toBe(1);
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("decided by patch: with v0.10.2 on main, v0.10.3 is stopped and v0.10.1 passes", () => {
    git("tag", "v0.10.2", mainSha);

    const high = old({ TAG: "v0.10.3" });
    expect(high.exitCode).toBe(1);
    expect(high.stderr.toString()).toContain("v0.10.2");

    const low = old({ TAG: "v0.10.1" });
    expect(low.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.10.1 --target ${oldSha} --latest=false `);
  });

  test("an automatic rc when main has moved on publishes nothing, exits green and leaves a notice", () => {
    const r = old({ TAG: "v0.10.0-rc.2", RELEASE_TRIGGER: "workflow_run" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("::notice::");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("git/refs");
  });

  test("workflow_dispatch also stops a release-less higher version (closes the escape for a tag push refused)", () => {
    const r = old({ TAG: "v0.10.0", RELEASE_TRIGGER: "workflow_dispatch" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(ghCalls()).not.toContain("release create");
  });

  test("a workflow_dispatch re-release is not stopped by version when the release exists", () => {
    published(BUILT);

    const r = old({ TAG: "v0.10.0", RELEASE_TRIGGER: "workflow_dispatch", VIEW: "0", CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  test("an automatic rc on main's head is published and made Latest", () => {
    git("checkout", "-q", mainSha);

    const r = old({ TAG: "v0.10.0-rc.2", RELEASE_TRIGGER: "workflow_run" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).not.toContain("::notice::");
    expect(ghCalls()).toContain(`release create v0.10.0-rc.2 --target ${mainSha} --latest=true `);
  });

  test("only published releases are compared: a leftover higher tag with no release sets no ceiling", () => {
    git("tag", "v1.0.0", oldSha);

    const r = old({
      TAG: "v0.11.0",
      PUBLISHED_TAGS: "v0.1.0\nv0.2.0\nv0.10.0-rc.1\nv0.9.0",
    });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release list --exclude-drafts --limit 1000 ");
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(r.stderr.toString()).not.toContain("v1.0.0");
    expect(ghCalls()).not.toContain("release create");
  });

  test("an unreadable release list stops it with the reason", () => {
    const r = old({ TAG: "v0.9.5", LIST_ERROR: "HTTP 503: Service Unavailable" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 503: Service Unavailable");
    expect(ghCalls()).not.toContain("release create");
  });

  test("the refusal message also shows the dispatch path for releasing a legitimate tag later", () => {
    const r = old({ TAG: "v0.10.0" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("workflow_dispatch");
  });

  test("stops without making a release when RELEASE_TRIGGER is missing", () => {
    const r = old({ TAG: "v0.9.5", RELEASE_TRIGGER: undefined });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("RELEASE_TRIGGER");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("a failure to read whether the release exists (other than not found) stops it with the reason", () => {
    const r = old({ TAG: "v0.9.5", VIEW_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 502: Bad Gateway");
    expect(ghCalls()).not.toContain("release create");
  });

  test("an over-wide version number is not a release shape and is stopped", () => {
    const r = old({ TAG: "v99999999999999999999.0.0" });

    expect(r.exitCode).toBe(1);
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("a leading-zero tag is not counted among the compared", () => {
    git("tag", "v0.011.0", mainSha);

    const r = old({ TAG: "v0.10.0-rc.2" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(r.stderr.toString()).not.toContain("v0.011.0");
  });
});

describe("publish-release.sh: creating the tag first closes the race", () => {
  const other = "0123456789abcdef0123456789abcdef01234567";

  test("the tag is made first via the API on the built commit, and the release is only attached to an existing tag", () => {
    const r = publish({ VIEW: "1" });

    expect(r.exitCode).toBe(0);
    const calls = ghCalls();
    expect(calls).toContain(
      `api --method POST repos/{owner}/{repo}/git/refs -f ref=refs/tags/${TAG} -f sha=${head()}`,
    );
    expect(calls).toMatch(new RegExp(`release create ${TAG} .*--verify-tag`));
    expect(calls.indexOf("git/refs")).toBeLessThan(calls.indexOf("release create"));
  });

  test("a same-named tag appearing on another commit after the check stops without making a release", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: other });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(other);
    expect(r.stderr.toString()).toContain(head());
    expect(ghCalls()).not.toContain("release create");
  });

  test("an existing tag on the same commit (a re-run) gets the release attached", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: head() });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toMatch(new RegExp(`release create ${TAG} .*--verify-tag`));
  });

  test("an annotated tag is compared by the commit it points at", () => {
    const tagObject = "fedcba9876543210fedcba9876543210fedcba98";

    const same = publish({
      VIEW: "1",
      REF_EXISTING: tagObject,
      REF_TYPE: "tag",
      TAG_TARGET: head(),
    });
    expect(same.exitCode).toBe(0);
    expect(ghCalls()).toContain(`git/tags/${tagObject}`);

    const diff = publish({
      VIEW: "1",
      REF_EXISTING: tagObject,
      REF_TYPE: "tag",
      TAG_TARGET: other,
    });
    expect(diff.exitCode).toBe(1);
    expect(diff.stderr.toString()).toContain(other);
  });

  test("a failure to create the tag for a reason other than 'already exists' stops it with the reason", () => {
    const r = publish({
      VIEW: "1",
      REF_CREATE_ERROR: "HTTP 403: Resource not accessible by integration",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 403: Resource not accessible by integration");
    expect(ghCalls()).not.toContain("release create");
  });

  test("an existing tag's ref is read by name, and an annotated one's tag object is read", () => {
    const tagObject = "fedcba9876543210fedcba9876543210fedcba98";

    publish({ VIEW: "1", REF_EXISTING: tagObject, REF_TYPE: "tag", TAG_TARGET: head() });

    const calls = ghCalls();
    expect(calls).toContain(`api repos/{owner}/{repo}/git/ref/tags/${TAG} `);
    expect(calls).toContain(`api repos/{owner}/{repo}/git/tags/${tagObject} `);
  });

  test("an unreadable existing tag stops it with the reason", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: head(), REF_READ_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 502: Bad Gateway");
    expect(ghCalls()).not.toContain("release create");
  });

  test("a 422 other than 'already exists' is not read as an existing tag; it stops", () => {
    const r = publish({ VIEW: "1", REF_422_OTHER: "Repository rule violations found" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Repository rule violations found");
    expect(ghCalls()).not.toContain("git/ref/tags/");
    expect(ghCalls()).not.toContain("release create");
  });

  test("a tag this run made is deleted when no release could be made and none exists", () => {
    const r = publish({ VIEW: "1", CREATE: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain(`api --method DELETE repos/{owner}/{repo}/git/refs/tags/${TAG}`);
  });

  test("even when the release could not be made, a surviving release keeps the tag (never detach a release)", () => {
    const r = publish({ CREATE: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
    expect(r.stderr.toString()).toContain("is kept: a release exists for it");
  });

  test("a run that made the release does not delete the tag even when the next view answers not found", () => {
    const r = publish({ VIEW: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("not knowing whether a release exists keeps the tag", () => {
    const r = publish({ CREATE: "1", REF_NOW: head(), VIEW_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("a tag moved to another commit just before deletion is not deleted", () => {
    const r = publish({
      VIEW: "1",
      CREATE: "1",
      REF_NOW: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("an unreadable annotated tag object stops it with the reason", () => {
    const r = publish({
      VIEW: "1",
      REF_EXISTING: "fedcba9876543210fedcba9876543210fedcba98",
      REF_TYPE: "tag",
      TAG_READ_ERROR: "HTTP 500: Internal Server Error",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 500: Internal Server Error");
    expect(ghCalls()).not.toContain("release create");
  });

  test("a pre-existing tag is not deleted even when the release cannot be made", () => {
    const r = publish({ VIEW: "1", CREATE: "1", REF_EXISTING: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  // a leftover tag appears to the next run under the same name and pushes the next tag
  // above it, so a tag must not be created once the decision is to stop
  test("a run stopped by the version creates no tag either", () => {
    git("tag", "v0.1.0");

    const r = publish({
      TAG: "v9.9.9-rc.1",
      MAIN_SHA: "0123456789abcdef0123456789abcdef01234567",
      VIEW: "1",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.1.0");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("git/refs");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });
});

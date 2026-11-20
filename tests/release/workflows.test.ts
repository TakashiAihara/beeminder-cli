import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS = ["ci.yml", "release.yml"];
const dir = resolve(import.meta.dir, "../../.github/workflows");
const read = (file: string) => readFileSync(join(dir, file), "utf8");
// YAML parsing is left to Bun, so only the parts that are read get types
const release = () =>
  Bun.YAML.parse(read("release.yml")) as {
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
      tag: { if?: string; steps: { name: string; run?: string }[] };
      build: { steps: { name: string; run?: string; env?: Record<string, string> }[] };
      publish: {
        permissions?: Record<string, string>;
        steps: { name: string; run?: string; env?: Record<string, string> }[];
      };
    };
  };
type Job = keyof ReturnType<typeof release>["jobs"];
const stepRun = (job: Job, name: string) =>
  release().jobs[job].steps.find((step) => step.name === name)?.run ?? "";
const releaseStep = () =>
  release().jobs.publish.steps.find((step) => step.name === "release")?.run ?? "";

const REPO = "TakashiAihara/beeminder-cli";

// Nothing at hand evaluates GitHub expressions, so the subset the concurrency and gate
// expressions use (string ==, !=, &&, ||, parens) is evaluated naively. Same rules as GHA:
// && returns left when left is falsy, || returns left when truthy, empty string is falsy,
// and a missing path is the empty string.
const evaluate = (tokens: string[], context: Record<string, unknown>): string => {
  let i = 0;
  const peek = () => tokens[i];
  const lookup = (path: string) =>
    String(
      path
        .split(".")
        .reduce<unknown>((v, k) => (v == null ? undefined : (v as never)[k]), context) ?? "",
    );
  const atom = (): string => {
    const token = tokens[i++]!;
    if (token === "(") {
      const value = or();
      i++; // )
      return value;
    }
    return token.startsWith("'") ? token.slice(1, -1) : lookup(token);
  };
  const eq = (): string => {
    const left = atom();
    const op = peek();
    if (op !== "==" && op !== "!=") return left;
    i++;
    const same = atom() === left;
    return op === "==" ? (same ? "true" : "") : same ? "" : "true";
  };
  const and = (): string => {
    let left = eq();
    while (peek() === "&&") {
      i++;
      const right = eq();
      left = left ? right : left;
    }
    return left;
  };
  // a function declaration (hoisted) so atom can refer to it earlier
  function or(): string {
    let left = and();
    while (peek() === "||") {
      i++;
      const right = and();
      left = left || right;
    }
    return left;
  }
  return or();
};

// evaluates release.yml's concurrency expression with the event data of a run and returns
// the group name. run_id is fixed at 1, so every "run_id group" is "release-1".
const groupFor = (eventName: string, event?: string, headRepository?: string) => {
  const source = release()
    .concurrency.group.replace(/^release-\$\{\{/, "")
    .replace(/\}\}$/, "");
  const tokens = [...source.matchAll(/\s*('[^']*'|[A-Za-z_][\w.]*|!=|==|&&|\|\||[()])/g)].map(
    (m) => m[1]!,
  );
  return (
    "release-" +
    evaluate(tokens, {
      github: {
        event_name: eventName,
        run_id: 1,
        repository: REPO,
        event: {
          workflow_run: {
            event,
            head_repository: { full_name: headRepository },
          },
        },
      },
    })
  );
};

// evaluates the tag job's `if` with a run's event data; "true" means the job runs and a
// release can start, "" means every job in the run is skipped
const tagIfFor = (
  eventName: string,
  workflowRun?: { conclusion?: string; event?: string; headRepository?: string },
) => {
  const tokens = [
    ...String(release().jobs.tag.if ?? "").matchAll(
      /\s*('[^']*'|[A-Za-z_][\w.]*|!=|==|&&|\|\||[()])/g,
    ),
  ].map((m) => m[1]!);
  return evaluate(tokens, {
    github: {
      event_name: eventName,
      repository: REPO,
      event: {
        workflow_run: {
          conclusion: workflowRun?.conclusion,
          event: workflowRun?.event,
          head_repository: { full_name: workflowRun?.headRepository },
        },
      },
    },
  });
};

describe("release.yml concurrency", () => {
  // Whether a run can be cancelled is decided per run, not per job, so if a run that skips
  // every job joined main's group it would cancel a queued main run. Even with
  // cancel-in-progress: false, a later run cancels an earlier pending one. That is why
  // only "a CI run for a push to this repo's main" joins the main group.
  test("only the run for a push to this repo's main joins the main group", () => {
    expect(groupFor("workflow_run", "push", REPO)).toBe("release-main");
  });

  // a PR's CI in this repo also fires workflow_run. The jobs are all skipped because the
  // event is not push, but the run itself queues. It must not join main's group.
  test("a run for this repo's PR joins its own run_id group", () => {
    expect(groupFor("workflow_run", "pull_request", REPO)).toBe("release-1");
  });

  // a push to a branch named main inside a fork is not a push to this repo's main, so it
  // goes to the run_id side
  test("a fork's run joins its own run_id group", () => {
    expect(groupFor("workflow_run", "push", "someone/beeminder-cli")).toBe("release-1");
  });

  // a hand-pushed tag's release and a re-dispatch each go in their own group, so a later
  // main run cannot cancel them
  test("a tag push and a manual dispatch join their own run_id groups", () => {
    expect(groupFor("push")).toBe("release-1");
    expect(groupFor("workflow_dispatch")).toBe("release-1");
  });

  test("cancel-in-progress is false", () => {
    expect(release().concurrency["cancel-in-progress"]).toBe(false);
  });
});

// The tag job's `if` is the only thing between a workflow_run event and a release. Each
// condition has its own test: dropping any one of them must make a test fail, not leave
// the gate silently wider.
describe("release.yml: which workflow_run releases", () => {
  const good = { conclusion: "success", event: "push", headRepository: REPO };

  test("a green CI run for a push to this repo's main releases", () => {
    expect(tagIfFor("workflow_run", good)).toBe("true");
  });

  // without conclusion == 'success' a run whose CI failed or was cancelled would release
  // a commit CI called red
  test("a CI run that did not conclude success does not release", () => {
    expect(tagIfFor("workflow_run", { ...good, conclusion: "failure" })).toBe("");
    expect(tagIfFor("workflow_run", { ...good, conclusion: "cancelled" })).toBe("");
  });

  // a PR's CI fires workflow_run too (its head branch can even be named main); without
  // event == 'push' that run would release
  test("a CI run for something that is not a push does not release", () => {
    expect(tagIfFor("workflow_run", { ...good, event: "pull_request" })).toBe("");
  });

  // workflow_run carries the head repository's full name; without comparing it, a green
  // CI run on a fork's main would release here
  test("a green CI run on a fork's main does not release", () => {
    expect(tagIfFor("workflow_run", { ...good, headRepository: "someone/beeminder-cli" })).toBe("");
  });

  // the gate is only for workflow_run: a hand-pushed tag and a re-dispatch have no
  // workflow_run context and must still pass
  test("a tag push and a manual dispatch pass the gate", () => {
    expect(tagIfFor("push")).toBe("true");
    expect(tagIfFor("workflow_dispatch")).toBe("true");
  });
});

describe("action pinning", () => {
  // actions are pinned by commit (a docker image by digest): a substituted action under a
  // moved tag would be used as proof of what "we" built in the signature
  test("everything is pinned by commit SHA / image digest with the version in a trailing comment", () => {
    const uses: string[] = [];
    for (const file of WORKFLOWS) {
      for (const line of read(file).split("\n")) {
        if (!line.includes("uses:")) continue;
        uses.push(line);
        expect(line).toMatch(/uses:\s*\S+@([0-9a-f]{40}|sha256:[0-9a-f]{64})\s+#\s*v\S*\s*$/);
      }
    }

    expect(uses.length).toBeGreaterThan(0);
  });
});

// publish-release.sh compares against main's head and checks who a tag checked out by
// push / dispatch already belongs to. checkout is shallow, so only the fetch in the
// release step can do it. The version comparison reads gh release list, so it does not
// depend on this tag list.
describe("the release.yml publish job", () => {
  test("all tags are fetched before publish-release.sh runs", () => {
    const run = releaseStep();

    expect(run).toContain("+refs/tags/*:refs/tags/*");
    expect(run).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(run.indexOf("+refs/tags/*")).toBeLessThan(run.indexOf("sh scripts/publish-release.sh"));
  });

  // push / workflow_run / workflow_dispatch handle "a tag for a commit that is not main's
  // head" differently. The script can only know the path from the event name, so without
  // this env the `:?` check stops it and it always fails before making a release.
  test("the event name is passed to publish-release.sh", () => {
    const env = release().jobs.publish.steps.find((step) => step.name === "release")?.env ?? {};

    expect(env.RELEASE_TRIGGER).toBe("${{ github.event_name }}");
  });

  // publish-release.sh makes the tag as a ref via the API, so without write permission
  // this job cannot create the tag and every release stops
  test("the release step's job has contents: write so it can create a ref", () => {
    const publish = release().jobs.publish;

    expect(publish.permissions?.contents).toBe("write");
  });
});

// publish-release.sh demands the strict tag shape after `:?` (no leading zeros, no number
// over 9 digits). A laxer shape on the workflow side would run checkout and build
// entirely before failing in the script.
describe("the tag shape in release.yml", () => {
  test("'check the requested tag' sees the same shape as publish-release.sh", () => {
    const run = stepRun("tag", "check the requested tag");

    expect(run).toContain(
      "shape='^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(-rc\\.(0|[1-9][0-9]{0,8}))?$'",
    );
    expect(run).not.toContain("[0-9]+\\.");
  });

  // a tag picked up for a re-run must be releasable later; a laxer shape would fail in
  // the script
  test("'decide the tag' sees a re-run rc tag in the same shape", () => {
    const run = stepRun("tag", "decide the tag");

    expect(run).toContain(
      "grep -E '^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})-rc\\.(0|[1-9][0-9]{0,8})$'",
    );
  });
});

describe("release.yml: each of the four runs on its runner before publish", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type AnyJob = {
    needs?: string | string[];
    "runs-on"?: string;
    permissions?: Record<string, string>;
    strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, string>[] } };
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const uses = (job: AnyJob, action: string) =>
    job.steps.some((s) => s.uses?.startsWith(`${action}@`));

  test("the verify job runs each of the four on the runner for its OS / CPU", () => {
    const verify = jobs().verify!;
    const pairs = (verify.strategy?.matrix?.include ?? [])
      .map((m) => `${m.target} ${m.runner}`)
      .sort();

    expect(pairs).toEqual([
      "darwin-arm64 macos-15",
      "darwin-x64 macos-15-intel",
      "linux-arm64 ubuntu-24.04-arm",
      "linux-x64 ubuntu-24.04",
    ]);
    expect(verify["runs-on"]).toBe("${{ matrix.runner }}");
    expect(verify.strategy?.["fail-fast"]).toBe(false);
  });

  test("verify downloads and checks what build uploaded; it does not build itself", () => {
    const { build, verify } = jobs();

    expect(uses(build!, "actions/upload-artifact")).toBe(true);
    expect(needs(verify!)).toContain("build");
    expect(uses(verify!, "actions/download-artifact")).toBe(true);
    expect(runs(verify!)).not.toContain("bun build");
    expect(runs(verify!)).not.toContain("scripts/build.ts");
    expect(runs(verify!)).toContain("scripts/run-binary.sh");
    expect(runs(verify!)).toMatch(/sha256sum|shasum/);
  });

  test("publish runs only after every verify passes, downloads the same artifact and checks SHA256SUMS", () => {
    const { publish } = jobs();

    expect(needs(publish!)).toEqual(expect.arrayContaining(["build", "verify"]));
    expect(uses(publish!, "actions/download-artifact")).toBe(true);
    expect(runs(publish!)).toMatch(/sha256sum -c|shasum -a 256 -c/);
    expect(uses(publish!, "actions/attest-build-provenance")).toBe(true);
    expect(runs(publish!)).toContain("sh scripts/publish-release.sh");
  });

  test("only the publish job holds write permission", () => {
    const { build, verify, publish } = jobs();

    expect(build!.permissions?.contents ?? "read").toBe("read");
    expect(build!.permissions?.["id-token"]).toBeUndefined();
    expect(verify!.permissions?.contents ?? "read").toBe("read");
    expect(publish!.permissions?.contents).toBe("write");
    expect(publish!.permissions?.["id-token"]).toBe("write");
    expect(runs(build!)).not.toContain("publish-release.sh");
    expect(uses(build!, "actions/attest-build-provenance")).toBe(false);
  });
});

// the SHA256SUMS publish checks are the ones build emitted. If only one of the binaries
// or the sums entered the artifact, what is published and what is checked would diverge.
describe("the artifact build uploads in release.yml", () => {
  type Step = {
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  };
  type Job = { steps: Step[] };
  const job = (name: string) =>
    (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, Job> }).jobs[name]!;
  const upload = () =>
    job("build").steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with ?? {};

  test("the four and SHA256SUMS go up in the same artifact", () => {
    const path = String(upload().path ?? "");

    expect(path).toContain("dist/beeminder-cli-*");
    expect(path).toContain("dist/SHA256SUMS");
  });

  // what runs is the matrix target, what it carries is the tag being published; missing
  // either means checking a different binary or a different tag
  test("verify passes the tag and the target to the script", () => {
    const step = job("verify").steps.find((s) => s.run?.includes("run-binary.sh"));

    expect(step?.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
    expect(step?.env?.TARGET).toBe("${{ matrix.target }}");
    expect(step?.run).toContain('sh scripts/run-binary.sh "dist/beeminder-cli-$TARGET" "$TAG"');
  });
});

describe("release.yml: the checked commit and the artifact are published as is", () => {
  type Step = {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  };
  type AnyJob = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: unknown;
    outputs?: Record<string, string>;
    env?: Record<string, string>;
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const stepsUsing = (job: AnyJob, action: string) =>
    job.steps.filter((s) => s.uses?.startsWith(`${action}@`));

  test("the tag job emits the checked commit's SHA and build / verify / publish check out that SHA", () => {
    const all = jobs();

    expect(all.tag!.outputs?.sha).toBe("${{ steps.commit.outputs.sha }}");
    const commit = all.tag!.steps.find((s) => s.id === "commit");
    expect(commit?.run).toContain('sha="$(git rev-parse HEAD)"');
    expect(commit?.run).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    for (const name of ["build", "verify", "publish"]) {
      const job = all[name]!;
      expect(needs(job)).toContain("tag");
      const checkouts = stepsUsing(job, "actions/checkout");
      expect(checkouts.length).toBe(1);
      expect(checkouts[0]!.with?.ref).toBe("${{ needs.tag.outputs.sha }}");
    }
  });

  test("every job has a time limit so a stuck step does not hold the run", () => {
    for (const name of ["tag", "build", "verify", "publish"]) {
      const limit = jobs()[name]!["timeout-minutes"];

      expect(typeof limit).toBe("number");
      expect(limit!).toBeGreaterThan(0);
      expect(limit!).toBeLessThanOrEqual(30);
    }
  });

  test("the artifact has an explicit retention and verify and publish download the name build uploaded", () => {
    const { build, verify, publish } = jobs();
    const up = stepsUsing(build!, "actions/upload-artifact");

    expect(up.length).toBe(1);
    const retention = up[0]!.with?.["retention-days"];
    expect(typeof retention).toBe("number");
    expect(retention as number).toBeLessThanOrEqual(30);
    const name = up[0]!.with?.name;
    expect(typeof name).toBe("string");
    for (const job of [verify!, publish!]) {
      const down = stepsUsing(job, "actions/download-artifact");
      expect(down.length).toBe(1);
      expect(down[0]!.with?.name).toBe(name);
    }
  });

  test("verify checks SHA256SUMS on Linux and macOS alike and does not swallow run-binary.sh's failure", () => {
    const text = runs(jobs().verify!);

    expect(text).toContain("sha256sum -c");
    expect(text).toContain("shasum -a 256 -c");
    expect(text).toMatch(/^\s*sh scripts\/run-binary\.sh [^\n]*$/m);
    expect(text).not.toMatch(/run-binary\.sh[^\n]*(\|\||;)/);
  });

  test("publish gates on the tag output, checks all files, and receives TAG", () => {
    const publish = jobs().publish!;

    expect(publish.if).toBe("needs.tag.outputs.tag != ''");
    expect(runs(publish)).toMatch(/^\s*sha256sum -c SHA256SUMS\s*$/m);
    expect(publish.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
  });

  test("permissions are written as objects, and only publish holds signing permissions", () => {
    const { build, verify, publish } = jobs();

    for (const job of [build!, verify!, publish!]) expect(typeof job.permissions).toBe("object");
    for (const job of [build!, verify!]) {
      const p = job.permissions as Record<string, string>;
      expect(p["id-token"]).toBeUndefined();
      expect(p.attestations).toBeUndefined();
      expect(p.contents).toBe("read");
    }
    const p = publish!.permissions as Record<string, string>;
    expect(p.attestations).toBe("write");
  });
});

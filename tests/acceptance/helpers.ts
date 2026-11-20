import { expect } from "bun:test";

export const TOKEN = "bm-test-token-7f3a9c1e5d42";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  base: string;
  // null means the variable is not set at all
  token?: string | null;
  // extra environment variables for the child, e.g. BEEMINDER_TIMEOUT_MS
  env?: Record<string, string>;
};

// Not 127.0.0.1:0 on purpose: callers need the number before anything listens on it.
export const freePort = (): number => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

export const runCli = async (args: string[], opts: RunOptions): Promise<CliResult> => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BEEMINDER_API_BASE: opts.base,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) env.BEEMINDER_AUTH_TOKEN = token;
  Object.assign(env, opts.env);

  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);

  // Reading before waiting: output past the pipe capacity would otherwise block the child.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  expect(stdout).not.toContain(TOKEN);
  expect(stderr).not.toContain(TOKEN);
  return { exitCode, stdout, stderr };
};

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`stdout is not valid JSON: ${JSON.stringify(text.slice(0, 200))}`);
  }
};

const record = async (req: Request): Promise<RecordedRequest> => {
  const url = new URL(req.url);
  return {
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    body: await req.text(),
  };
};

export type Fake = {
  base: string;
  requests: RecordedRequest[];
  stop: () => void;
};

// text, when set, is sent as a text/plain body instead of the JSON body.
export type FakeReply = { status: number; body: unknown; text?: string };

const defaultReply = (req: RecordedRequest): FakeReply => ({
  status: 200,
  body: req.method === "GET" && /\/(goals|datapoints)\.json$/.test(req.path) ? [] : { id: "1" },
});

// The base carries a path prefix like the real API does, so prefix handling is exercised too.
export const startFake = (reply: (req: RecordedRequest) => FakeReply = defaultReply): Fake => {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const recorded = await record(req);
      requests.push(recorded);
      const { status, body, text } = reply(recorded);
      if (text !== undefined) {
        return new Response(text, { status, headers: { "content-type": "text/plain" } });
      }
      return Response.json(body, { status });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}/api/v1`,
    requests,
    stop: () => void server.stop(true),
  };
};

// Accepts the TCP connection and never answers, so only a client-side timeout can end the request.
export const startHang = (): { base: string; stop: () => void } => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  return {
    base: `http://127.0.0.1:${server.port}/api/v1`,
    stop: () => void server.stop(true),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const portIsFree = (port: number): boolean => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

export type Mock = {
  base: string;
  requests: RecordedRequest[];
  stop: () => Promise<void>;
};

// Prism only accepts a query-string auth_token (the spec declares no body scheme), while the CLI
// sends it in the JSON body for POST/PUT. The front proxy lifts it into the query so Prism can
// still validate everything else, and records what the CLI actually sent.
export const startPrism = async (): Promise<Mock> => {
  const prismPort = freePort();
  const prism = Bun.spawn(
    [
      "node_modules/.bin/prism",
      "mock",
      "openapi/beeminder.yaml",
      "-h",
      "127.0.0.1",
      "-p",
      String(prismPort),
    ],
    { cwd: REPO_ROOT, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
  );
  let exited = false;
  void prism.exited.then(() => (exited = true));

  const requests: RecordedRequest[] = [];
  const front = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const recorded = await record(req);
      requests.push(recorded);
      const url = new URL(req.url);
      if (recorded.body) {
        try {
          const token = (JSON.parse(recorded.body) as { auth_token?: unknown }).auth_token;
          if (typeof token === "string") url.searchParams.set("auth_token", token);
        } catch {
          // an unparsable body is forwarded as is so Prism can reject it
        }
      }
      return fetch(`http://127.0.0.1:${prismPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: recorded.body || undefined,
        redirect: "manual",
      });
    },
  });

  const stop = async () => {
    front.stop(true);
    // Negative pid signals the whole process group created by detached: true.
    try {
      process.kill(-prism.pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let i = 0; i < 50 && !portIsFree(prismPort); i++) await sleep(100);
    if (!portIsFree(prismPort)) {
      try {
        process.kill(-prism.pid, "SIGKILL");
      } catch {
        // already gone
      }
      await sleep(300);
    }
    expect(portIsFree(prismPort)).toBe(true);
  };

  for (let i = 0; i < 300; i++) {
    if (exited) throw new Error("prism exited during startup");
    try {
      const res = await fetch(`http://127.0.0.1:${prismPort}/users/me.json?auth_token=probe`);
      if (res.status === 200) {
        return { base: `http://127.0.0.1:${front.port}`, requests, stop };
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  await stop();
  throw new Error("prism did not answer within 30s");
};

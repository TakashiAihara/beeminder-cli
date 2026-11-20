import { afterEach, describe, expect, test } from "bun:test";

import { redactToken } from "../../src/errors.ts";

const saved = process.env.BEEMINDER_AUTH_TOKEN;

afterEach(() => {
  if (saved === undefined) delete process.env.BEEMINDER_AUTH_TOKEN;
  else process.env.BEEMINDER_AUTH_TOKEN = saved;
});

describe("redactToken", () => {
  const odd = "tok+en/abc=";

  test("replaces the raw token", () => {
    process.env.BEEMINDER_AUTH_TOKEN = odd;
    expect(redactToken(`a ${odd} b`)).toBe("a <redacted> b");
  });

  test("replaces the encodeURIComponent form", () => {
    process.env.BEEMINDER_AUTH_TOKEN = odd;
    expect(redactToken(`a ${encodeURIComponent(odd)} b`)).toBe("a <redacted> b");
  });

  test("replaces every occurrence of both forms", () => {
    process.env.BEEMINDER_AUTH_TOKEN = odd;
    const text = `${odd} ${encodeURIComponent(odd)} ${odd} ${encodeURIComponent(odd)}`;
    expect(redactToken(text)).toBe("<redacted> <redacted> <redacted> <redacted>");
  });

  test("leaves text alone when the token is unset", () => {
    delete process.env.BEEMINDER_AUTH_TOKEN;
    expect(redactToken("nothing to hide")).toBe("nothing to hide");
  });
});

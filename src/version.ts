import pkg from "../package.json" with { type: "json" };

// The identifier `bun build --define` substitutes. A release binary names the tag it was built
// for; a development run (no define) names the version in package.json. It is not process.env
// so a user's environment cannot forge the version.
declare const __BUILD_VERSION__: string | undefined;

export const VERSION: string =
  typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : pkg.version;

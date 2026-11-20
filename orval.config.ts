import { defineConfig } from "orval";

export default defineConfig({
  beeminder: {
    input: "./openapi/beeminder.yaml",
    output: {
      mode: "tags-split",
      target: "./src/generated/api.ts",
      schemas: "./src/generated/model",
      client: "fetch",
      clean: true,
      override: {
        mutator: { path: "./src/http.ts", name: "http" },
      },
    },
  },
});

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Claude Code mod tests import `claude-code/testing` and run under `claude plugin test`.
    exclude: [...configDefaults.exclude, "plugins/mermaid/**"],
  },
});

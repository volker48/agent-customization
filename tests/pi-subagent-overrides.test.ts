import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Pi subagent overrides", () => {
  it("publishes the package-owned subagent definitions", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const agentDirectory = packageJson.pi?.subagents?.agents;

    expect(agentDirectory).toEqual(["./pi-subagents/agents"]);
    expect(
      readdirSync(join(root, "pi-subagents", "agents"))
        .filter((name) => name.endsWith(".md"))
        .sort(),
    ).toEqual(["context-builder.md", "oracle.md", "researcher.md", "reviewer.md"]);
  });

  it("leaves machine-local tools and thinking levels to settings", () => {
    for (const name of ["context-builder", "oracle", "researcher", "reviewer"]) {
      const definition = readFileSync(join(root, "pi-subagents", "agents", `${name}.md`), "utf8");
      const frontmatter = definition.split("---", 3)[1];

      expect(frontmatter).not.toMatch(/^tools:/m);
      expect(frontmatter).not.toMatch(/^thinking:/m);
    }
  });

  it("gives Oracle a 15-minute default runtime", () => {
    const definition = readFileSync(join(root, "pi-subagents", "agents", "oracle.md"), "utf8");
    const frontmatter = definition.split("---", 3)[1];

    expect(frontmatter).toMatch(/^timeoutMs: 900000$/m);
  });
});

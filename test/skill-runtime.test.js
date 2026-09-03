import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSkillRuntime } from "../src/skill-runtime.js";

test("startup normalizes and recursively syncs shared skills for Pi and OpenCode", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-skills-"));
  const source = join(root, "source", "file-reader");
  const piAgentDir = join(root, "runtime", "pi");
  const openCodeConfigDir = join(root, "runtime", "opencode");
  try {
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "file-reader.md"), "---\nname: file-reader\ndescription: Read local fixture files\n---\nUse references/rules.md.\n");
    await writeFile(join(source, "references", "rules.md"), "Only read files in scope.\n");
    const result = await prepareSkillRuntime({ agentSkillsDir: join(root, "source"), piAgentDir, openCodeConfigDir });
    assert.deepEqual(result.names, ["file-reader"]);
    for (const target of [join(piAgentDir, "skills"), join(openCodeConfigDir, "skills")]) {
      assert.match(await readFile(join(target, "file-reader", "SKILL.md"), "utf8"), /name: file-reader/);
      assert.equal(await readFile(join(target, "file-reader", "references", "rules.md"), "utf8"), "Only read files in scope.\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid skill frontmatter fails startup with a clear error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-skills-invalid-"));
  try {
    await writeFile(join(root, "bad.md"), "# missing frontmatter\n");
    await assert.rejects(
      prepareSkillRuntime({ agentSkillsDir: root, piAgentDir: join(root, "pi"), openCodeConfigDir: join(root, "opencode") }),
      /must contain YAML frontmatter/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

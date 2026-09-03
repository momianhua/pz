import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST = ".gateway-managed-skills.json";

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function packageAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const exact = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (exact) return { directory, entryFile: join(directory, exact.name) };
  const markdown = entries.filter((entry) => entry.isFile()
    && entry.name.toLowerCase().endsWith(".md")
    && entry.name.toLowerCase() !== "readme.md");
  if (markdown.length === 1) return { directory, entryFile: join(directory, markdown[0].name) };
  if (markdown.length > 1) {
    throw new Error(`Skill directory ${directory} has multiple entry .md files; rename the intended entry to SKILL.md`);
  }
  return null;
}

function frontmatterValue(markdown, field) {
  const block = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)?.[1];
  if (!block) return "";
  const match = block.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mi"));
  return match?.[1]?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim() ?? "";
}

async function validatePackage(candidate) {
  const markdown = await readFile(candidate.entryFile, "utf8");
  const name = frontmatterValue(markdown, "name");
  const description = frontmatterValue(markdown, "description");
  if (!name || !description) {
    throw new Error(`Skill entry ${candidate.entryFile} must contain YAML frontmatter with name and description`);
  }
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new Error(`Skill name "${name}" must match ${SKILL_NAME} and be at most 64 characters`);
  }
  if (description.length > 1024) throw new Error(`Skill description for "${name}" exceeds 1024 characters`);
  return { ...candidate, name };
}

export async function discoverSkillPackages(sourceDirectory) {
  if (!sourceDirectory) return [];
  const source = resolve(sourceDirectory);
  if (!await isDirectory(source)) throw new Error(`AGENT_SKILLS_DIR does not exist or is not a directory: ${source}`);

  const rootPackage = await packageAt(source);
  const entries = await readdir(source, { withFileTypes: true });
  const childPackages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = await packageAt(join(source, entry.name));
    if (candidate) childPackages.push(candidate);
  }
  const candidates = rootPackage ? [rootPackage] : childPackages;
  if (!candidates.length) {
    throw new Error(`No skills found under ${source}; expected SKILL.md or one entry .md per skill directory`);
  }
  const packages = await Promise.all(candidates.map(validatePackage));
  const names = new Set();
  for (const skill of packages) {
    if (names.has(skill.name)) throw new Error(`Duplicate skill name "${skill.name}" under ${source}`);
    names.add(skill.name);
  }
  return packages;
}

function safeManagedPath(root, name) {
  const target = resolve(root, name);
  const pathWithinRoot = relative(resolve(root), target);
  if (!pathWithinRoot || pathWithinRoot.startsWith(`..${sep}`) || pathWithinRoot === "..") {
    throw new Error(`Unsafe managed skill path: ${target}`);
  }
  return target;
}

async function previousManagedNames(targetRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(targetRoot, MANIFEST), "utf8"));
    return Array.isArray(parsed.skills) ? parsed.skills.filter((name) => SKILL_NAME.test(name)) : [];
  } catch { return []; }
}

async function syncTarget(packages, targetRoot) {
  await mkdir(targetRoot, { recursive: true });
  const currentNames = new Set(packages.map((skill) => skill.name));
  for (const oldName of await previousManagedNames(targetRoot)) {
    if (!currentNames.has(oldName)) await rm(safeManagedPath(targetRoot, oldName), { recursive: true, force: true });
  }
  for (const skill of packages) {
    const destination = safeManagedPath(targetRoot, skill.name);
    await rm(destination, { recursive: true, force: true });
    await cp(skill.directory, destination, { recursive: true, force: true });
    const copiedEntry = join(destination, basename(skill.entryFile));
    if (basename(skill.entryFile) !== "SKILL.md") {
      await cp(copiedEntry, join(destination, "SKILL.md"), { force: true });
      await rm(copiedEntry, { force: true });
    }
  }
  await writeFile(join(targetRoot, MANIFEST), JSON.stringify({ skills: [...currentNames].sort() }, null, 2), "utf8");
}

export async function prepareSkillRuntime(config) {
  const packages = await discoverSkillPackages(config.agentSkillsDir);
  if (!packages.length) return { count: 0, names: [], piDirectory: "", openCodeDirectory: "" };
  const piDirectory = join(config.piAgentDir, "skills");
  const openCodeDirectory = join(config.openCodeConfigDir, "skills");
  await syncTarget(packages, piDirectory);
  await syncTarget(packages, openCodeDirectory);
  return { count: packages.length, names: packages.map((skill) => skill.name), piDirectory, openCodeDirectory };
}

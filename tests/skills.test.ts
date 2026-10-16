import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

test("all 14 WAI skills and the WAICC workflow have valid metadata and resolvable references", () => {
  const root = resolve("skills");
  const names = readdirSync(root);
  assert.equal(names.length, 15);
  for (const name of names) {
    const skill = readFileSync(join(root, name, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, name);
    const metadata = YAML.parse(frontmatter[1]);
    assert.equal(metadata.name, name);
    assert.ok(
      metadata.description.length > 0 && metadata.description.length < 1024,
    );
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name.endsWith(".md")) {
          const content = readFileSync(path, "utf8");
          for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
            const target = match[1].split("#")[0];
            if (!target || /^[a-z]+:/i.test(target) || target.startsWith("/"))
              continue;
            assert.ok(
              existsSync(resolve(dirname(path), target)),
              `${path}: missing ${target}`,
            );
          }
        }
      }
    };
    walk(join(root, name));
  }
});

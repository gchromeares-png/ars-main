import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const srcRoot = path.join(root, "src");

const allowed = new Set([
  "src/browser-worker/interaction-engine.ts",
  "src/browser-worker/ui-interaction-helper.ts"
]);

const forbidden = [
  { name: "fill", pattern: /\.fill\s*\(/g },
  { name: "selectOption", pattern: /\.selectOption\s*\(/g },
  { name: "focus", pattern: /\.focus\s*\(/g },
  { name: "hover", pattern: /\.hover\s*\(/g },
  { name: "scrollIntoViewIfNeeded", pattern: /\.scrollIntoViewIfNeeded\s*\(/g },
  { name: "page.mouse.click", pattern: /\.mouse\.click\s*\(/g },
  { name: "page.mouse.move", pattern: /\.mouse\.move\s*\(/g }
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function relative(file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

describe("global InteractionEngine callsite architecture", () => {
  it("keeps normal browser interaction primitives behind the global interaction layer", () => {
    const violations: string[] = [];

    for (const file of walk(srcRoot)) {
      const rel = relative(file);
      if (rel.startsWith("src/challenges/")) continue;
      if (allowed.has(rel)) continue;

      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const rule of forbidden) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(line)) violations.push(`${rel}:${index + 1}: ${rule.name}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});

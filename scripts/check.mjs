// Syntax-checks every script (works on Mac, Windows and Linux): npm run check
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = ["server.js"];
for (const dir of ["src", "public", "electron", "scripts"]) {
  for (const name of readdirSync(dir)) {
    if (/\.(m?js|cjs)$/.test(name)) files.push(join(dir, name));
  }
}
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed += 1;
    console.error(`✕ ${file}\n${String(error.stderr || error.message)}`);
  }
}
console.log(failed ? `${failed} file(s) have errors.` : `All ${files.length} files OK.`);
process.exit(failed ? 1 : 0);

/**
 * Static check that every mutant in `mutation-gate.mjs` still has somewhere to
 * land.
 *
 * The gate itself already refuses to run a mutant whose `from` anchor does not
 * match exactly once — it reports BROKEN GATE. The problem is *when* it finds
 * out: the full gate is ~88 mutants at roughly ten seconds each, so a two-space
 * indent typo in a new mutant costs a quarter of an hour before it says so, and
 * a mutant whose anchor rotted under an unrelated refactor is only discovered
 * on whichever CI run happens to reach it.
 *
 * This reads the mutant table and the sources and answers the same question in
 * under a second, with no test execution and no writes. Run it before the gate,
 * not instead of it.
 *
 * It doubles as the recovery tool for an interrupted gate. The gate mutates a
 * source file in place and restores it afterwards, so a run killed mid-mutant
 * — a timeout, a SIGKILL from a sibling worktree's process sweep — leaves that
 * mutant applied in the tree. You cannot find it by counting `KILLED:` lines in
 * the log, because the log stops before naming it. You find it here: the
 * stranded mutant is the one whose anchor now matches zero times and whose
 * replacement text is present instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateSrc = fs.readFileSync(path.join(root, "scripts/mutation-gate.mjs"), "utf8");
const start = gateSrc.indexOf("const mutants = [");
const end = gateSrc.indexOf("\n];", start);
if (start === -1 || end === -1) {
  console.error("BROKEN CHECK: could not locate the `const mutants = [` table in mutation-gate.mjs");
  process.exit(2);
}
const mutants = eval(gateSrc.slice(start + "const mutants = ".length, end + 2));

let bad = 0;
const seen = new Set();
for (const mutant of mutants) {
  if (seen.has(mutant.name)) {
    // Two mutants may share an anchor (the same line broken two different
    // ways); they may not share a name, or the log cannot tell them apart.
    console.log(`DUPLICATE NAME  ${mutant.name}`);
    bad++;
  }
  seen.add(mutant.name);

  const file = path.join(root, mutant.file);
  if (!fs.existsSync(file)) {
    console.log(`MISSING FILE    ${mutant.name} -> ${mutant.file}`);
    bad++;
    continue;
  }

  const text = fs.readFileSync(file, "utf8");
  const matches = text.split(mutant.from).length - 1;
  if (matches !== 1) {
    console.log(`ANCHOR x${matches}      ${mutant.name} (${mutant.file})`);
    console.log(`                ${JSON.stringify(mutant.from.slice(0, 100))}`);
    if (mutant.to && text.includes(mutant.to)) {
      console.log("                ^ STRANDED: the replacement text is in the tree. Restore this file.");
    }
    bad++;
  }
}

if (bad > 0) {
  console.error(`\n${mutants.length} mutants, ${bad} cannot be applied. The gate would report BROKEN GATE.`);
  process.exit(1);
}
console.log(`${mutants.length} mutants, every anchor matches exactly once.`);

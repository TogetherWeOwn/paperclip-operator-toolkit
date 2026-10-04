import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The impact gate decides whether CI may SKIP the ~300-mutant sweep,
// so the property under test is asymmetric: a wrong "impacted" costs minutes, a
// wrong "not impacted" turns a required check green on code that was never
// mutation-tested. Every row that is not a positive proof of "unaffected" must
// therefore land on impacted=true.

const script = new URL("../scripts/mutation-impact.mjs", import.meta.url).pathname;
const impactModule = new URL("../scripts/mutation-impact.mjs", import.meta.url).href;

function probe(code: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("isImpacted", () => {
  const impacted = (files: unknown) =>
    probe(`
      import { isImpacted } from ${JSON.stringify(impactModule)};
      console.log(JSON.stringify(isImpacted(${JSON.stringify(files)})));
    `);

  it.each([
    ["plugin source", ["plugins/model-selection/src/engine/pacing.ts"]],
    ["plugin test", ["plugins/model-selection/tests/pacing.spec.ts"]],
    ["plugin lockfile", ["plugins/model-selection/package-lock.json"]],
    ["the gate itself", ["plugins/model-selection/scripts/mutation-gate.mjs"]],
    ["another staged repo fixture", ["test/fixtures/orgdb/schema.sql"]],
    ["CONTRIBUTING.md, which a spec reads", ["CONTRIBUTING.md"]],
    ["the workflow that wires the gate", [".github/workflows/ci.yml"]],
    ["a ./-prefixed plugin path", ["./plugins/model-selection/src/x.ts"]],
    ["one impacted file among many", ["README.md", "docs/a.md", "plugins/model-selection/src/x.ts", "ci_dark_steps.sh"]],
  ])("is impacted by %s", (_name, files) => {
    expect(impacted(files)).toBe(true);
  });

  it.each([
    ["an empty diff", []],
    ["a root script", ["ci_dark_steps.sh"]],
    ["docs", ["docs/ci-required-checks.md", "README.md"]],
    ["another plugin", ["plugins/other-plugin/src/x.ts"]],
    // The prefix carries its trailing slash, so a sibling directory that merely
    // starts with the plugin's name is not the plugin.
    ["a lookalike directory", ["plugins/model-selection-extras/src/x.ts"]],
    ["a lookalike file", ["plugins/model-selection.md"]],
    ["another workflow", [".github/workflows/pr-lint.yml"]],
  ])("is not impacted by %s", (_name, files) => {
    expect(impacted(files)).toBe(false);
  });

  it("derives the staged-fixture paths from the gate runtime rather than restating them", () => {
    const result = probe(`
      import { MUTATION_TREE_REPO_FIXTURES } from ${JSON.stringify(new URL("../scripts/mutation-gate-runtime.mjs", import.meta.url).href)};
      import { isImpacted, MUTATION_IMPACT_FILES } from ${JSON.stringify(impactModule)};
      console.log(JSON.stringify({
        everyFixtureImpacts: MUTATION_TREE_REPO_FIXTURES.every((path) => isImpacted([path])),
        covered: MUTATION_TREE_REPO_FIXTURES.every((path) => MUTATION_IMPACT_FILES.includes(path)),
        workflow: MUTATION_IMPACT_FILES.includes(".github/workflows/ci.yml"),
      }));
    `);
    expect(result).toEqual({ everyFixtureImpacts: true, covered: true, workflow: true });
  });

  it("throws on input it cannot read, so the CLI fails safe instead of reading it as clean", () => {
    const result = probe(`
      import { isImpacted } from ${JSON.stringify(impactModule)};
      const outcomes = [];
      for (const input of [undefined, "plugins/model-selection/x", [42], [null]]) {
        try { outcomes.push({ value: isImpacted(input) }); } catch (error) { outcomes.push({ error: error.name }); }
      }
      console.log(JSON.stringify(outcomes));
    `);
    expect(result).toEqual([{ error: "TypeError" }, { error: "TypeError" }, { error: "TypeError" }, { error: "TypeError" }]);
  });
});

// The decision with git stubbed, for the failure shapes a real repository will
// not produce on demand: a diff that errors after the base resolved, and a base
// that is only reachable after the depth-1 fetch.
describe("decideImpact with a stubbed git", () => {
  const sha = "a".repeat(40);
  const decide = (stub: string, event: unknown = { before: sha }) =>
    probe(`
      import { decideImpact } from ${JSON.stringify(impactModule)};
      const calls = [];
      const git = (args) => { calls.push(args[0]); return (${stub})(args, calls); };
      const result = decideImpact({ eventName: "push", event: ${JSON.stringify(event)}, git });
      console.log(JSON.stringify({ ...result, calls }));
    `) as { impacted: boolean; reason: string; calls: string[] };

  it("a diff that exits non-zero is impacted, not an empty (clean) diff", () => {
    const result = decide(`(args) => args[0] === "diff" ? { status: 128, stdout: "", stderr: "fatal" } : { status: 0, stdout: "", stderr: "" }`);
    expect(result.impacted).toBe(true);
    expect(result.reason).toMatch(/failed/);
  });

  it("fetches the base at depth 1 when it is missing, then proves unaffected from the diff", () => {
    const result = decide(`(args, calls) => {
      if (args[0] === "cat-file") return { status: calls.includes("fetch") ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "docs/a.md\\0README.md\\0", stderr: "" };
    }`);
    expect(result.impacted).toBe(false);
    expect(result.calls).toEqual(["cat-file", "fetch", "cat-file", "diff"]);
  });

  it("a base that is still missing after the fetch is impacted, and never reaches the diff", () => {
    const result = decide(`(args) => args[0] === "diff" ? { status: 0, stdout: "docs/a.md\\0", stderr: "" } : { status: 1, stdout: "", stderr: "" }`);
    expect(result.impacted).toBe(true);
    expect(result.calls).not.toContain("diff");
  });
});

// The CLI against a real throwaway repository: base commit A, then a change set
// B. The workspace under test is exactly what actions/checkout leaves behind — a
// checkout of B with A reachable — and the event file is what GitHub writes.
describe("mutation-impact CLI", () => {
  let sandbox: string;
  let repo: string;
  let base: string;
  const unknownSha = "1".repeat(40);

  const git = (args: string[], cwd = repo) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };

  // Check out a fresh commit from `base` that applies `change`, return its sha.
  const commitChange = (change: () => void) => {
    git(["checkout", "--quiet", "--detach", base]);
    change();
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "change"]);
    return git(["rev-parse", "HEAD"]);
  };

  const run = (eventName: string | undefined, event: unknown, { withEventFile = true } = {}) => {
    const eventPath = join(sandbox, "event.json");
    const outputPath = join(sandbox, "output");
    writeFileSync(outputPath, "");
    if (withEventFile) writeFileSync(eventPath, typeof event === "string" ? event : JSON.stringify(event));
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outputPath };
    delete env.GITHUB_EVENT_NAME;
    delete env.GITHUB_EVENT_PATH;
    if (eventName !== undefined) env.GITHUB_EVENT_NAME = eventName;
    if (withEventFile) env.GITHUB_EVENT_PATH = eventPath;
    const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8", env });
    return { status: result.status, stdout: result.stdout, output: readFileSync(outputPath, "utf8") };
  };

  const pr = (baseSha: string) => ({ pull_request: { base: { sha: baseSha } } });

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "mutation-impact-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    git(["init", "--quiet", "--initial-branch=main"]);
    write("README.md", "base\n");
    write("docs/notes.md", "base\n");
    write("plugins/model-selection/src/a.ts", "export const a = 1;\n");
    write("plugins/model-selection-extras/b.ts", "export const b = 1;\n");
    write("CONTRIBUTING.md", "base\n");
    write(".github/workflows/ci.yml", "name: CI\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "base"]);
    base = git(["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("is not impacted by a docs-only pull request, and says so in the step output", () => {
    commitChange(() => write("docs/notes.md", "edited\n"));
    const result = run("pull_request", pr(base));
    expect(result.status).toBe(0);
    expect(result.output).toBe("impacted=false\n");
    expect(result.stdout).toContain("impacted=false");
  });

  it("is not impacted by a change to a lookalike plugin directory", () => {
    commitChange(() => write("plugins/model-selection-extras/b.ts", "export const b = 2;\n"));
    expect(run("pull_request", pr(base)).output).toBe("impacted=false\n");
  });

  it.each([
    ["plugin source", () => write("plugins/model-selection/src/a.ts", "export const a = 2;\n")],
    ["a new plugin file", () => write("plugins/model-selection/tests/new.spec.ts", "// new\n")],
    ["CONTRIBUTING.md", () => write("CONTRIBUTING.md", "edited\n")],
    ["the workflow file", () => write(".github/workflows/ci.yml", "name: CI2\n")],
    // Without `-z` git quotes a non-ASCII path ("plugins/.../caf\303\251.ts", quotes
    // included), the plugin prefix no longer matches, and the change reads clean.
    ["a non-ASCII plugin filename, which git quotes unless asked for NUL separation", () => write("plugins/model-selection/src/café.ts", "export const c = 1;\n")],
    [
      "a file moved OUT of the plugin (both sides of a rename count)",
      () => {
        mkdirSync(join(repo, "elsewhere"), { recursive: true });
        renameSync(join(repo, "plugins/model-selection/src/a.ts"), join(repo, "elsewhere/a.ts"));
      },
    ],
  ])("is impacted by %s", (_name, change) => {
    commitChange(change);
    const result = run("pull_request", pr(base));
    expect(result.status).toBe(0);
    expect(result.output).toBe("impacted=true\n");
  });

  it("reads the base from `before` on a push and from `merge_group.base_sha` in the merge queue", () => {
    commitChange(() => write("docs/notes.md", "edited\n"));
    expect(run("push", { before: base }).output).toBe("impacted=false\n");
    expect(run("merge_group", { merge_group: { base_sha: base } }).output).toBe("impacted=false\n");

    commitChange(() => write("plugins/model-selection/src/a.ts", "export const a = 3;\n"));
    expect(run("push", { before: base }).output).toBe("impacted=true\n");
    expect(run("merge_group", { merge_group: { base_sha: base } }).output).toBe("impacted=true\n");
  });

  // Fail-safe rows. Each one is a situation where "unaffected" cannot be proved,
  // and the diff itself would be clean (a docs-only change is checked out), so a
  // lenient implementation would answer false here.
  describe("fails safe to impacted=true", () => {
    const docsOnly = () => commitChange(() => write("docs/notes.md", "edited\n"));

    it.each([
      ["a new branch push (all-zero before)", "push", { before: "0".repeat(40) }],
      ["a push with no before", "push", {}],
      ["a force-push whose previous head is gone", "push", { before: unknownSha }],
      ["a pull request whose base is not in the repository", "pull_request", { pull_request: { base: { sha: unknownSha } } }],
      ["a pull request payload with no base", "pull_request", { pull_request: {} }],
      ["a merge_group payload with no base_sha", "merge_group", { merge_group: {} }],
      ["a base that is not a sha at all", "pull_request", { pull_request: { base: { sha: "--output=/tmp/x" } } }],
      ["a branch name where a sha belongs", "push", { before: "main" }],
      ["an event this workflow does not expect", "workflow_dispatch", {}],
      ["no event name", undefined, {}],
      ["an event payload that is not an object", "push", "null"],
      ["an event payload that is not JSON", "push", "{not json"],
    ] as Array<[string, string | undefined, unknown]>)("%s", (_name, eventName, event) => {
      docsOnly();
      const result = run(eventName, event);
      expect(result.status).toBe(0);
      expect(result.output).toBe("impacted=true\n");
    });

    it("an event file that does not exist", () => {
      docsOnly();
      const result = run("push", {}, { withEventFile: false });
      expect(result.status).toBe(0);
      expect(result.output).toBe("impacted=true\n");
    });

    it("git itself being unavailable", () => {
      docsOnly();
      const result = run("pull_request", pr(base));
      expect(result.output).toBe("impacted=false\n");
      // Same event, but git can no longer run: the verdict must flip, never stay
      // on a clean read of an error.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_OUTPUT: join(sandbox, "output2"),
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: join(sandbox, "event.json"),
        PATH: "/nonexistent",
      };
      writeFileSync(join(sandbox, "output2"), "");
      const broken = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8", env });
      expect(broken.status).toBe(0);
      expect(readFileSync(join(sandbox, "output2"), "utf8")).toBe("impacted=true\n");
    });
  });

  it("still prints the verdict when it is not running under Actions (no GITHUB_OUTPUT)", () => {
    commitChange(() => write("docs/notes.md", "edited\n"));
    const eventPath = join(sandbox, "event.json");
    writeFileSync(eventPath, JSON.stringify(pr(base)));
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath };
    delete env.GITHUB_OUTPUT;
    const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8", env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("impacted=false");
  });
});

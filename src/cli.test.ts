import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const execFile = promisify(execFileCallback);
const cli = join(process.cwd(), "dist", "cli.js");

async function run(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile(process.execPath, [cli, ...args], { cwd });
  return stdout;
}

test("initializes and advances a planned change to a ready spec", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "add-theme", "--prd", "docs/prd.md");
    await assert.rejects(() => run(project, "new", "another-change"), /max_active_changes/);
    await run(project, "add-spec", "add-theme", "theme-toggle", "Theme toggle");
    await writeFile(join(project, ".specflow", "changes", "add-theme", "specs", "theme-toggle.md"), "# Delta Spec: theme-toggle\n\n## ADDED Requirements\n\n### Requirement: Theme Selection\n\nThe system MUST allow theme selection.\n");
    await run(project, "submit-plan", "add-theme");
    await run(project, "approve", "add-theme");
    const state = parse(await readFile(join(project, ".specflow", "changes", "add-theme", "state.yaml"), "utf8")) as { state: string; specs: Array<{ state: string }> };
    assert.equal(state.state, "ready");
    assert.equal(state.specs[0]?.state, "ready");
    const status = await run(project, "status", "add-theme");
    assert.match(status, /add-theme\s+ready\s+theme-toggle:ready/);
    const projectState = parse(await readFile(join(project, ".specflow", "state.yaml"), "utf8")) as { active_changes: Array<{ change_id: string; state: string; updated_at: string }> };
    assert.equal(projectState.active_changes.length, 1);
    assert.equal(projectState.active_changes[0]?.change_id, "add-theme");
    assert.equal(projectState.active_changes[0]?.state, "ready");
    assert.match(projectState.active_changes[0]?.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    await run(project, "validate", "add-theme");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("does not approve an unsubmitted plan", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "bad-plan");
    await assert.rejects(() => run(project, "approve", "bad-plan"), /Cannot approve change in state planning/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("runs an implementer and reviewer handoff through QA pass and archive", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "add-theme");
    await run(project, "add-spec", "add-theme", "theme-toggle", "Theme toggle");
    await run(project, "submit-plan", "add-theme");
    await run(project, "approve", "add-theme");

    const handoffDir = join(project, ".specflow", "changes", "add-theme", "handoffs");
    await run(project, "dispatch", "add-theme", "implementer", "--spec", "theme-toggle");
    const implementationTask = parse(await readFile(join(handoffDir, (await readdir(handoffDir))[0]!), "utf8")) as { task_id: string; lease_id: string };
    const implementationResult = join(project, "implementation-result.yaml");
    await writeFile(implementationResult, stringify({ task_id: implementationTask.task_id, lease_id: implementationTask.lease_id, outcome: "completed", evidence: { changed_files: ["src/theme.ts"], test_results: ["npm test: passed"] } }));
    await run(project, "import-result", "add-theme", implementationTask.task_id, implementationResult);

    await run(project, "dispatch", "add-theme", "reviewer", "--spec", "theme-toggle");
    const handoffs = await readdir(handoffDir);
    const reviewerFile = handoffs.find((file) => file !== `${implementationTask.task_id}.yaml` && file.endsWith(".yaml") && !file.endsWith(".result.yaml"));
    assert.ok(reviewerFile);
    const reviewerTask = parse(await readFile(join(handoffDir, reviewerFile), "utf8")) as { task_id: string; lease_id: string };
    await writeFile(join(project, ".specflow", "changes", "add-theme", "reviews", `${reviewerTask.task_id}.md`), "# QA Report\n\npass\n");
    const reviewerResult = join(project, "reviewer-result.yaml");
    await writeFile(reviewerResult, stringify({ task_id: reviewerTask.task_id, lease_id: reviewerTask.lease_id, outcome: "completed", verdict: "pass" }));
    await run(project, "import-result", "add-theme", reviewerTask.task_id, reviewerResult);

    const state = parse(await readFile(join(project, ".specflow", "changes", "add-theme", "state.yaml"), "utf8")) as { state: string };
    assert.equal(state.state, "awaiting_archive_approval");
    await writeFile(join(project, ".specflow", "changes", "add-theme", "specs", "theme-toggle.md"), "# Delta Spec: theme-toggle\n\n## ADDED Requirements\n\n### Requirement: Theme Selection\n\nThe system MUST allow theme selection.\n\n#### Scenario: Toggle\n\n- **GIVEN** a user\n- **WHEN** the user changes theme\n- **THEN** the preference is saved.\n");
    await assert.rejects(() => run(project, "validate", "add-theme"), /template placeholders/);
    await assert.rejects(() => run(project, "archive", "add-theme"), /template placeholders/);
    await writeFile(join(project, ".specflow", "changes", "add-theme", "test_report.md"), "# Test Report\n\n## Commands\n\n- npm test\n\n## Results\n\n- 5 passed\n");
    await writeFile(join(project, ".specflow", "changes", "add-theme", "specs", "theme-toggle.md"), "# Delta Spec: theme-toggle\n\n## Requirements\n\n### Requirement: Theme Selection\n\nThe system MUST allow theme selection.\n");
    await assert.rejects(() => run(project, "validate", "add-theme"), /no recognized Delta Spec requirements/);
    await assert.rejects(() => run(project, "archive", "add-theme"), /no recognized Delta Spec requirements/);
    await writeFile(join(project, ".specflow", "changes", "add-theme", "specs", "theme-toggle.md"), "# Delta Spec: theme-toggle\n\n## ADDED Requirements\n\n### Requirement: Theme Selection\n\nThe system MUST allow theme selection.\n\n#### Scenario: Toggle\n\n- **GIVEN** a user\n- **WHEN** the user changes theme\n- **THEN** the preference is saved.\n");
    await run(project, "archive", "add-theme");
    const history = await readdir(join(project, ".specflow", "history"));
    assert.equal(history.length, 1);
    const archiveDir = join(project, ".specflow", "history", history[0]!);
    const archived = await readFile(join(archiveDir, "sync_report.md"), "utf8");
    assert.match(archived, /ADDED Theme Selection/);
    const archivedState = parse(await readFile(join(archiveDir, "state.yaml"), "utf8")) as { state: string; history: Array<{ event: string; detail?: string }> };
    assert.equal(archivedState.state, "archived");
    const archiveEvent = archivedState.history.at(-1);
    assert.equal(archiveEvent?.event, "archive_completed");
    assert.equal(archiveEvent?.detail, "Merged 1 Delta Spec file(s).");
    const projectState = parse(await readFile(join(project, ".specflow", "state.yaml"), "utf8")) as { active_changes: unknown[] };
    assert.deepEqual(projectState.active_changes, []);
    const systemSpec = await readFile(join(project, ".specflow", "system-specs", "theme-toggle.md"), "utf8");
    assert.match(systemSpec, /### Requirement: Theme Selection/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("returns an allowed QA finding to a bounded repair loop", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "repair-flow");
    await run(project, "add-spec", "repair-flow", "feature", "Feature");
    await run(project, "submit-plan", "repair-flow");
    await run(project, "approve", "repair-flow");
    const handoffDir = join(project, ".specflow", "changes", "repair-flow", "handoffs");
    await run(project, "dispatch", "repair-flow", "implementer", "--spec", "feature");
    const implementationFile = (await readdir(handoffDir))[0]!;
    const implementationTask = parse(await readFile(join(handoffDir, implementationFile), "utf8")) as { task_id: string; lease_id: string };
    const prompt = await run(project, "prompt", "repair-flow", implementationTask.task_id);
    assert.match(prompt, /禁止创建 subagent/);
    const implementationResult = join(project, "implementation-result.yaml");
    await writeFile(implementationResult, stringify({ task_id: implementationTask.task_id, lease_id: implementationTask.lease_id, outcome: "completed", evidence: { changed_files: ["src/feature.ts"], test_results: ["npm test: passed"] } }));
    await run(project, "import-result", "repair-flow", implementationTask.task_id, implementationResult);
    await run(project, "dispatch", "repair-flow", "reviewer", "--spec", "feature");
    const reviewerFile = (await readdir(handoffDir)).find((file) => file.startsWith("reviewer-") && file.endsWith(".yaml"));
    assert.ok(reviewerFile);
    const reviewerTask = parse(await readFile(join(handoffDir, reviewerFile), "utf8")) as { task_id: string; lease_id: string };
    const reviewerResult = join(project, "reviewer-result.yaml");
    await writeFile(reviewerResult, stringify({ task_id: reviewerTask.task_id, lease_id: reviewerTask.lease_id, outcome: "completed", verdict: "repair", category: "missing_test" }));
    await run(project, "import-result", "repair-flow", reviewerTask.task_id, reviewerResult);
    const state = parse(await readFile(join(project, ".specflow", "changes", "repair-flow", "state.yaml"), "utf8")) as { state: string; specs: Array<{ state: string; qa_attempts: number }> };
    assert.equal(state.state, "repairing");
    assert.equal(state.specs[0]?.state, "repairing");
    assert.equal(state.specs[0]?.qa_attempts, 1);
    await run(project, "dispatch", "repair-flow", "implementer", "--spec", "feature");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("prevents duplicate planner leases and reclaims expired leases", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "planner-flow");
    await run(project, "dispatch", "planner-flow", "planner");
    await assert.rejects(() => run(project, "dispatch", "planner-flow", "planner"), /Active lease/);
    const statePath = join(project, ".specflow", "changes", "planner-flow", "state.yaml");
    const state = parse(await readFile(statePath, "utf8")) as { leases: Array<{ expires_at: string }>; history: Array<{ event: string }> };
    state.leases[0]!.expires_at = new Date(0).toISOString();
    await writeFile(statePath, stringify(state));
    await run(project, "dispatch", "planner-flow", "planner");
    const refreshed = parse(await readFile(statePath, "utf8")) as { leases: unknown[]; history: Array<{ event: string }> };
    assert.equal(refreshed.leases.length, 1);
    assert.ok(refreshed.history.some((event) => event.event === "lease_expired"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("restores an implementable spec after its lease expires", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "expired-writer");
    await run(project, "add-spec", "expired-writer", "feature", "Feature");
    await run(project, "submit-plan", "expired-writer");
    await run(project, "approve", "expired-writer");
    await run(project, "dispatch", "expired-writer", "implementer", "--spec", "feature");
    const statePath = join(project, ".specflow", "changes", "expired-writer", "state.yaml");
    const state = parse(await readFile(statePath, "utf8")) as { leases: Array<{ expires_at: string }>; specs: Array<{ state: string }> };
    state.leases[0]!.expires_at = new Date(0).toISOString();
    await writeFile(statePath, stringify(state));
    await run(project, "dispatch", "expired-writer", "implementer", "--spec", "feature");
    const refreshed = parse(await readFile(statePath, "utf8")) as { leases: unknown[]; specs: Array<{ state: string }> };
    assert.equal(refreshed.leases.length, 1);
    assert.equal(refreshed.specs[0]?.state, "implementing");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("gates visual changes on completed UX evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "visual-change");
    const changeDir = join(project, ".specflow", "changes", "visual-change");
    await run(project, "add-spec", "visual-change", "screen", "Screen");
    await writeFile(join(changeDir, "proposal.md"), "# Proposal\n\n## Design Impact\n\n- 档位：visual\n- 证据路径：mockup/截图\n");
    await assert.rejects(() => run(project, "submit-plan", "visual-change"), /completed ux-design/);
    await writeFile(join(changeDir, "ux-design.md"), "# UX Design\n\n## Flow\n\nThe user can switch screens.\n");
    await writeFile(join(changeDir, "proposal.md"), "# Proposal\n\n## Design Impact\n\n- 档位：visual\n- 证据路径：docs/mockup.png\n");
    await run(project, "submit-plan", "visual-change");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("scopes implementer paths per spec and passes completed design inputs", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    const configPath = join(project, ".specflow", "config.yaml");
    const config = parse(await readFile(configPath, "utf8")) as { execution: Record<string, unknown> };
    config.execution.implementer_paths = ["app/**", "e2e/**"];
    config.execution.sequential_specs = false;
    await writeFile(configPath, stringify(config));
    await run(project, "new", "scoped");
    const changeDir = join(project, ".specflow", "changes", "scoped");
    await run(project, "add-spec", "scoped", "backend", "Backend", "--path", "server/**", "--path", "Cargo.toml");
    await run(project, "add-spec", "scoped", "frontend", "Frontend");
    await writeFile(join(changeDir, "design.md"), "# Design\n\nUse a single store.\n");
    await run(project, "submit-plan", "scoped");
    await run(project, "approve", "scoped");

    const handoffDir = join(changeDir, "handoffs");
    await run(project, "dispatch", "scoped", "implementer", "--spec", "backend");
    await run(project, "dispatch", "scoped", "implementer", "--spec", "frontend");
    const tasks = await Promise.all((await readdir(handoffDir)).map(async (file) => parse(await readFile(join(handoffDir, file), "utf8")) as { target_spec: string; allowed_paths: string[]; inputs: string[] }));
    const backend = tasks.find((task) => task.target_spec === "backend");
    const frontend = tasks.find((task) => task.target_spec === "frontend");
    assert.deepEqual(backend?.allowed_paths, ["server/**", "Cargo.toml", ".specflow/changes/scoped/**"]);
    assert.deepEqual(frontend?.allowed_paths, ["app/**", "e2e/**", ".specflow/changes/scoped/**"]);
    assert.ok(backend?.inputs.includes("design.md"));
    assert.ok(!backend?.inputs.includes("ux-design.md"));
    const state = parse(await readFile(join(changeDir, "state.yaml"), "utf8")) as { specs: Array<{ id: string; paths?: string[] }> };
    assert.deepEqual(state.specs.find((spec) => spec.id === "backend")?.paths, ["server/**", "Cargo.toml"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("imports a result written at its canonical handoff path and states the result schema", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "canonical");
    await run(project, "add-spec", "canonical", "only", "Only");
    await run(project, "submit-plan", "canonical");
    await run(project, "approve", "canonical");
    const handoffDir = join(project, ".specflow", "changes", "canonical", "handoffs");
    await run(project, "dispatch", "canonical", "implementer", "--spec", "only");
    const task = parse(await readFile(join(handoffDir, (await readdir(handoffDir))[0]!), "utf8")) as { task_id: string; lease_id: string };
    const prompt = await run(project, "prompt", "canonical", task.task_id);
    assert.match(prompt, new RegExp(`lease_id: ${task.lease_id}`));
    assert.match(prompt, /evidence\.changed_files/);
    const canonical = join(handoffDir, `${task.task_id}.result.yaml`);
    await writeFile(canonical, stringify({ task_id: task.task_id, lease_id: task.lease_id, outcome: "completed", evidence: { changed_files: ["src/a.ts"], test_results: ["npm test: passed"] } }));
    await run(project, "import-result", "canonical", task.task_id, canonical);
    const state = parse(await readFile(join(project, ".specflow", "changes", "canonical", "state.yaml"), "utf8")) as { state: string };
    assert.equal(state.state, "reviewing");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("dispatches a bounded read-only subagent without changing the main flow", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "research-flow");
    await run(project, "dispatch-subagent", "research-flow", "codebase_researcher", "--task", "inspect the existing architecture");
    const handoffDir = join(project, ".specflow", "changes", "research-flow", "handoffs");
    const handoffFile = (await readdir(handoffDir)).find((file) => file.startsWith("subagent-") && file.endsWith(".yaml"));
    assert.ok(handoffFile);
    const task = parse(await readFile(join(handoffDir, handoffFile), "utf8")) as { task_id: string; lease_id: string; allowed_paths: string[]; subagents: string };
    assert.deepEqual(task.allowed_paths, []);
    assert.equal(task.subagents, "orchestrator_only");
    const result = join(project, "subagent-result.yaml");
    await writeFile(result, stringify({ task_id: task.task_id, lease_id: task.lease_id, outcome: "completed", summary: "architecture inspected" }));
    await run(project, "import-result", "research-flow", task.task_id, result);
    const state = parse(await readFile(join(project, ".specflow", "changes", "research-flow", "state.yaml"), "utf8")) as { state: string; leases: unknown[]; history: Array<{ event: string }> };
    assert.equal(state.state, "planning");
    assert.equal(state.leases.length, 0);
    assert.ok(state.history.some((event) => event.event === "subagent_completed"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("applies label route overrides", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    const configPath = join(project, ".specflow", "config.yaml");
    const config = parse(await readFile(configPath, "utf8")) as any;
    config.agents.security = { adapter: "manual-security" };
    config.routing.overrides = [{ role: "planner", label: "security", route: "security" }];
    config.execution.max_parallel_workers = 1;
    config.execution.sequential_specs = false;
    await writeFile(configPath, stringify(config));
    await run(project, "new", "security-flow", "--label", "security");
    await run(project, "add-spec", "security-flow", "first", "First");
    await run(project, "add-spec", "security-flow", "second", "Second");
    await run(project, "dispatch", "security-flow", "planner");
    const handoffDir = join(project, ".specflow", "changes", "security-flow", "handoffs");
    const plannerFile = (await readdir(handoffDir)).find((file) => file.startsWith("planner-") && file.endsWith(".yaml"));
    assert.ok(plannerFile);
    const planner = parse(await readFile(join(handoffDir, plannerFile), "utf8")) as { adapter: string };
    assert.equal(planner.adapter, "manual-security");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("returns a spec to ready when its implementer needs a decision, so resolve can redispatch", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "decide");
    await run(project, "add-spec", "decide", "only", "Only");
    await run(project, "submit-plan", "decide");
    await run(project, "approve", "decide");
    const changeDir = join(project, ".specflow", "changes", "decide");
    const handoffDir = join(changeDir, "handoffs");
    await run(project, "dispatch", "decide", "implementer", "--spec", "only");
    const task = parse(await readFile(join(handoffDir, (await readdir(handoffDir))[0]!), "utf8")) as { task_id: string; lease_id: string };
    const result = join(project, "result.yaml");
    await writeFile(result, stringify({ task_id: task.task_id, lease_id: task.lease_id, outcome: "needs_decision", summary: "token conflict" }));
    await run(project, "import-result", "decide", task.task_id, result);
    let state = parse(await readFile(join(changeDir, "state.yaml"), "utf8")) as { state: string; resume_state?: string; specs: Array<{ state: string }> };
    assert.equal(state.state, "decision_required");
    assert.equal(state.resume_state, "ready");
    assert.equal(state.specs[0]?.state, "ready");
    await run(project, "resolve", "decide", "previous", "--reason", "use darker token");
    state = parse(await readFile(join(changeDir, "state.yaml"), "utf8")) as { state: string; specs: Array<{ state: string }> };
    assert.equal(state.state, "ready");
    await run(project, "dispatch", "decide", "implementer", "--spec", "only");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("resolve to repairing returns a reviewer-escalated spec to the implementer", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "escalate");
    await run(project, "add-spec", "escalate", "only", "Only");
    await run(project, "submit-plan", "escalate");
    await run(project, "approve", "escalate");
    const changeDir = join(project, ".specflow", "changes", "escalate");
    const handoffDir = join(changeDir, "handoffs");
    await run(project, "dispatch", "escalate", "implementer", "--spec", "only");
    const impl = parse(await readFile(join(handoffDir, (await readdir(handoffDir))[0]!), "utf8")) as { task_id: string; lease_id: string };
    const implResult = join(project, "impl.yaml");
    await writeFile(implResult, stringify({ task_id: impl.task_id, lease_id: impl.lease_id, outcome: "completed", evidence: { changed_files: ["src/a.ts"], test_results: ["ok"] } }));
    await run(project, "import-result", "escalate", impl.task_id, implResult);
    await run(project, "dispatch", "escalate", "reviewer", "--spec", "only");
    const reviewerFile = (await readdir(handoffDir)).find((file) => file.startsWith("reviewer-") && !file.endsWith(".result.yaml"))!;
    const review = parse(await readFile(join(handoffDir, reviewerFile), "utf8")) as { task_id: string; lease_id: string };
    await writeFile(join(changeDir, "reviews", `${review.task_id}.md`), "# QA Report\n\nescalation\n");
    const reviewResult = join(project, "review.yaml");
    await writeFile(reviewResult, stringify({ task_id: review.task_id, lease_id: review.lease_id, outcome: "completed", verdict: "escalation", category: "permission_insufficient" }));
    await run(project, "import-result", "escalate", review.task_id, reviewResult);
    await run(project, "resolve", "escalate", "repairing", "--reason", "remove out-of-scope guard");
    const state = parse(await readFile(join(changeDir, "state.yaml"), "utf8")) as { state: string; specs: Array<{ state: string }> };
    assert.equal(state.state, "repairing");
    assert.equal(state.specs[0]?.state, "repairing");
    await run(project, "dispatch", "escalate", "implementer", "--spec", "only");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("resolve releases a spec left implementing without a lease", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "legacy");
    await run(project, "add-spec", "legacy", "only", "Only");
    await run(project, "submit-plan", "legacy");
    await run(project, "approve", "legacy");
    const statePath = join(project, ".specflow", "changes", "legacy", "state.yaml");
    const legacy = parse(await readFile(statePath, "utf8")) as Record<string, unknown> & { specs: Array<{ state: string }> };
    legacy.state = "decision_required";
    legacy.resume_state = "implementing";
    legacy.specs[0]!.state = "implementing";
    await writeFile(statePath, stringify(legacy));
    await run(project, "resolve", "legacy", "previous", "--reason", "decided");
    const state = parse(await readFile(statePath, "utf8")) as { state: string; specs: Array<{ state: string }> };
    assert.equal(state.state, "ready");
    assert.equal(state.specs[0]?.state, "ready");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("imports a matching result after its lease expires", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "late-result");
    await run(project, "add-spec", "late-result", "runtime", "Runtime");
    await run(project, "submit-plan", "late-result");
    await run(project, "approve", "late-result");
    await run(project, "dispatch", "late-result", "implementer", "--spec", "runtime");

    const changeDir = join(project, ".specflow", "changes", "late-result");
    const statePath = join(changeDir, "state.yaml");
    const handoffFile = (await readdir(join(changeDir, "handoffs"))).find((file) => file.startsWith("implementer-") && file.endsWith(".yaml"));
    assert.ok(handoffFile);
    const task = parse(await readFile(join(changeDir, "handoffs", handoffFile), "utf8")) as { task_id: string; lease_id: string };
    const state = parse(await readFile(statePath, "utf8")) as any;
    state.leases[0].expires_at = "2000-01-01T00:00:00.000Z";
    await writeFile(statePath, stringify(state));
    const resultPath = join(project, "late-result.yaml");
    await writeFile(resultPath, stringify({ task_id: task.task_id, lease_id: task.lease_id, outcome: "completed", evidence: { changed_files: ["src/runtime.ts"], test_results: ["npm test: passed"] } }));

    await run(project, "import-result", "late-result", task.task_id, resultPath);
    const imported = parse(await readFile(statePath, "utf8")) as { state: string; leases: unknown[]; history: Array<{ event: string }> };
    assert.equal(imported.state, "reviewing");
    assert.equal(imported.leases.length, 0);
    assert.ok(imported.history.some((event) => event.event === "late_result_imported"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("rejects an expired result after replacement work starts", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "replaced-result");
    await run(project, "add-spec", "replaced-result", "runtime", "Runtime");
    await run(project, "submit-plan", "replaced-result");
    await run(project, "approve", "replaced-result");
    await run(project, "dispatch", "replaced-result", "implementer", "--spec", "runtime");

    const changeDir = join(project, ".specflow", "changes", "replaced-result");
    const statePath = join(changeDir, "state.yaml");
    const handoffDir = join(changeDir, "handoffs");
    const oldFile = (await readdir(handoffDir)).find((file) => file.startsWith("implementer-") && file.endsWith(".yaml"));
    assert.ok(oldFile);
    const oldTask = parse(await readFile(join(handoffDir, oldFile), "utf8")) as { task_id: string; lease_id: string };
    const state = parse(await readFile(statePath, "utf8")) as any;
    state.leases[0].expires_at = "2000-01-01T00:00:00.000Z";
    await writeFile(statePath, stringify(state));
    await run(project, "dispatch", "replaced-result", "implementer", "--spec", "runtime");
    const resultPath = join(project, "stale-result.yaml");
    await writeFile(resultPath, stringify({ task_id: oldTask.task_id, lease_id: oldTask.lease_id, outcome: "completed", evidence: { changed_files: ["src/runtime.ts"], test_results: ["npm test: passed"] } }));

    await assert.rejects(() => run(project, "import-result", "replaced-result", oldTask.task_id, resultPath), /Lease is no longer active/);
    const current = parse(await readFile(statePath, "utf8")) as { leases: Array<{ task_id: string }> };
    assert.equal(current.leases.length, 1);
    assert.notEqual(current.leases[0]?.task_id, oldTask.task_id);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("reopens one passed spec with audit history, guards, and a new QA cycle", async () => {
  const project = await mkdtemp(join(tmpdir(), "specflow-test-"));
  try {
    await run(process.cwd(), "init", project);
    await run(project, "new", "reopen-flow");
    const dir = join(project, ".specflow", "changes", "reopen-flow");
    for (const name of ["first", "second"]) {
      await run(project, "add-spec", "reopen-flow", name, name);
      await writeFile(join(dir, "specs", `${name}.md`), `# Delta Spec: ${name}\n\n## ADDED Requirements\n\n### Requirement: ${name}\n\nThe system MUST support ${name}.\n`);
      await writeFile(join(dir, "reviews", `${name}-old.md`), "# QA Report\n\npass\n");
    }
    await run(project, "submit-plan", "reopen-flow");
    await run(project, "approve", "reopen-flow");
    const statePath = join(dir, "state.yaml");
    const indexPath = join(project, ".specflow", "state.yaml");
    const state = parse(await readFile(statePath, "utf8")) as {
      state: string; updated_at: string; leases: unknown[];
      specs: Array<{ id: string; state: string; qa_attempts: number; qa_report?: string | null; updated_at?: string }>;
      history: Array<{ event: string; detail?: string }>;
    };
    state.state = "awaiting_archive_approval";
    for (const spec of state.specs) {
      spec.state = "qa_passed";
      spec.qa_report = `reviews/${spec.id}-old.md`;
      spec.qa_attempts = spec.id === "first" ? 2 : 1;
    }
    await writeFile(statePath, stringify(state));
    const unchanged = async (args: string[], error: RegExp) => {
      const before = await readFile(statePath);
      const indexBefore = await readFile(indexPath);
      const filesBefore = await readdir(join(dir, "reviews"));
      await assert.rejects(() => run(project, "reopen-qa", "reopen-flow", ...args), error);
      assert.deepEqual(await readFile(statePath), before);
      assert.deepEqual(await readFile(indexPath), indexBefore);
      assert.deepEqual(await readdir(join(dir, "reviews")), filesBefore);
    };
    await unchanged(["--spec", "first", "--reason", "new defect"], /--confirm/);
    await unchanged(["--spec", "first", "--reason", "  ", "--confirm"], /nonempty --reason/);
    await unchanged(["--spec", "first", "--reason", "--confirm"], /nonempty --reason/);
    await unchanged(["--reason", "defect", "--confirm"], /requires --spec/);
    await unchanged(["--spec", "missing", "--reason", "defect", "--confirm"], /Unknown spec/);
    state.specs[0]!.state = "reviewing";
    await writeFile(statePath, stringify(state));
    await unchanged(["--spec", "first", "--reason", "defect", "--confirm"], /state reviewing/);
    state.specs[0]!.state = "qa_passed";
    state.leases = [{ id: "active" }];
    await writeFile(statePath, stringify(state));
    await unchanged(["--spec", "first", "--reason", "defect", "--confirm"], /leases are active/);
    state.leases = [];
    state.state = "ready";
    await writeFile(statePath, stringify(state));
    await unchanged(["--spec", "first", "--reason", "defect", "--confirm"], /state ready/);
    state.state = "awaiting_archive_approval";
    await writeFile(statePath, stringify(state));

    await run(project, "reopen-qa", "reopen-flow", "--spec", "first", "--reason", "  regression found  ", "--confirm");
    const reopened = parse(await readFile(statePath, "utf8")) as typeof state;
    assert.equal(reopened.state, "repairing");
    assert.notEqual(reopened.updated_at, state.updated_at);
    assert.equal(reopened.specs[0]?.state, "repairing");
    assert.match(reopened.specs[0]?.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(reopened.specs[0]?.qa_attempts, 2);
    assert.equal(reopened.specs[0]?.qa_report, null);
    assert.deepEqual(reopened.specs[1], state.specs[1]);
    assert.equal(await readFile(join(dir, "reviews", "first-old.md"), "utf8"), "# QA Report\n\npass\n");
    assert.deepEqual(JSON.parse(reopened.history.at(-1)?.detail ?? ""), { spec: "first", reason: "regression found", previous_qa_report: "reviews/first-old.md" });
    assert.equal(reopened.history.at(-1)?.event, "qa_reopened");
    assert.deepEqual(reopened.history.slice(0, -1), state.history);
    const index = parse(await readFile(indexPath, "utf8")) as { active_changes: Array<{ state: string }> };
    assert.equal(index.active_changes[0]?.state, "repairing");
    await run(project, "validate", "reopen-flow");
    await assert.rejects(() => run(project, "archive", "reopen-flow"), /Cannot archive change in state repairing/);
    await unchanged(["--spec", "first", "--reason", "again", "--confirm"], /state repairing/);

    await run(project, "dispatch", "reopen-flow", "implementer", "--spec", "first");
    const handoffDir = join(dir, "handoffs");
    const implementationFile = (await readdir(handoffDir)).find((file) => file.startsWith("implementer-") && file.endsWith(".yaml"));
    assert.ok(implementationFile);
    const implementation = parse(await readFile(join(handoffDir, implementationFile), "utf8")) as { task_id: string; lease_id: string };
    const resultPath = join(project, "result.yaml");
    await writeFile(resultPath, stringify({ task_id: implementation.task_id, lease_id: implementation.lease_id, outcome: "completed", evidence: { changed_files: ["src/first.ts"], test_results: ["npm test: passed"] } }));
    await run(project, "import-result", "reopen-flow", implementation.task_id, resultPath);
    await run(project, "dispatch", "reopen-flow", "reviewer", "--spec", "first");
    const reviewerFile = (await readdir(handoffDir)).find((file) => file.startsWith("reviewer-") && file.endsWith(".yaml"));
    assert.ok(reviewerFile);
    const reviewer = parse(await readFile(join(handoffDir, reviewerFile), "utf8")) as { task_id: string; lease_id: string };
    await writeFile(join(dir, "reviews", `${reviewer.task_id}.md`), "# QA Report\n\npass\n");
    await writeFile(resultPath, stringify({ task_id: reviewer.task_id, lease_id: reviewer.lease_id, outcome: "completed", verdict: "pass" }));
    await run(project, "import-result", "reopen-flow", reviewer.task_id, resultPath);
    const finished = parse(await readFile(statePath, "utf8")) as typeof state;
    assert.equal(finished.state, "awaiting_archive_approval");
    assert.equal(finished.specs[0]?.qa_report, `reviews/${reviewer.task_id}.md`);
    assert.equal(finished.specs[0]?.qa_attempts, 2);
    assert.deepEqual(finished.specs[1], state.specs[1]);
    await writeFile(join(dir, "test_report.md"), "# Test Report\n\n## Commands\n\n- npm test\n\n## Results\n\n- passed\n");
    await run(project, "validate", "reopen-flow");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

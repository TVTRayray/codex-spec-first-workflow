#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

type Role = "planner" | "implementer" | "reviewer";
type ChangeState =
  | "draft"
  | "planning"
  | "awaiting_plan_approval"
  | "ready"
  | "implementing"
  | "reviewing"
  | "repairing"
  | "awaiting_archive_approval"
  | "decision_required"
  | "blocked"
  | "archived"
  | "cancelled";
type SpecState = "todo" | "ready" | "implementing" | "reviewing" | "repairing" | "qa_passed" | "blocked";
type Verdict = "pass" | "repair" | "escalation";

interface SpecItem {
  id: string;
  title: string;
  state: SpecState;
  depends_on: string[];
  qa_attempts: number;
  qa_report?: string | null;
}

interface Lease {
  id: string;
  task_id: string;
  role: Role;
  spec_id?: string;
  expires_at: string;
}

interface Change {
  change_id: string;
  state: ChangeState;
  created_at: string;
  updated_at: string;
  specs: SpecItem[];
  leases: Lease[];
  history: Array<{ at: string; event: string; detail?: string }>;
}

interface Config {
  artifacts?: { required_before_implementation?: string[] };
  execution?: { lease_minutes?: number; runtime_mode?: "managed" | "operator"; sequential_specs?: boolean };
  quality?: { auto_repair?: { enabled?: boolean; max_attempts?: number; only_for?: string[] } };
  agents?: Record<string, { adapter?: string }>;
  routing?: Record<string, unknown>;
}

interface Task {
  task_id: string;
  change_id: string;
  role: Role;
  target_spec?: string;
  adapter: string;
  lease_id: string;
  inputs: string[];
  allowed_paths: string[];
  expected_outputs: string[];
  test_commands: string[];
  next_on_success: string;
  subagents: "forbidden";
}

interface Result {
  task_id: string;
  lease_id: string;
  outcome: "completed" | "blocked" | "needs_decision";
  summary?: string;
  evidence?: { changed_files?: string[]; test_results?: string[] };
  unresolved_issues?: string[];
  requested_transition?: string;
  verdict?: Verdict;
  category?: string;
}

interface ProjectState {
  runtime_mode?: "managed" | "operator";
  active_changes: Array<{ change_id: string; state: ChangeState; updated_at: string }>;
  recent_events: Array<{ at: string; change_id: string; event: string; detail?: string }>;
}

interface Requirement {
  name: string;
  body: string;
}

interface Delta {
  added: Requirement[];
  modified: Requirement[];
  removed: Requirement[];
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function flowDir(project = process.cwd()): string {
  return join(project, ".specflow");
}

function changeDir(changeId: string, project = process.cwd()): string {
  return join(flowDir(project), "changes", changeId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readYaml<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeFile(path, stringify(value), "utf8");
}

async function readConfig(project = process.cwd()): Promise<Config> {
  const path = join(flowDir(project), "config.yaml");
  if (!(await exists(path))) fail(`SpecFlow is not initialized in ${project}. Run: specflow init`);
  return readYaml<Config>(path);
}

async function readChange(changeId: string, project = process.cwd()): Promise<Change> {
  const path = join(changeDir(changeId, project), "state.yaml");
  if (!(await exists(path))) fail(`Unknown change: ${changeId}`);
  return readYaml<Change>(path);
}

async function saveChange(change: Change, project = process.cwd()): Promise<void> {
  change.updated_at = now();
  await writeYaml(join(changeDir(change.change_id, project), "state.yaml"), change);
  await updateProjectIndex(project);
}

async function updateProjectIndex(project = process.cwd()): Promise<void> {
  const changes = join(flowDir(project), "changes");
  if (!(await exists(changes))) return;
  const entries = await readdir(changes, { withFileTypes: true });
  const active = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => readYaml<Change>(join(changes, entry.name, "state.yaml"))));
  const index: ProjectState = {
    runtime_mode: (await exists(join(flowDir(project), "state.yaml"))) ? (await readYaml<ProjectState>(join(flowDir(project), "state.yaml"))).runtime_mode ?? "managed" : "managed",
    active_changes: active.map((change) => ({ change_id: change.change_id, state: change.state, updated_at: change.updated_at })),
    recent_events: active.flatMap((change) => change.history.slice(-3).map((event) => ({ ...event, change_id: change.change_id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
  };
  await writeYaml(join(flowDir(project), "state.yaml"), index);
}

function record(change: Change, event: string, detail?: string): void {
  change.history.push({ at: now(), event, ...(detail ? { detail } : {}) });
}

function getSpec(change: Change, specId: string): SpecItem {
  const spec = change.specs.find((item) => item.id === specId);
  if (!spec) fail(`Unknown spec ${specId} in change ${change.change_id}`);
  return spec;
}

function nextReadySpec(change: Change): SpecItem | undefined {
  return change.specs.find((spec) => spec.state === "todo" && spec.depends_on.every((dependency) => getSpec(change, dependency).state === "qa_passed"));
}

function transitionToReady(change: Change): void {
  const next = nextReadySpec(change);
  if (next) {
    next.state = "ready";
    change.state = "ready";
    record(change, "spec_ready", next.id);
    return;
  }
  if (change.specs.length > 0 && change.specs.every((spec) => spec.state === "qa_passed")) {
    change.state = "awaiting_archive_approval";
    record(change, "archive_ready");
    return;
  }
  change.state = "blocked";
  record(change, "blocked", "No runnable spec; check dependencies.");
}

function requirementsInSection(markdown: string, section: string): Requirement[] {
  const sectionMatch = markdown.match(new RegExp(`^## ${section}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  if (!sectionMatch) return [];
  const requirements: Requirement[] = [];
  const expression = /^### Requirement: (.+?)\s*$([\s\S]*?)(?=^### Requirement:|(?![\s\S]))/gm;
  for (const match of sectionMatch[1].matchAll(expression)) {
    const name = match[1]?.trim() ?? "";
    if (name && !/^<.*>$/.test(name)) requirements.push({ name, body: match[2]?.trim() ?? "" });
  }
  return requirements;
}

function parseDelta(markdown: string): Delta {
  return {
    added: requirementsInSection(markdown, "ADDED Requirements"),
    modified: requirementsInSection(markdown, "MODIFIED Requirements"),
    removed: requirementsInSection(markdown, "REMOVED Requirements"),
  };
}

function parseSystemRequirements(markdown: string): Map<string, Requirement> {
  const requirements = new Map<string, Requirement>();
  for (const match of markdown.matchAll(/^### Requirement: (.+?)\s*$([\s\S]*?)(?=^### Requirement:|(?![\s\S]))/gm)) {
    const name = match[1]?.trim() ?? "";
    if (name) requirements.set(name, { name, body: match[2]?.trim() ?? "" });
  }
  return requirements;
}

function renderSystemSpec(domain: string, requirements: Map<string, Requirement>): string {
  const entries = [...requirements.values()].map((requirement) => `### Requirement: ${requirement.name}\n\n${requirement.body}`.trim()).join("\n\n");
  return `# System Spec: ${domain}\n\n## Requirements\n\n${entries}\n`;
}

function ensureNoActiveLease(change: Change, specId?: string): void {
  const active = change.leases.find((lease) => !specId || lease.spec_id === specId);
  if (active) fail(`Active lease ${active.id} exists for ${active.spec_id ?? "this change"}.`);
}

function usage(): string {
  return `SpecFlow v0.1

Usage:
  specflow init [path]
  specflow new <change-id> [--prd <path> ...]
  specflow add-spec <change-id> <spec-id> <title> [--depends-on <spec-id> ...]
  specflow submit-plan <change-id>
  specflow status [change-id]
  specflow validate [change-id]
  specflow approve <change-id>
  specflow resolve <change-id> <planning|ready|repairing|cancelled> [--reason <text>]
  specflow dispatch <change-id> <planner|implementer|reviewer> [--spec <spec-id>]
  specflow prompt <change-id> <task-id>
  specflow import-result <change-id> <task-id> <result.yaml>
  specflow archive <change-id>`;
}

async function commandInit(target = process.cwd()): Promise<void> {
  const root = resolve(target);
  const targetDir = flowDir(root);
  if (await exists(targetDir)) fail(`${targetDir} already exists.`);
  await mkdir(join(targetDir, "system-specs"), { recursive: true });
  await mkdir(join(targetDir, "changes"), { recursive: true });
  await mkdir(join(targetDir, "history"), { recursive: true });
  const templates = join(runtimeRoot, "02-project-template");
  await cp(join(templates, "config.template.yaml"), join(targetDir, "config.yaml"));
  await cp(join(templates, "project-state.template.yaml"), join(targetDir, "state.yaml"));
  console.log(`Initialized SpecFlow in ${targetDir}`);
}

async function commandNew(changeId: string, prds: string[]): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) fail("change-id must be lowercase kebab-case.");
  await readConfig();
  const dir = changeDir(changeId);
  if (await exists(dir)) fail(`Change ${changeId} already exists.`);
  await mkdir(join(dir, "specs"), { recursive: true });
  await mkdir(join(dir, "reviews"), { recursive: true });
  await mkdir(join(dir, "handoffs"), { recursive: true });
  const templates = join(runtimeRoot, "02-project-template");
  for (const [source, target] of [
    ["proposal.template.md", "proposal.md"],
    ["tasks.template.md", "tasks.md"],
    ["design.template.md", "design.md"],
    ["ux-design.template.md", "ux-design.md"],
  ]) await cp(join(templates, source), join(dir, target));
  const proposal = join(dir, "proposal.md");
  if (prds.length) await writeFile(proposal, `${await readFile(proposal, "utf8")}\n## Input PRDs\n\n${prds.map((prd) => `- ${prd}`).join("\n")}\n`);
  const change: Change = { change_id: changeId, state: "planning", created_at: now(), updated_at: now(), specs: [], leases: [], history: [] };
  record(change, "change_created", prds.length ? `PRDs: ${prds.join(", ")}` : "No PRD supplied");
  await saveChange(change);
  console.log(`Created change ${changeId} at ${relative(process.cwd(), dir)}`);
}

async function commandAddSpec(changeId: string, specId: string, title: string, dependencies: string[]): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(specId)) fail("spec-id must be lowercase kebab-case.");
  const change = await readChange(changeId);
  if (change.state !== "planning") fail(`Specs can only be added while planning (currently ${change.state}).`);
  if (change.specs.some((spec) => spec.id === specId)) fail(`Spec ${specId} already exists.`);
  for (const dependency of dependencies) getSpec(change, dependency);
  const templates = join(runtimeRoot, "02-project-template");
  await cp(join(templates, "spec.template.md"), join(changeDir(changeId), "specs", `${specId}.md`));
  const specPath = join(changeDir(changeId), "specs", `${specId}.md`);
  const specTemplate = await readFile(specPath, "utf8");
  await writeFile(specPath, specTemplate.replace("<domain>", specId).replace("<change-id>", changeId));
  change.specs.push({ id: specId, title, state: "todo", depends_on: dependencies, qa_attempts: 0, qa_report: null });
  record(change, "spec_added", `${specId}${dependencies.length ? ` depends_on:${dependencies.join(",")}` : ""}`);
  await saveChange(change);
  console.log(`Added spec ${specId} to ${changeId}.`);
}

async function commandSubmitPlan(changeId: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  if (change.state !== "planning") fail(`Cannot submit a plan in state ${change.state}.`);
  if (!change.specs.length) fail("Cannot submit a plan without specs.");
  const dir = changeDir(changeId);
  for (const required of config.artifacts?.required_before_implementation ?? []) {
    const present = required === "delta_spec"
      ? (await readdir(join(dir, "specs"))).some((entry) => entry.endsWith(".md"))
      : await exists(join(dir, `${required}.md`));
    if (!present) fail(`Cannot submit plan: missing required artifact ${required}.`);
  }
  change.state = "awaiting_plan_approval";
  record(change, "plan_submitted");
  await saveChange(change);
  console.log(`Submitted ${changeId} for plan approval.`);
}

async function commandStatus(changeId?: string): Promise<void> {
  await readConfig();
  const ids = changeId ? [changeId] : (await readdir(join(flowDir(), "changes"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (!ids.length) return console.log("No active changes.");
  for (const id of ids) {
    const change = await readChange(id);
    const summary = change.specs.length ? change.specs.map((spec) => `${spec.id}:${spec.state}`).join(", ") : "no specs yet";
    console.log(`${change.change_id}  ${change.state}  ${summary}`);
  }
}

async function commandValidate(changeId?: string): Promise<void> {
  const config = await readConfig();
  const ids = changeId ? [changeId] : (await readdir(join(flowDir(), "changes"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const errors: string[] = [];
  for (const id of ids) {
    const change = await readChange(id);
    if (!change.change_id || !change.state || !Array.isArray(change.specs)) errors.push(`${id}: malformed state.yaml`);
    for (const spec of change.specs) for (const dependency of spec.depends_on) if (!change.specs.some((other) => other.id === dependency)) errors.push(`${id}/${spec.id}: missing dependency ${dependency}`);
    if (["implementing", "reviewing", "repairing"].includes(change.state) && !change.leases.length && change.state === "implementing") errors.push(`${id}: implementing without a lease`);
    if (change.state === "awaiting_plan_approval") for (const required of config.artifacts?.required_before_implementation ?? []) if (required === "delta_spec" ? !(await readdir(join(changeDir(id), "specs"))).length : !(await exists(join(changeDir(id), `${required}.md`)))) errors.push(`${id}: missing required artifact ${required}`);
  }
  if (errors.length) fail(`Validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  console.log(`Validation passed${changeId ? ` for ${changeId}` : ""}.`);
}

async function commandApprove(changeId: string): Promise<void> {
  const change = await readChange(changeId);
  if (change.state !== "awaiting_plan_approval") fail(`Cannot approve change in state ${change.state}. Planner must first submit a plan for approval.`);
  if (!change.specs.length) fail("Cannot approve a plan without specs. Add specs to state.yaml first.");
  transitionToReady(change);
  record(change, "plan_approved");
  await saveChange(change);
  console.log(`Approved ${changeId}; state is now ${change.state}.`);
}

async function commandResolve(changeId: string, target: ChangeState, reason: string): Promise<void> {
  const allowed: ChangeState[] = ["planning", "ready", "repairing", "cancelled"];
  if (!allowed.includes(target)) fail(`resolve target must be one of: ${allowed.join(", ")}.`);
  const change = await readChange(changeId);
  if (!["blocked", "decision_required"].includes(change.state)) fail(`Can only resolve blocked or decision_required changes (currently ${change.state}).`);
  if (target === "repairing" && !change.specs.some((spec) => spec.state === "repairing")) fail("Cannot resolve to repairing without a spec in repairing state.");
  if (target === "ready" && !change.specs.some((spec) => spec.state === "ready")) transitionToReady(change);
  else change.state = target;
  record(change, "human_resolution", `${target}${reason ? `: ${reason}` : ""}`);
  await saveChange(change);
  console.log(`Resolved ${changeId} to ${change.state}.`);
}

async function commandDispatch(changeId: string, role: Role, specId?: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  let spec: SpecItem | undefined;
  if (role !== "planner") {
    if (!specId) fail(`--spec is required for ${role}.`);
    spec = getSpec(change, specId);
    if (role === "implementer" && !["ready", "repairing"].includes(spec.state)) fail(`Spec ${spec.id} is not ready for implementation (${spec.state}).`);
    if (role === "reviewer" && spec.state !== "reviewing") fail(`Spec ${spec.id} is not ready for review (${spec.state}).`);
    ensureNoActiveLease(change, spec.id);
  } else if (change.state !== "planning") fail(`Planner can only be dispatched while planning (currently ${change.state}).`);
  const taskId = id(role);
  const leaseId = id("lease");
  const minutes = config.execution?.lease_minutes ?? 45;
  const expires = new Date(Date.now() + minutes * 60_000).toISOString();
  const route = String(config.routing?.[role] ?? "manual");
  const adapterName = config.agents?.[route]?.adapter ?? route;
  const task: Task = {
    task_id: taskId, change_id: changeId, role, ...(spec ? { target_spec: spec.id } : {}), adapter: adapterName, lease_id: leaseId,
    inputs: role === "planner" ? ["proposal.md"] : ["proposal.md", "tasks.md", `specs/${spec?.id}.md`],
    allowed_paths: role === "implementer" ? ["src/**", "tests/**", `.${join("specflow", "changes", changeId)}/**`] : [`.specflow/changes/${changeId}/**`],
    expected_outputs: role === "reviewer" ? ["qa_report", "result"] : ["result"], test_commands: [], next_on_success: role === "implementer" ? "reviewing" : "ready", subagents: "forbidden",
  };
  change.leases.push({ id: leaseId, task_id: taskId, role, ...(spec ? { spec_id: spec.id } : {}), expires_at: expires });
  if (role === "implementer" && spec) { spec.state = "implementing"; change.state = "implementing"; }
  if (role === "reviewer" && spec) change.state = "reviewing";
  record(change, "task_dispatched", `${role}:${taskId}${spec ? `:${spec.id}` : ""}`);
  await writeYaml(join(changeDir(changeId), "handoffs", `${taskId}.yaml`), task);
  if (role === "reviewer") {
    await cp(join(runtimeRoot, "02-project-template", "qa-report.template.md"), join(changeDir(changeId), "reviews", `${taskId}.md`));
  }
  await saveChange(change);
  console.log(`Dispatched ${role} task ${taskId}. Handoff: .specflow/changes/${changeId}/handoffs/${taskId}.yaml`);
}

async function commandPrompt(changeId: string, taskId: string): Promise<void> {
  const path = join(changeDir(changeId), "handoffs", `${taskId}.yaml`);
  const task = await readYaml<Task>(path);
  const inputs = task.inputs.map((input) => `.specflow/changes/${changeId}/${input}`).join("、");
  console.log(`你正在执行 SpecFlow 工作单。\n\n角色：${task.role}\n任务包：.specflow/changes/${changeId}/handoffs/${taskId}.yaml\n输入：${inputs}\n允许修改：${task.allowed_paths.join("、")}\n禁止创建 subagent。\n\n先完整阅读任务包及输入工件。只完成指定工作，不得自行推进工作流状态。完成后创建与任务包同目录的 ${taskId}.result.yaml；若为 reviewer，还必须填写 .specflow/changes/${changeId}/reviews/${taskId}.md。遇到需求歧义、架构/安全风险或权限外工作时，在 result 中写 needs_decision 并停止。`);
}

async function commandImportResult(changeId: string, taskId: string, resultPath: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  const task = await readYaml<Task>(join(changeDir(changeId), "handoffs", `${taskId}.yaml`));
  const result = await readYaml<Result>(resolve(resultPath));
  if (result.task_id !== taskId || result.lease_id !== task.lease_id) fail("Result task_id or lease_id does not match the handoff.");
  const leaseIndex = change.leases.findIndex((lease) => lease.id === task.lease_id);
  if (leaseIndex < 0) fail("Lease is no longer active.");
  change.leases.splice(leaseIndex, 1);
  await cp(resolve(resultPath), join(changeDir(changeId), "handoffs", `${taskId}.result.yaml`));
  if (result.outcome === "blocked") { change.state = "blocked"; record(change, "task_blocked", result.summary); }
  else if (result.outcome === "needs_decision") { change.state = "decision_required"; record(change, "decision_required", result.summary); }
  else if (task.role === "implementer") {
    const spec = getSpec(change, task.target_spec!);
    spec.state = "reviewing";
    change.state = "reviewing";
    record(change, "implementation_completed", spec.id);
  } else if (task.role === "reviewer") {
    const verdict = result.verdict;
    if (!verdict) fail("Reviewer result must include verdict: pass, repair, or escalation.");
    const spec = getSpec(change, task.target_spec!);
    const reportPath = join(changeDir(changeId), "reviews", `${taskId}.md`);
    if (!(await exists(reportPath))) fail(`Reviewer must create ${relative(process.cwd(), reportPath)} before importing a result.`);
    spec.qa_report = relative(changeDir(changeId), reportPath);
    if (verdict === "pass") { spec.state = "qa_passed"; record(change, "qa_passed", spec.id); transitionToReady(change); }
    else if (verdict === "repair") {
      const repair = config.quality?.auto_repair;
      const allowed = repair?.enabled && (repair.only_for ?? []).includes(result.category ?? "");
      if (!allowed || spec.qa_attempts >= (repair?.max_attempts ?? 0)) { change.state = "decision_required"; record(change, "decision_required", `${spec.id}:${allowed ? "repeated_failure" : result.category ?? "unclassified"}`); }
      else { spec.qa_attempts += 1; spec.state = "repairing"; change.state = "repairing"; record(change, "repair_dispatched", `${spec.id}:attempt-${spec.qa_attempts}`); }
    } else { change.state = "decision_required"; record(change, "decision_required", `${spec.id}:${result.category ?? "review_escalation"}`); }
  } else { change.state = "awaiting_plan_approval"; record(change, "plan_submitted"); }
  await saveChange(change);
  console.log(`Imported ${task.role} result for ${taskId}; change state is now ${change.state}.`);
}

async function commandArchive(changeId: string): Promise<void> {
  const change = await readChange(changeId);
  if (change.state !== "awaiting_archive_approval") fail(`Cannot archive change in state ${change.state}.`);
  const source = changeDir(changeId);
  const target = join(flowDir(), "history", `${new Date().toISOString().slice(0, 10)}-${changeId}`);
  if (await exists(target)) fail(`Archive target already exists: ${target}`);
  const systemSpecs = join(flowDir(), "system-specs");
  const plans: Array<{ domain: string; output: string; actions: string[] }> = [];
  for (const file of (await readdir(join(source, "specs"))).filter((entry) => entry.endsWith(".md"))) {
    const domain = file.slice(0, -3);
    const delta = parseDelta(await readFile(join(source, "specs", file), "utf8"));
    const targetPath = join(systemSpecs, file);
    const requirements = (await exists(targetPath)) ? parseSystemRequirements(await readFile(targetPath, "utf8")) : new Map<string, Requirement>();
    const actions: string[] = [];
    for (const requirement of delta.added) {
      if (requirements.has(requirement.name)) fail(`Cannot archive ${domain}: ADDED requirement already exists: ${requirement.name}`);
      requirements.set(requirement.name, requirement);
      actions.push(`ADDED ${requirement.name}`);
    }
    for (const requirement of delta.modified) {
      if (!requirements.has(requirement.name)) fail(`Cannot archive ${domain}: MODIFIED requirement does not exist: ${requirement.name}`);
      requirements.set(requirement.name, requirement);
      actions.push(`MODIFIED ${requirement.name}`);
    }
    for (const requirement of delta.removed) {
      if (!requirements.has(requirement.name)) fail(`Cannot archive ${domain}: REMOVED requirement does not exist: ${requirement.name}`);
      requirements.delete(requirement.name);
      actions.push(`REMOVED ${requirement.name}`);
    }
    plans.push({ domain, output: renderSystemSpec(domain, requirements), actions });
  }
  for (const plan of plans) await writeFile(join(systemSpecs, `${plan.domain}.md`), plan.output, "utf8");
  const report = ["# Sync Report", "", ...plans.flatMap((plan) => plan.actions.length ? [`## ${plan.domain}`, ...plan.actions.map((action) => `- ${action}`), ""] : [`## ${plan.domain}`, "- No recognized Delta Spec requirements.", ""])].join("\n");
  await writeFile(join(source, "sync_report.md"), report, "utf8");
  await rename(source, target);
  await updateProjectIndex();
  console.log(`Archived ${changeId} to ${relative(process.cwd(), target)} and merged ${plans.length} Delta Spec file(s).`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) return console.log(usage());
  if (command === "init") return commandInit(args[0]);
  if (command === "new") {
    const [changeId, ...rest] = args;
    if (!changeId) fail("new requires <change-id>.");
    const prds = rest.flatMap((value, index) => value === "--prd" ? [rest[index + 1]] : []).filter(Boolean);
    return commandNew(changeId, prds);
  }
  if (command === "add-spec") {
    const [changeId, specId, title, ...rest] = args;
    const dependencies = rest.flatMap((value, index) => value === "--depends-on" ? [rest[index + 1]] : []).filter((value): value is string => Boolean(value));
    return commandAddSpec(changeId ?? fail("add-spec requires <change-id>."), specId ?? fail("add-spec requires <spec-id>."), title ?? fail("add-spec requires <title>."), dependencies);
  }
  if (command === "submit-plan") return commandSubmitPlan(args[0] ?? fail("submit-plan requires <change-id>."));
  if (command === "status") return commandStatus(args[0]);
  if (command === "validate") return commandValidate(args[0]);
  if (command === "approve") return commandApprove(args[0] ?? fail("approve requires <change-id>."));
  if (command === "resolve") {
    const [changeId, target, ...rest] = args;
    const reasonAt = rest.indexOf("--reason");
    return commandResolve(changeId ?? fail("resolve requires <change-id>."), target as ChangeState, reasonAt >= 0 ? rest[reasonAt + 1] ?? "" : "");
  }
  if (command === "dispatch") {
    const [changeId, role, ...rest] = args;
    const specAt = rest.indexOf("--spec");
    return commandDispatch(changeId ?? fail("dispatch requires <change-id>."), role as Role, specAt >= 0 ? rest[specAt + 1] : undefined);
  }
  if (command === "prompt") return commandPrompt(args[0] ?? fail("prompt requires <change-id>."), args[1] ?? fail("prompt requires <task-id>."));
  if (command === "import-result") return commandImportResult(args[0] ?? fail("import-result requires <change-id>."), args[1] ?? fail("import-result requires <task-id>."), args[2] ?? fail("import-result requires <result.yaml>."));
  if (command === "archive") return commandArchive(args[0] ?? fail("archive requires <change-id>."));
  fail(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(`specflow: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

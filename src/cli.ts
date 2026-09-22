#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

type Role = "planner" | "implementer" | "reviewer";
type SubagentRole = "codebase_researcher" | "test_auditor" | "independent_reviewer";
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
  role: Role | "subagent";
  subagent_role?: SubagentRole;
  spec_id?: string;
  expires_at: string;
  previous_spec_state?: SpecState;
  previous_change_state?: ChangeState;
}

interface Change {
  change_id: string;
  state: ChangeState;
  created_at: string;
  updated_at: string;
  specs: SpecItem[];
  leases: Lease[];
  history: Array<{ at: string; event: string; detail?: string }>;
  labels?: string[];
  resume_state?: ChangeState;
}

interface RouteOverride {
  role?: Role;
  label?: string;
  route: string;
}

interface Config {
  artifacts?: { required_before_implementation?: string[]; required_before_archive?: string[] };
  execution?: { lease_minutes?: number; runtime_mode?: "managed" | "operator"; sequential_specs?: boolean; max_active_changes?: number; max_parallel_workers?: number; auto_start_next_ready_spec?: boolean };
  quality?: { test_commands?: string[]; auto_repair?: { enabled?: boolean; max_attempts?: number; only_for?: string[]; escalate_for?: string[] } };
  agents?: Record<string, { adapter?: string }>;
  routing?: { planner?: string; implementer?: string; reviewer?: string; overrides?: RouteOverride[] };
  subagents?: { default?: "forbidden" | "orchestrator_only"; allowed_callers?: string[]; allowed_roles?: SubagentRole[]; max_depth?: number; max_concurrency?: number; max_runtime_minutes?: number; writable_paths?: string[]; require_bounded_task?: boolean; can_spawn_subagents?: boolean; adapter?: string };
  herdr?: { kind?: Partial<Record<Role, string>>; direction?: "right" | "down"; start_timeout_ms?: number };
}

interface Task {
  task_id: string;
  change_id: string;
  role: Role | "subagent";
  target_spec?: string;
  adapter: string;
  lease_id: string;
  inputs: string[];
  allowed_paths: string[];
  expected_outputs: string[];
  test_commands: string[];
  next_on_success: string;
  subagents: "forbidden" | "orchestrator_only";
  subagent_role?: SubagentRole;
  runtime?: HerdrRuntime;
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
const execFile = promisify(execFileCallback);

type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";

interface HerdrRuntime {
  provider: "herdr";
  agent_name: string;
  pane_id: string;
  state: HerdrState;
  approval_required?: boolean;
}

async function herdrCommand(args: string[], project: string): Promise<any> {
  const { stdout } = await execFile("herdr", args, { cwd: project, env: process.env, timeout: 30_000 });
  return parse(stdout);
}

async function startHerdrAgent(args: string[], project: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await herdrCommand(args, project); }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function herdrEnabled(): boolean {
  return process.env.HERDR_ENV === "1";
}

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

function validateConfig(config: Config): void {
  const execution = config.execution;
  if (execution?.max_active_changes !== undefined && execution.max_active_changes < 1) fail("max_active_changes must be at least 1.");
  if (execution?.max_parallel_workers !== undefined && execution.max_parallel_workers < 1) fail("max_parallel_workers must be at least 1.");
  const subagents = config.subagents;
  if (subagents && !["forbidden", "orchestrator_only"].includes(subagents.default ?? "forbidden")) fail("subagents.default must be forbidden or orchestrator_only.");
  if (subagents?.can_spawn_subagents) fail("subagents.can_spawn_subagents must be false.");
  if (subagents?.max_depth !== undefined && subagents.max_depth > 1) fail("subagents.max_depth cannot exceed 1.");
  if (subagents?.max_concurrency !== undefined && subagents.max_concurrency < 1) fail("subagents.max_concurrency must be at least 1.");
  if (subagents?.max_runtime_minutes !== undefined && subagents.max_runtime_minutes < 1) fail("subagents.max_runtime_minutes must be at least 1.");
  if (subagents?.default === "orchestrator_only" && !(subagents.allowed_roles ?? []).length) fail("orchestrator_only requires at least one allowed_roles entry.");
  if (subagents?.writable_paths?.length) fail("subagents.writable_paths must be empty.");
  if (subagents?.require_bounded_task === false) fail("subagents.require_bounded_task must remain true.");
}

async function readConfig(project = process.cwd()): Promise<Config> {
  const path = join(flowDir(project), "config.yaml");
  if (!(await exists(path))) fail(`SpecFlow is not initialized in ${project}. Run: specflow init`);
  const config = await readYaml<Config>(path);
  validateConfig(config);
  return config;
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

function taskPrompt(task: Task): string {
  const inputs = task.inputs.map((input) => `.specflow/changes/${task.change_id}/${input}`).join("、");
  const readOnly = task.role === "subagent" ? "这是只读辅助任务，不得修改任何项目文件、创建 subagent 或推进状态。" : "";
  return `你正在执行 SpecFlow 工作单。角色：${task.role}${task.subagent_role ? `（${task.subagent_role}）` : ""}。任务包：.specflow/changes/${task.change_id}/handoffs/${task.task_id}.yaml。输入：${inputs}。允许修改：${task.allowed_paths.join("、") || "无"}。${readOnly}禁止创建 subagent。完成后创建 .specflow/changes/${task.change_id}/handoffs/${task.task_id}.result.yaml；reviewer 还必须填写 .specflow/changes/${task.change_id}/reviews/${task.task_id}.md。遇到需求歧义、架构/安全风险或权限外工作时写 needs_decision 并停止。`;
}

function getSpec(change: Change, specId: string): SpecItem {
  const spec = change.specs.find((item) => item.id === specId);
  if (!spec) fail(`Unknown spec ${specId} in change ${change.change_id}`);
  return spec;
}

function nextReadySpec(change: Change): SpecItem | undefined {
  return change.specs.find((spec) => spec.state === "todo" && spec.depends_on.every((dependency) => getSpec(change, dependency).state === "qa_passed"));
}

function transitionToReady(change: Change, sequential = true): void {
  const ready = change.specs.filter((spec) => spec.state === "todo" && spec.depends_on.every((dependency) => getSpec(change, dependency).state === "qa_passed"));
  if (ready.length) {
    const candidates = sequential ? ready.slice(0, 1) : ready;
    for (const spec of candidates) {
      spec.state = "ready";
      record(change, "spec_ready", spec.id);
    }
    change.state = "ready";
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

type DesignImpact = "none" | "visual" | "design_system";

function parseDesignImpact(markdown: string): DesignImpact {
  const match = markdown.match(/^\s*-\s*档位：[^\n]*?\b(none|visual|design_system)\b/m);
  if (!match) fail("proposal.md must declare Design Impact: none, visual, or design_system.");
  return match[1] as DesignImpact;
}

async function assertDesignReady(dir: string): Promise<void> {
  const impact = parseDesignImpact(await readFile(join(dir, "proposal.md"), "utf8"));
  if (impact === "none") return;
  const uxPath = join(dir, "ux-design.md");
  if (!(await exists(uxPath)) || /<change-id>|<.*>/.test(await readFile(uxPath, "utf8"))) fail(`Design Impact ${impact} requires a completed ux-design.md.`);
  const proposal = await readFile(join(dir, "proposal.md"), "utf8");
  const evidence = proposal.match(/^\s*-\s*证据路径：\s*(.+)$/m)?.[1]?.trim();
  if (!evidence || /mockup\/截图/.test(evidence) || /^[-—]?$/.test(evidence)) fail(`Design Impact ${impact} requires a visual evidence path in proposal.md.`);
  if (impact === "design_system" && /<change-id>|<.*>/.test(await readFile(join(dir, "design.md"), "utf8"))) fail("Design Impact design_system requires a completed design.md.");
}

async function assertDesignQa(dir: string, reportPath: string): Promise<void> {
  const impact = parseDesignImpact(await readFile(join(dir, "proposal.md"), "utf8"));
  if (impact === "none") return;
  const report = await readFile(reportPath, "utf8");
  const section = report.match(/^## Design Conformance\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
  if (!section || /视觉验收清单逐条结果|token 合规检查/.test(section) || !/(\[x\]|pass|通过)/i.test(section)) fail(`Design Impact ${impact} requires completed Design Conformance evidence in the QA report.`);
}

function validateResult(task: Task, result: Result): void {
  if (!(["completed", "blocked", "needs_decision"] as const).includes(result.outcome)) fail("Result outcome must be completed, blocked, or needs_decision.");
  if (task.role === "implementer" && result.outcome === "completed") {
    if (!(result.evidence?.changed_files ?? []).length) fail("Implementer result must include evidence.changed_files.");
    if (!(result.evidence?.test_results ?? []).length) fail("Implementer result must include evidence.test_results.");
  }
  if (task.role === "reviewer" && result.outcome === "completed" && !(["pass", "repair", "escalation"] as const).includes(result.verdict as Verdict)) fail("Reviewer result must include verdict: pass, repair, or escalation.");
}

function parseDelta(markdown: string): Delta {
  return {
    added: requirementsInSection(markdown, "ADDED Requirements"),
    modified: requirementsInSection(markdown, "MODIFIED Requirements"),
    removed: requirementsInSection(markdown, "REMOVED Requirements"),
  };
}

function hasDeltaRequirements(delta: Delta): boolean {
  return delta.added.length + delta.modified.length + delta.removed.length > 0;
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

function expireLeases(change: Change, preserveLeaseId?: string): void {
  const timestamp = Date.now();
  const expired = change.leases.filter((lease) => lease.id !== preserveLeaseId && Date.parse(lease.expires_at) <= timestamp);
  if (!expired.length) return;
  change.leases = change.leases.filter((lease) => lease.id === preserveLeaseId || Date.parse(lease.expires_at) > timestamp);
  for (const lease of expired) {
    if (lease.spec_id && lease.previous_spec_state) {
      const spec = change.specs.find((item) => item.id === lease.spec_id);
      if (spec && ["implementing", "reviewing"].includes(spec.state)) spec.state = lease.previous_spec_state;
    }
    record(change, "lease_expired", `${lease.id}:${lease.task_id}`);
  }
  if (!change.leases.length && change.state !== "archived") {
    const previous = [...expired].reverse().find((lease) => lease.previous_change_state)?.previous_change_state;
    if (previous) change.state = previous;
  }
}

function ensureNoActiveLease(change: Change, specId?: string): void {
  const active = change.leases.find((lease) => !specId || lease.spec_id === specId);
  if (active) fail(`Active lease ${active.id} exists for ${active.spec_id ?? "this change"}.`);
}

function resolveRoute(config: Config, change: Change, role: Role): string {
  const override = config.routing?.overrides?.find((rule) => (!rule.role || rule.role === role) && (!rule.label || change.labels?.includes(rule.label)));
  return override?.route ?? config.routing?.[role] ?? "manual";
}

function usage(): string {
  return `SpecFlow v0.1

Usage:
  specflow init [path]
  specflow new <change-id> [--prd <path> ...] [--label <label> ...]
  specflow add-spec <change-id> <spec-id> <title> [--depends-on <spec-id> ...]
  specflow submit-plan <change-id>
  specflow status [change-id]
  specflow validate [change-id]
  specflow approve <change-id>
  specflow resolve <change-id> <previous|planning|ready|repairing|cancelled> [--reason <text>]
  specflow dispatch <change-id> <planner|implementer|reviewer> [--spec <spec-id>]
  specflow dispatch-subagent <change-id> <codebase_researcher|test_auditor|independent_reviewer> [--spec <spec-id>] [--task <text>]
  specflow monitor <change-id> <task-id> [--wait] [--timeout <ms>]
  specflow approve-agent <change-id> <task-id> [--key <key>] --confirm
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
  await mkdir(join(root, "docs", "design"), { recursive: true });
  const templates = join(runtimeRoot, "02-project-template");
  await cp(join(templates, "config.template.yaml"), join(targetDir, "config.yaml"));
  await cp(join(templates, "project-state.template.yaml"), join(targetDir, "state.yaml"));
  await cp(join(templates, "design-charter.template.md"), join(root, "docs", "design", "design-charter.md"));
  await cp(join(templates, "design-tokens.template.md"), join(root, "docs", "design", "design-tokens.md"));
  await cp(join(templates, "visual-qa-checklist.template.md"), join(root, "docs", "design", "visual-qa-checklist.md"));
  console.log(`Initialized SpecFlow in ${targetDir}`);
}

async function commandNew(changeId: string, prds: string[], labels: string[]): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) fail("change-id must be lowercase kebab-case.");
  const config = await readConfig();
  const changesDir = join(flowDir(), "changes");
  if (config.execution?.max_active_changes !== undefined && await exists(changesDir)) {
    const entries = await readdir(changesDir, { withFileTypes: true });
    const active = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readYaml<Change>(join(changesDir, entry.name, "state.yaml"))));
    const activeCount = active.filter((change) => !["archived", "cancelled"].includes(change.state)).length;
    if (activeCount >= config.execution.max_active_changes) fail(`Cannot create change: max_active_changes (${config.execution.max_active_changes}) reached.`);
  }
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
    ["test-report.template.md", "test_report.md"],
  ]) await cp(join(templates, source), join(dir, target));
  const proposal = join(dir, "proposal.md");
  if (prds.length) await writeFile(proposal, `${await readFile(proposal, "utf8")}\n## Input PRDs\n\n${prds.map((prd) => `- ${prd}`).join("\n")}\n`);
  const change: Change = { change_id: changeId, state: "planning", created_at: now(), updated_at: now(), specs: [], leases: [], history: [], ...(labels.length ? { labels } : {}) };
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
  await assertDesignReady(dir);
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
    for (const file of (await readdir(join(changeDir(id), "specs"))).filter((entry) => entry.endsWith(".md"))) {
      if (!hasDeltaRequirements(parseDelta(await readFile(join(changeDir(id), "specs", file), "utf8")))) errors.push(`${id}/${file}: no recognized Delta Spec requirements; use ADDED, MODIFIED, or REMOVED Requirements sections`);
    }
    if (["implementing", "reviewing", "repairing"].includes(change.state) && !change.leases.length && change.state === "implementing") errors.push(`${id}: implementing without a lease`);
    if (change.state === "awaiting_plan_approval") for (const required of config.artifacts?.required_before_implementation ?? []) if (required === "delta_spec" ? !(await readdir(join(changeDir(id), "specs"))).length : !(await exists(join(changeDir(id), `${required}.md`)))) errors.push(`${id}: missing required artifact ${required}`);
    if (change.state === "awaiting_archive_approval") errors.push(...(await archiveArtifactErrors(change, config, changeDir(id))).map((error) => `${id}: ${error}`));
  }
  if (errors.length) fail(`Validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  console.log(`Validation passed${changeId ? ` for ${changeId}` : ""}.`);
}

async function commandApprove(changeId: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  if (change.state !== "awaiting_plan_approval") fail(`Cannot approve change in state ${change.state}. Planner must first submit a plan for approval.`);
  if (!change.specs.length) fail("Cannot approve a plan without specs. Add specs to state.yaml first.");
  transitionToReady(change, config.execution?.sequential_specs ?? true);
  record(change, "plan_approved");
  await saveChange(change);
  console.log(`Approved ${changeId}; state is now ${change.state}.`);
}

async function commandResolve(changeId: string, target: string, reason: string): Promise<void> {
  const config = await readConfig();
  const allowed = ["previous", "planning", "ready", "repairing", "cancelled"];
  if (!allowed.includes(target)) fail(`resolve target must be one of: ${allowed.join(", ")}.`);
  const change = await readChange(changeId);
  if (!["blocked", "decision_required"].includes(change.state)) fail(`Can only resolve blocked or decision_required changes (currently ${change.state}).`);
  const resolvedTarget = target === "previous" ? change.resume_state ?? fail("No previous state was recorded.") : target as ChangeState;
  if (resolvedTarget === "repairing" && !change.specs.some((spec) => spec.state === "repairing")) fail("Cannot resolve to repairing without a spec in repairing state.");
  if (resolvedTarget === "ready" && !change.specs.some((spec) => spec.state === "ready")) transitionToReady(change, config.execution?.sequential_specs ?? true);
  else change.state = resolvedTarget;
  change.resume_state = undefined;
  record(change, "human_resolution", `${resolvedTarget}${reason ? `: ${reason}` : ""}`);
  await saveChange(change);
  console.log(`Resolved ${changeId} to ${change.state}.`);
}

async function commandDispatch(changeId: string, role: Role, specId?: string): Promise<void> {
  if (!(["planner", "implementer", "reviewer"] as const).includes(role)) fail("role must be planner, implementer, or reviewer.");
  const config = await readConfig();
  const change = await readChange(changeId);
  expireLeases(change);
  const maxWorkers = config.execution?.max_parallel_workers;
  if (maxWorkers !== undefined && change.leases.length >= maxWorkers) fail(`Cannot dispatch: max_parallel_workers (${maxWorkers}) reached.`);
  let spec: SpecItem | undefined;
  if (role !== "planner") {
    if (!specId) fail(`--spec is required for ${role}.`);
    spec = getSpec(change, specId);
    if (role === "implementer") await assertDesignReady(changeDir(changeId));
    if (role === "implementer" && !["ready", "repairing"].includes(spec.state)) fail(`Spec ${spec.id} is not ready for implementation (${spec.state}).`);
    if (role === "reviewer" && spec.state !== "reviewing") fail(`Spec ${spec.id} is not ready for review (${spec.state}).`);
    ensureNoActiveLease(change, spec.id);
  } else {
    if (change.state !== "planning") fail(`Planner can only be dispatched while planning (currently ${change.state}).`);
    ensureNoActiveLease(change);
  }
  const taskId = id(role);
  const leaseId = id("lease");
  const minutes = config.execution?.lease_minutes ?? 45;
  const expires = new Date(Date.now() + minutes * 60_000).toISOString();
  const route = resolveRoute(config, change, role);
  const adapterName = config.agents?.[route]?.adapter ?? route;
  const task: Task = {
    task_id: taskId, change_id: changeId, role, ...(spec ? { target_spec: spec.id } : {}), adapter: adapterName, lease_id: leaseId,
    inputs: role === "planner" ? ["proposal.md"] : ["proposal.md", "tasks.md", `specs/${spec?.id}.md`],
    allowed_paths: role === "implementer" ? ["src/**", "tests/**", `.${join("specflow", "changes", changeId)}/**`] : [`.specflow/changes/${changeId}/**`],
    expected_outputs: role === "reviewer" ? ["qa_report", "result"] : ["result"], test_commands: config.quality?.test_commands ?? [], next_on_success: role === "implementer" ? "reviewing" : "ready", subagents: "forbidden",
  };
  change.leases.push({
    id: leaseId,
    task_id: taskId,
    role,
    ...(spec ? { spec_id: spec.id, previous_spec_state: spec.state, previous_change_state: change.state } : {}),
    expires_at: expires,
  });
  if (role === "implementer" && spec) { spec.state = "implementing"; change.state = "implementing"; }
  if (role === "reviewer" && spec) change.state = "reviewing";
  record(change, "task_dispatched", `${role}:${taskId}${spec ? `:${spec.id}` : ""}:route=${route}`);
  await writeYaml(join(changeDir(changeId), "handoffs", `${taskId}.yaml`), task);
  if (adapterName === "herdr") {
    if (!herdrEnabled()) {
      record(change, "adapter_fallback", "herdr unavailable outside a Herdr-managed pane; using manual handoff");
    } else {
      try {
        const split = await herdrCommand(["pane", "split", "--current", "--direction", config.herdr?.direction ?? "right", "--cwd", process.cwd(), "--no-focus"], process.cwd());
        const paneId = split?.result?.pane?.pane_id;
        if (!paneId) fail("Herdr did not return a pane id.");
        const agentName = `${role}-${taskId}`.slice(0, 32).replace(/[^a-z0-9_-]/g, "-");
        const kind = config.herdr?.kind?.[role] ?? "codex";
        const startTimeout = String(config.herdr?.start_timeout_ms ?? 30_000);
        await startHerdrAgent(["agent", "start", agentName, "--kind", kind, "--pane", paneId, "--timeout", startTimeout], process.cwd());
        await herdrCommand(["agent", "wait", agentName, "--until", "idle", "--timeout", startTimeout], process.cwd());
        await herdrCommand(["agent", "prompt", agentName, taskPrompt(task)], process.cwd());
        task.runtime = { provider: "herdr", agent_name: agentName, pane_id: paneId, state: "working" };
        record(change, "herdr_agent_started", `${agentName}:${paneId}`);
        await writeYaml(join(changeDir(changeId), "handoffs", `${taskId}.yaml`), task);
      } catch (error) {
        record(change, "adapter_fallback", `herdr launch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (role === "reviewer") {
    await cp(join(runtimeRoot, "02-project-template", "qa-report.template.md"), join(changeDir(changeId), "reviews", `${taskId}.md`));
  }
  await saveChange(change);
  console.log(`Dispatched ${role} task ${taskId}. Handoff: .specflow/changes/${changeId}/handoffs/${taskId}.yaml`);
}

async function commandDispatchSubagent(changeId: string, subagentRole: SubagentRole, specId: string | undefined, taskDescription: string): Promise<void> {
  const config = await readConfig();
  const policy = config.subagents;
  if (!policy || policy.default !== "orchestrator_only") fail("Subagent dispatch requires subagents.default: orchestrator_only.");
  if (!(policy.allowed_roles ?? []).includes(subagentRole)) fail(`Subagent role ${subagentRole} is not allowed by config.`);
  const change = await readChange(changeId);
  expireLeases(change);
  const activeSubagents = change.leases.filter((lease) => lease.role === "subagent").length;
  if (activeSubagents >= (policy.max_concurrency ?? 1)) fail(`Cannot dispatch subagent: max_concurrency (${policy.max_concurrency ?? 1}) reached.`);
  if (specId) getSpec(change, specId);
  const taskId = id("subagent");
  const leaseId = id("lease");
  const minutes = (policy.max_runtime_minutes ?? 10);
  const task: Task = {
    task_id: taskId, change_id: changeId, role: "subagent", ...(specId ? { target_spec: specId } : {}), subagent_role: subagentRole,
    adapter: policy.adapter ?? "manual", lease_id: leaseId,
    inputs: ["proposal.md", ...(specId ? [`specs/${specId}.md`] : []), "tasks.md"], allowed_paths: [],
    expected_outputs: ["result"], test_commands: [], next_on_success: "report", subagents: "orchestrator_only",
  };
  change.leases.push({ id: leaseId, task_id: taskId, role: "subagent", subagent_role: subagentRole, ...(specId ? { spec_id: specId } : {}), expires_at: new Date(Date.now() + minutes * 60_000).toISOString() });
  record(change, "subagent_dispatched", `${subagentRole}:${taskId}${taskDescription ? `:${taskDescription}` : ""}`);
  await writeYaml(join(changeDir(changeId), "handoffs", `${taskId}.yaml`), task);
  await saveChange(change);
  console.log(`Dispatched read-only ${subagentRole} task ${taskId}. Handoff: .specflow/changes/${changeId}/handoffs/${taskId}.yaml`);
}

async function commandPrompt(changeId: string, taskId: string): Promise<void> {
  const path = join(changeDir(changeId), "handoffs", `${taskId}.yaml`);
  const task = await readYaml<Task>(path);
  console.log(taskPrompt(task));
}

async function commandMonitor(changeId: string, taskId: string, wait: boolean, timeout: string): Promise<void> {
  const task = await readYaml<Task>(join(changeDir(changeId), "handoffs", `${taskId}.yaml`));
  if (task.runtime?.provider !== "herdr") fail(`Task ${taskId} is not running through Herdr.`);
  if (!herdrEnabled()) fail("Herdr monitoring requires a Herdr-managed pane (HERDR_ENV=1).");
  const response = await herdrCommand(wait
    ? ["agent", "wait", task.runtime.agent_name, "--timeout", timeout]
    : ["agent", "get", task.runtime.agent_name], process.cwd());
  const state = (response?.result?.agent_status ?? response?.result?.state) as HerdrState | undefined;
  const blocked = state === "blocked";
  task.runtime.state = state ?? "unknown";
  task.runtime.approval_required = blocked;
  await writeYaml(join(changeDir(changeId), "handoffs", `${taskId}.yaml`), task);
  const change = await readChange(changeId);
  record(change, "herdr_probe", `${task.runtime.agent_name}:${task.runtime.state}${blocked ? ":approval_required" : ""}`);
  await saveChange(change);
  console.log(`Herdr agent ${task.runtime.agent_name}: ${task.runtime.state}${blocked ? ". Human approval required; inspect the Herdr prompt before approving." : ""}`);
}

async function commandApproveAgent(changeId: string, taskId: string, key: string, confirmed: boolean): Promise<void> {
  if (!confirmed) fail("Agent approval requires --confirm after inspecting the Herdr prompt.");
  const taskPath = join(changeDir(changeId), "handoffs", `${taskId}.yaml`);
  const task = await readYaml<Task>(taskPath);
  if (task.runtime?.provider !== "herdr") fail(`Task ${taskId} is not running through Herdr.`);
  if (!herdrEnabled()) fail("Herdr approval requires a Herdr-managed pane (HERDR_ENV=1).");
  const response = await herdrCommand(["agent", "get", task.runtime.agent_name], process.cwd());
  if (response?.result?.agent_status !== "blocked") fail("Agent is not currently blocked; refusing to send an approval key.");
  await herdrCommand(["agent", "send-keys", task.runtime.agent_name, key], process.cwd());
  task.runtime.approval_required = false;
  task.runtime.state = "working";
  await writeYaml(taskPath, task);
  const change = await readChange(changeId);
  record(change, "herdr_permission_approved", `${task.runtime.agent_name}:${key}`);
  await saveChange(change);
  console.log(`Approved Herdr agent ${task.runtime.agent_name} with key ${key}.`);
}

async function commandImportResult(changeId: string, taskId: string, resultPath: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  const task = await readYaml<Task>(join(changeDir(changeId), "handoffs", `${taskId}.yaml`));
  const result = await readYaml<Result>(resolve(resultPath));
  if (result.task_id !== taskId || result.lease_id !== task.lease_id) fail("Result task_id or lease_id does not match the handoff.");
  validateResult(task, result);
  const leasesBeforeExpiry = change.leases.length;
  const matchingLease = change.leases.find((lease) => lease.id === task.lease_id);
  expireLeases(change, matchingLease?.id);
  let leaseIndex = change.leases.findIndex((lease) => lease.id === task.lease_id);
  if (leaseIndex < 0) {
    if (change.leases.length !== leasesBeforeExpiry) await saveChange(change);
    fail("Lease is no longer active.");
  }
  const conflictingLease = change.leases.find((lease) => lease.id !== task.lease_id && (task.target_spec ? lease.spec_id === task.target_spec : lease.role === task.role));
  if (conflictingLease) fail(`Cannot import result while newer conflicting lease ${conflictingLease.id} is active.`);
  if (Date.parse(matchingLease!.expires_at) <= Date.now()) record(change, "late_result_imported", `${task.lease_id}:${taskId}`);
  if (result.outcome === "blocked") { change.resume_state = change.state; change.state = "blocked"; record(change, "task_blocked", result.summary); }
  else if (result.outcome === "needs_decision") { change.resume_state = change.state; change.state = "decision_required"; record(change, "decision_required", result.summary); }
  else if (task.role === "implementer") {
    const spec = getSpec(change, task.target_spec!);
    spec.state = "reviewing";
    change.state = "reviewing";
    record(change, "implementation_completed", spec.id);
  } else if (task.role === "subagent") {
    record(change, "subagent_completed", `${task.subagent_role}:${taskId}`);
  } else if (task.role === "reviewer") {
    const verdict = result.verdict;
    if (!verdict) fail("Reviewer result must include verdict: pass, repair, or escalation.");
    const spec = getSpec(change, task.target_spec!);
    const reportPath = join(changeDir(changeId), "reviews", `${taskId}.md`);
    if (!(await exists(reportPath))) fail(`Reviewer must create ${relative(process.cwd(), reportPath)} before importing a result.`);
    await assertDesignQa(changeDir(changeId), reportPath);
    spec.qa_report = relative(changeDir(changeId), reportPath);
    if (verdict === "pass") { spec.state = "qa_passed"; record(change, "qa_passed", spec.id); transitionToReady(change, config.execution?.sequential_specs ?? true); }
    else if (verdict === "repair") {
      const repair = config.quality?.auto_repair;
      const category = result.category ?? "unclassified";
      const escalates = (repair?.escalate_for ?? []).includes(category);
      const allowed = !escalates && repair?.enabled && (repair.only_for ?? []).includes(category);
      if (!allowed || spec.qa_attempts >= (repair?.max_attempts ?? 0)) { change.resume_state = change.state; change.state = "decision_required"; record(change, "decision_required", `${spec.id}:${allowed ? "repeated_failure" : category}`); }
      else { spec.qa_attempts += 1; spec.state = "repairing"; change.state = "repairing"; record(change, "repair_dispatched", `${spec.id}:attempt-${spec.qa_attempts}`); }
    } else { change.resume_state = change.state; change.state = "decision_required"; record(change, "decision_required", `${spec.id}:${result.category ?? "review_escalation"}`); }
  } else { change.state = "awaiting_plan_approval"; record(change, "plan_submitted"); }
  await cp(resolve(resultPath), join(changeDir(changeId), "handoffs", `${taskId}.result.yaml`));
  leaseIndex = change.leases.findIndex((lease) => lease.id === task.lease_id);
  change.leases.splice(leaseIndex, 1);
  const nextSpec = task.role === "reviewer" && config.execution?.auto_start_next_ready_spec && change.state === "ready"
    ? change.specs.find((item) => item.state === "ready")
    : undefined;
  await saveChange(change);
  if (nextSpec) await commandDispatch(changeId, "implementer", nextSpec.id);
  console.log(`Imported ${task.role} result for ${taskId}; change state is now ${change.state}.`);
}

async function archiveArtifactErrors(change: Change, config: Config, source: string): Promise<string[]> {
  const errors: string[] = [];
  for (const required of config.artifacts?.required_before_archive ?? []) {
    if (required === "qa_report") {
      const complete = (await Promise.all(change.specs.map(async (spec) => Boolean(spec.qa_report && await exists(join(source, spec.qa_report!)))))).every(Boolean);
      if (!complete) errors.push("every spec must have an existing qa_report");
    } else {
      const artifact = required === "test_report" ? "test_report.md" : `${required}.md`;
      const artifactPath = join(source, artifact);
      if (!(await exists(artifactPath))) errors.push(`missing required artifact ${required}`);
      else if (required === "test_report" && /<command>|<result>/.test(await readFile(artifactPath, "utf8"))) errors.push("test_report.md still contains template placeholders");
    }
  }
  const impact = parseDesignImpact(await readFile(join(source, "proposal.md"), "utf8"));
  if (impact !== "none") {
    for (const spec of change.specs) {
      if (!spec.qa_report) continue;
      try { await assertDesignQa(source, join(source, spec.qa_report)); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  return errors;
}

async function commandArchive(changeId: string): Promise<void> {
  const config = await readConfig();
  const change = await readChange(changeId);
  if (change.state !== "awaiting_archive_approval") fail(`Cannot archive change in state ${change.state}.`);
  const source = changeDir(changeId);
  const archiveErrors = await archiveArtifactErrors(change, config, source);
  if (archiveErrors.length) fail(`Cannot archive:\n${archiveErrors.map((error) => `- ${error}`).join("\n")}`);
  const target = join(flowDir(), "history", `${new Date().toISOString().slice(0, 10)}-${changeId}`);
  if (await exists(target)) fail(`Archive target already exists: ${target}`);
  const systemSpecs = join(flowDir(), "system-specs");
  const plans: Array<{ domain: string; output: string; actions: string[] }> = [];
  for (const file of (await readdir(join(source, "specs"))).filter((entry) => entry.endsWith(".md"))) {
    const domain = file.slice(0, -3);
    const delta = parseDelta(await readFile(join(source, "specs", file), "utf8"));
    if (!hasDeltaRequirements(delta)) fail(`Cannot archive ${domain}: no recognized Delta Spec requirements; use ADDED, MODIFIED, or REMOVED Requirements sections.`);
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
  change.state = "archived";
  record(change, "archive_completed", `Merged ${plans.length} Delta Spec file(s).`);
  change.updated_at = now();
  await writeYaml(join(source, "state.yaml"), change);
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
    const labels = rest.flatMap((value, index) => value === "--label" ? [rest[index + 1]] : []).filter((value): value is string => Boolean(value));
    return commandNew(changeId, prds, labels);
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
    return commandResolve(changeId ?? fail("resolve requires <change-id>."), target ?? fail("resolve requires <target>."), reasonAt >= 0 ? rest[reasonAt + 1] ?? "" : "");
  }
  if (command === "dispatch") {
    const [changeId, role, ...rest] = args;
    const specAt = rest.indexOf("--spec");
    return commandDispatch(changeId ?? fail("dispatch requires <change-id>."), role as Role, specAt >= 0 ? rest[specAt + 1] : undefined);
  }
  if (command === "dispatch-subagent") {
    const [changeId, subagentRole, ...rest] = args;
    const specAt = rest.indexOf("--spec");
    const taskAt = rest.indexOf("--task");
    return commandDispatchSubagent(changeId ?? fail("dispatch-subagent requires <change-id>."), subagentRole as SubagentRole, specAt >= 0 ? rest[specAt + 1] : undefined, taskAt >= 0 ? rest[taskAt + 1] ?? "" : "");
  }
  if (command === "monitor") {
    const [changeId, taskId, ...rest] = args;
    const timeoutAt = rest.indexOf("--timeout");
    return commandMonitor(changeId ?? fail("monitor requires <change-id>."), taskId ?? fail("monitor requires <task-id>."), rest.includes("--wait"), timeoutAt >= 0 ? rest[timeoutAt + 1] ?? "30000" : "30000");
  }
  if (command === "approve-agent") {
    const [changeId, taskId, ...rest] = args;
    const keyAt = rest.indexOf("--key");
    return commandApproveAgent(changeId ?? fail("approve-agent requires <change-id>."), taskId ?? fail("approve-agent requires <task-id>."), keyAt >= 0 ? rest[keyAt + 1] ?? "enter" : "enter", rest.includes("--confirm"));
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

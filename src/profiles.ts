import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession } from "./files.ts";
import { agentEffort, agents, checkCommands, effortName, minutes, modelName, parseDispatchArgs, type Agent, type DispatchOptions } from "./dispatch.ts";
import { projectRoot } from "./source.ts";
import { ensure, record } from "./validation.ts";
import type { Mode } from "./types.ts";

/** Which agent and model a dispatch uses: set once, picked by the waiting handoff's role. */
export interface AgentProfile {
  via: Agent;
  model?: string;
  /** The agent's own effort or thinking level, such as medium. */
  effort?: string;
  timeoutMinutes?: number;
}
export interface RoleChoice {
  profile: string;
  /** Exact commands for this role. From a project file they must be confirmed before running. */
  checks?: string[];
  checkTimeoutMinutes?: number;
}
type Source = "user" | "project";
export interface AgentConfig {
  /** User file only: run the continue step after every dispatch that returns a valid reply. */
  autoContinue: boolean;
  /** User file only: your rules, given in advance, that may answer human-owned decisions. */
  policies: string[];
  /** User file only: accept recommendations for low-risk, reversible, non-sensitive decisions. */
  autoDecide: "off" | "low-risk";
  profiles: Record<string, AgentProfile & { source: Source }>;
  roles: Partial<Record<Mode, RoleChoice & { source: Source }>>;
  files: { user: string; project: string; found: Source[] };
}

const roles: Mode[] = ["planning", "review", "advisor", "implementation", "testing"];
const name = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Personal settings for every project. Pi's own agent directory, honouring PI_CODING_AGENT_DIR. */
export const userConfigPath = (): string =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "waicc-agents.json");
/** Shared with everyone who uses the repository; tracked like any other project file. */
export const projectConfigPath = (root: string): string => join(root, ".pi", "waicc-agents.json");
/** The default agent setup shipped with the package; src/ and dist/ sit at the same depth. */
export const templateConfigPath = (): string => fileURLToPath(new URL("../templates/waicc-agents.json", import.meta.url));
const initHint = "Run /waicc-dispatch --init-profiles (CLI: waicc profiles init) to create it from the default template";

/** Creates the user file from the template, never replacing a file that exists. */
export function initAgentConfig() {
  const path = userConfigPath();
  if (existsSync(path))
    return { created: false, path, nextAction: "You already have an agent config; it was left unchanged. Edit it, then check with /waicc-dispatch --profiles." };
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(templateConfigPath(), path);
  return {
    created: true, path, template: templateConfigPath(),
    nextAction: "Created your agent config from the default template. Its models need matching accounts (Claude, Codex, and DeepSeek in Pi); change any you do not have, then check with /waicc-dispatch --profiles.",
  };
}

function readConfig(path: string, source: Source, into: AgentConfig): void {
  if (!existsSync(path)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const at = (detail: string) => `${path}: ${detail}`;
  const config = record(raw, at("the file"));
  ensure(Object.keys(config).every((key) => ["profiles", "roles", "autoContinue", "policies", "autoDecide"].includes(key)), at('only "profiles", "roles", "autoContinue", "policies" and "autoDecide" are allowed'));
  // Settings that let WAICC act for you are yours alone: a repository must not grant them.
  for (const key of ["policies", "autoDecide"])
    ensure(config[key] === undefined || source === "user", at(`"${key}" is allowed only in your user file`));
  if (config.policies !== undefined) {
    ensure(Array.isArray(config.policies) && config.policies.length <= 20, at('"policies" must be a list of at most 20 rules'));
    into.policies = (config.policies as unknown[]).map((policy, i) => {
      ensure(typeof policy === "string" && policy.trim().length > 0 && policy.length <= 500, at(`policy ${i + 1} must be text of 1–500 characters`));
      return (policy as string).trim();
    });
  }
  if (config.autoDecide !== undefined) {
    ensure(config.autoDecide === "off" || config.autoDecide === "low-risk", at('"autoDecide" must be "off" or "low-risk"'));
    into.autoDecide = config.autoDecide;
  }
  if (config.autoContinue !== undefined) {
    // A repository must not make your coordinator start assessments on its own.
    ensure(source === "user", at('"autoContinue" is allowed only in your user file'));
    ensure(typeof config.autoContinue === "boolean", at('"autoContinue" must be true or false'));
    into.autoContinue = config.autoContinue;
  }
  for (const [key, value] of Object.entries(record(config.profiles ?? {}, at("profiles")))) {
    ensure(name.test(key), at(`profile name ${JSON.stringify(key)} uses characters other than letters, digits, - and _`));
    const profile = record(value, at(`profile ${key}`));
    ensure(Object.keys(profile).every((field) => ["via", "model", "effort", "timeoutMinutes"].includes(field)), at(`profile ${key} allows only via, model, effort and timeoutMinutes`));
    ensure((agents as readonly unknown[]).includes(profile.via), at(`profile ${key}: via must be one of ${agents.join(", ")}`));
    into.profiles[key] = {
      via: profile.via as Agent,
      ...(profile.model === undefined ? {} : { model: modelName(profile.model) }),
      ...(profile.effort === undefined ? {} : { effort: agentEffort(profile.via as Agent, effortName(profile.effort), at(`profile ${key}: effort`)) }),
      ...(profile.timeoutMinutes === undefined ? {} : { timeoutMinutes: minutes(profile.timeoutMinutes, 120, at(`profile ${key}: timeoutMinutes`)) }),
      source,
    };
  }
  for (const [role, value] of Object.entries(record(config.roles ?? {}, at("roles")))) {
    ensure((roles as string[]).includes(role), at(`role ${JSON.stringify(role)} must be one of ${roles.join(", ")}`));
    const choice = typeof value === "string" ? { profile: value } : record(value, at(`role ${role}`));
    ensure(Object.keys(choice).every((field) => ["profile", "checks", "checkTimeoutMinutes"].includes(field)), at(`role ${role} allows only profile, checks and checkTimeoutMinutes`));
    ensure(typeof choice.profile === "string" && name.test(choice.profile), at(`role ${role} needs a profile name`));
    ensure(choice.checks === undefined || (Array.isArray(choice.checks) && choice.checks.every((check) => typeof check === "string")), at(`role ${role}: checks must be a list of commands`));
    into.roles[role as Mode] = {
      profile: choice.profile,
      ...(choice.checks === undefined ? {} : { checks: choice.checks as string[] }),
      ...(choice.checkTimeoutMinutes === undefined ? {} : { checkTimeoutMinutes: minutes(choice.checkTimeoutMinutes, 30, at(`role ${role}: checkTimeoutMinutes`)) }),
      source,
    };
  }
  into.files.found.push(source);
}

/** The user file first, then the project file, which wins for any profile or role both name. */
export function loadAgentConfig(cwd: string): AgentConfig {
  const config: AgentConfig = { autoContinue: false, policies: [], autoDecide: "off", profiles: {}, roles: {}, files: { user: userConfigPath(), project: projectConfigPath(projectRoot(cwd)), found: [] } };
  readConfig(config.files.user, "user", config);
  readConfig(config.files.project, "project", config);
  for (const [role, choice] of Object.entries(config.roles))
    ensure(config.profiles[choice!.profile], `Role ${role} uses profile ${JSON.stringify(choice!.profile)}, which no agent config defines`);
  return config;
}

export interface ResolvedDispatch {
  options: DispatchOptions;
  mode: Mode;
  profile: string | null;
  /** The commands came from the repository's own file, which someone else may have written. */
  confirmChecks: boolean;
}

function waitingMode(cwd: string, id: string): Mode {
  const waiting = loadSession(projectRoot(cwd), id).rounds.filter((round) => round.status === "WAITING");
  ensure(waiting.length === 1, "Dispatch needs exactly one waiting handoff. Use /waicc-status.");
  return waiting[0].mode;
}

/** Typed flags win over a named profile, which wins over the profile for the handoff's role. */
export function resolveDispatch(cwd: string, id: string, input: string | string[]): ResolvedDispatch {
  const typed = parseDispatchArgs(input);
  const mode = waitingMode(cwd, id);
  const config = loadAgentConfig(cwd);
  // --continue / --no-continue win; otherwise your user file's autoContinue, and a loop always continues.
  const continued = (options: Partial<DispatchOptions>): Partial<DispatchOptions> =>
    options.continue !== undefined || options.loop || options.develop ? { ...options, continue: options.continue ?? true }
      : config.autoContinue ? { ...options, continue: true } : options;
  const needsConfig = typed.profile !== undefined || typed.options.via === undefined;
  if (!needsConfig) return { options: continued(typed.options) as DispatchOptions, mode, profile: null, confirmChecks: false };
  const role = config.roles[mode];
  const profileName = typed.profile ?? role?.profile;
  ensure(
    profileName,
    `No agent chosen for this ${mode} handoff. Add --via claude|codex|pi|agy, name a profile, or set roles.${mode} in ${config.files.user} or ${config.files.project}.${config.files.found.length ? "" : ` ${initHint}.`}`,
  );
  const profile = config.profiles[profileName];
  ensure(profile, `Unknown agent profile ${JSON.stringify(profileName)}. Defined: ${Object.keys(config.profiles).join(", ") || "none"}.`);
  // A role's checks belong to the role, whichever profile runs it; typed --check replaces them.
  const roleChecks = !typed.options.checks && role?.checks?.length ? role : undefined;
  const options: DispatchOptions = {
    via: profile.via,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    ...(profile.timeoutMinutes ? { timeoutMinutes: profile.timeoutMinutes } : {}),
    ...(roleChecks ? { checks: checkCommands(roleChecks.checks!, typed.checkMinutes ?? roleChecks.checkTimeoutMinutes) } : {}),
    ...typed.options,
  };
  return { options: continued(options) as DispatchOptions, mode, profile: profileName, confirmChecks: roleChecks?.source === "project" };
}

/** What each role would use, for /waicc-dispatch --profiles. */
export function profilesView(cwd: string) {
  const config = loadAgentConfig(cwd);
  return {
    autoContinue: config.autoContinue,
    policies: config.policies,
    autoDecide: config.autoDecide,
    files: {
      user: { path: config.files.user, found: config.files.found.includes("user") },
      project: { path: config.files.project, found: config.files.found.includes("project") },
    },
    profiles: config.profiles,
    roles: Object.fromEntries(roles.map((role) => {
      const choice = config.roles[role];
      return [role, choice ? { ...choice, agent: config.profiles[choice.profile] } : "not set: pass --via or a profile name"];
    })),
    nextAction: Object.keys(config.profiles).length
      ? "Run /waicc-dispatch with no agent: the waiting handoff's role picks its profile. Name a profile or add --via to override once; --implement is still required for coding."
      : `No agent profiles yet. ${initHint} at ${config.files.user} (just you), or create ${config.files.project} (shared with the repository); see the README's "Agent profiles".`,
  };
}

/** Your standing policies and low-risk setting, from your user file only. */
export function decisionSettings(cwd: string): Pick<AgentConfig, "policies" | "autoDecide"> {
  const { policies, autoDecide } = loadAgentConfig(cwd);
  return { policies, autoDecide };
}

/** Instructions for the main agent: when, and only when, a policy answers a decision. */
export function policyGuidance(policies: string[]): string {
  if (!policies.length) return "";
  return `The human's standing policies, their own rules given in advance:\n${policies.map((policy, i) => `${i + 1}. ${policy}`).join("\n")}\nWhen an OPEN human-owned decision is clearly and fully answered by one of these, record it with waicc_apply_policy: cite the policy number, give an answer that follows the policy exactly, and explain why it applies. Never stretch a policy beyond what it says, never combine policies to invent an answer, and never use one for an external decision. If a policy only partly fits, ask the human instead.`;
}

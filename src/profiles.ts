import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession } from "./files.ts";
import type { SandboxMode, SandboxSettings } from "./sandbox.ts";
import { agentEffort, agents, checkCommands, effortName, minutes, modelName, parseDispatchArgs, type Agent, type DispatchOptions } from "./dispatch.ts";
import { projectRoot } from "./source.ts";
import { ensure, record } from "./validation.ts";
import { consultLimit } from "./consult.ts";
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
  /** User file only: how many times per Pi chat the main agent may ask the advisor on its own; 0 is off. */
  autoAdvisor: number;
  /** User file only: automatic runs stop once a session's reported cost reaches this many dollars. */
  budget: { perSessionUsd: number | null };
  /** User file only: when a running agent counts as quiet (0 never), and whether to raise desktop notifications. */
  alerts: { quietMinutes: number; desktop: boolean };
  /** User file only: whether checks run in an OS sandbox, and what it lets them reach. */
  sandbox: SandboxSettings;
  /** User file only: GitLab hosts WAICC may post reviews to, each with its token (or the variable holding it). */
  gitlab: Record<string, { token?: string; tokenEnv?: string; allowHttp: boolean }>;
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

/**
 * Adds a GitLab host to your user file, its token read from an environment variable, after you
 * agreed to it. Everything else in the file is kept, a host already there is never replaced, and
 * no token is ever written: you set the variable yourself.
 */
export function addGitlabHost(host: string, options: { tokenEnv?: string; token?: string; allowHttp?: boolean } = {}) {
  const path = userConfigPath();
  const name = host.toLowerCase(), tokenEnv = options.tokenEnv ?? "GITLAB_TOKEN";
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = record(JSON.parse(readFileSync(path, "utf8")), "Your user file");
    } catch (error) {
      throw new Error(`${path} is not valid JSON, so it was left unchanged: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const gitlab = config.gitlab === undefined ? {} : record(config.gitlab, `"gitlab" in ${path}`);
  ensure(!Object.keys(gitlab).some((key) => key.toLowerCase() === name), `${name} is already under "gitlab" in ${path}; it was left unchanged`);
  // A token goes into the file only when you chose that over an environment variable.
  config.gitlab = { ...gitlab, [name]: { ...(options.token ? { token: options.token } : { tokenEnv }), ...(options.allowHttp ? { allowHttp: true } : {}) } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, options.token ? { mode: 0o600 } : undefined);
  if (options.token) try { chmodSync(path, 0o600); } catch { /* Windows keeps the file in your profile */ }
  return { path, host: name, tokenEnv, tokenSet: Boolean(options.token ?? process.env[tokenEnv]?.trim()) };
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
  ensure(Object.keys(config).every((key) => ["profiles", "roles", "autoContinue", "policies", "autoDecide", "autoAdvisor", "budget", "alerts", "sandbox", "gitlab"].includes(key)), at('only "profiles", "roles", "autoContinue", "policies", "autoDecide", "autoAdvisor", "budget", "alerts", "sandbox" and "gitlab" are allowed'));
  // Settings that let WAICC act for you, reach you outside Pi, loosen what checks may touch or hold your tokens are yours alone: a repository must not set them.
  for (const key of ["policies", "autoDecide", "autoAdvisor", "budget", "alerts", "sandbox", "gitlab"])
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
  if (config.budget !== undefined) {
    const budget = record(config.budget, at('"budget"'));
    ensure(Object.keys(budget).every((key) => key === "perSessionUsd"), at('"budget" takes only "perSessionUsd"'));
    const usd = budget.perSessionUsd;
    ensure(usd === undefined || (typeof usd === "number" && usd > 0 && usd <= 10_000), at('"budget.perSessionUsd" must be a dollar amount above 0 and at most 10000'));
    into.budget = { perSessionUsd: (usd as number | undefined) ?? null };
  }
  if (config.alerts !== undefined) {
    const alerts = record(config.alerts, at('"alerts"'));
    ensure(Object.keys(alerts).every((key) => key === "quietMinutes" || key === "desktop"), at('"alerts" takes only "quietMinutes" and "desktop"'));
    const { quietMinutes, desktop } = alerts;
    ensure(quietMinutes === undefined || (Number.isInteger(quietMinutes) && (quietMinutes as number) >= 0 && (quietMinutes as number) <= 240),
      at('"alerts.quietMinutes" must be a whole number of minutes from 0 (never) to 240'));
    ensure(desktop === undefined || typeof desktop === "boolean", at('"alerts.desktop" must be true or false'));
    into.alerts = { quietMinutes: (quietMinutes as number | undefined) ?? into.alerts.quietMinutes, desktop: (desktop as boolean | undefined) ?? into.alerts.desktop };
  }
  if (config.gitlab !== undefined) {
    const hosts = record(config.gitlab, at('"gitlab"'));
    ensure(Object.keys(hosts).length <= 10, at('"gitlab" lists at most 10 hosts'));
    for (const [host, value] of Object.entries(hosts)) {
      ensure(/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host), at(`"gitlab" hosts are names like "gitlab.example.com" or "10.0.0.5:8080", not ${JSON.stringify(host)}`));
      const entry = record(value, at(`"gitlab.${host}"`));
      ensure(Object.keys(entry).every((k) => ["token", "tokenEnv", "allowHttp"].includes(k)), at(`"gitlab.${host}" takes only "token", "tokenEnv" and "allowHttp"`));
      ensure(entry.token === undefined || (typeof entry.token === "string" && entry.token.trim().length >= 8 && entry.token.length <= 200), at(`"gitlab.${host}.token" must be your access token`));
      ensure(entry.tokenEnv === undefined || (typeof entry.tokenEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(entry.tokenEnv)), at(`"gitlab.${host}.tokenEnv" must be an environment variable name`));
      ensure(entry.token !== undefined || entry.tokenEnv !== undefined, at(`"gitlab.${host}" needs "token" or "tokenEnv"`));
      ensure(entry.allowHttp === undefined || typeof entry.allowHttp === "boolean", at(`"gitlab.${host}.allowHttp" must be true or false`));
      into.gitlab[host.toLowerCase()] = { ...(entry.token ? { token: (entry.token as string).trim() } : {}), ...(entry.tokenEnv ? { tokenEnv: entry.tokenEnv as string } : {}), allowHttp: entry.allowHttp === true };
    }
  }
  if (config.sandbox !== undefined) {
    const sandbox = record(config.sandbox, at('"sandbox"'));
    ensure(Object.keys(sandbox).every((key) => ["checks", "network", "allowWrite"].includes(key)), at('"sandbox" takes only "checks", "network" and "allowWrite"'));
    const { checks, network, allowWrite } = sandbox;
    ensure(checks === undefined || ["off", "auto", "required"].includes(checks as string), at('"sandbox.checks" must be "off", "auto" or "required"'));
    ensure(network === undefined || typeof network === "boolean", at('"sandbox.network" must be true or false'));
    ensure(allowWrite === undefined || (Array.isArray(allowWrite) && allowWrite.length <= 20 && allowWrite.every((path) =>
      typeof path === "string" && path.length <= 1000 && (isAbsolute(path) || path === "~" || path.startsWith("~/")))),
    at('"sandbox.allowWrite" must be a list of at most 20 absolute folders (or ~/ folders)'));
    into.sandbox = {
      mode: (checks as SandboxMode | undefined) ?? into.sandbox.mode,
      network: (network as boolean | undefined) ?? into.sandbox.network,
      allowWrite: (allowWrite as string[] | undefined) ?? into.sandbox.allowWrite,
    };
  }
  if (config.autoAdvisor !== undefined) {
    const value = config.autoAdvisor;
    const count = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).maxPerChat : undefined;
    ensure(
      typeof value === "boolean" || (Object.keys(value as object).every((key) => key === "maxPerChat") && Number.isInteger(count) && (count as number) >= 0 && (count as number) <= consultLimit.max),
      at(`"autoAdvisor" must be true, false or { "maxPerChat": 0–${consultLimit.max} }`),
    );
    into.autoAdvisor = typeof value === "boolean" ? (value ? consultLimit.default : 0) : (count as number);
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
  const config: AgentConfig = { autoContinue: false, policies: [], autoDecide: "off", autoAdvisor: consultLimit.default, budget: { perSessionUsd: null }, alerts: { quietMinutes: 10, desktop: false }, sandbox: { mode: "off", network: false, allowWrite: [] }, gitlab: {}, profiles: {}, roles: {}, files: { user: userConfigPath(), project: projectConfigPath(projectRoot(cwd)), found: [] } };
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
    budget: config.budget.perSessionUsd === null ? "none" : { perSessionUsd: config.budget.perSessionUsd },
    alerts: config.alerts,
    sandbox: { checks: config.sandbox.mode, network: config.sandbox.network, allowWrite: config.sandbox.allowWrite },
    // Whether a token is there, never the token.
    gitlab: Object.fromEntries(Object.entries(config.gitlab).map(([host, h]) => [host, {
      token: h.token ? "set in your user file" : h.tokenEnv ? (process.env[h.tokenEnv] ? `from ${h.tokenEnv}` : `missing: ${h.tokenEnv} is not set`) : "missing",
      allowHttp: h.allowHttp,
    }])),
    autoAdvisor: config.autoAdvisor ? { maxPerChat: config.autoAdvisor, profile: config.roles.advisor?.profile ?? "not set: no advisor role" } : "off",
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

/** What the main agent's own advisor questions use: the advisor role's profile, within your per-chat limit. */
export function consultSettings(cwd: string): { limit: number; profile: string | null; options: DispatchOptions | null; hint: string } {
  const config = loadAgentConfig(cwd);
  const role = config.roles.advisor;
  const profile = role ? config.profiles[role.profile] : undefined;
  return {
    limit: config.autoAdvisor,
    profile: role?.profile ?? null,
    options: profile
      ? { via: profile.via, ...(profile.model ? { model: profile.model } : {}), ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.timeoutMinutes ? { timeoutMinutes: profile.timeoutMinutes } : {}) }
      : null,
    hint: config.autoAdvisor === 0
      ? `Asking the advisor on your own is off ("autoAdvisor" in ${config.files.user}).`
      : `No advisor role is set. Set roles.advisor in ${config.files.user}.${config.files.found.length ? "" : ` ${initHint}.`}`,
  };
}

/** Your per-session dollar budget for automatic runs, or null for none. */
export function sessionBudget(cwd: string): number | null {
  return loadAgentConfig(cwd).budget.perSessionUsd;
}

/** How checks are sandboxed. A broken config throws: a check must not silently lose a required sandbox. */
/** A GitLab host's token and http permission, from your user file only; null when the host is not listed. */
export function gitlabHost(cwd: string, host: string): { token: string | null; allowHttp: boolean } | null {
  const entry = loadAgentConfig(cwd).gitlab[host.toLowerCase()];
  if (!entry) return null;
  return { token: entry.token ?? (entry.tokenEnv ? process.env[entry.tokenEnv]?.trim() || null : null), allowHttp: entry.allowHttp };
}
export function sandboxSettings(cwd: string): SandboxSettings {
  return loadAgentConfig(cwd).sandbox;
}

/** When a running agent counts as quiet, and whether to notify on the desktop; defaults if the config is broken. */
export function alertSettings(cwd: string): { quietMs: number; desktop: boolean } {
  try {
    const { alerts } = loadAgentConfig(cwd);
    return { quietMs: alerts.quietMinutes * 60_000, desktop: alerts.desktop };
  } catch {
    return { quietMs: 10 * 60_000, desktop: false };
  }
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  ensure(Object.keys(config).every((key) => ["profiles", "roles"].includes(key)), at('only "profiles" and "roles" are allowed'));
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
  const config: AgentConfig = { profiles: {}, roles: {}, files: { user: userConfigPath(), project: projectConfigPath(projectRoot(cwd)), found: [] } };
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
  const needsConfig = typed.profile !== undefined || typed.options.via === undefined;
  if (!needsConfig) return { options: typed.options as DispatchOptions, mode, profile: null, confirmChecks: false };
  const config = loadAgentConfig(cwd);
  const role = config.roles[mode];
  const profileName = typed.profile ?? role?.profile;
  ensure(
    profileName,
    `No agent chosen for this ${mode} handoff. Add --via claude|codex|pi|agy, name a profile, or set roles.${mode} in ${config.files.user} or ${config.files.project}.`,
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
  return { options, mode, profile: profileName, confirmChecks: roleChecks?.source === "project" };
}

/** What each role would use, for /waicc-dispatch --profiles. */
export function profilesView(cwd: string) {
  const config = loadAgentConfig(cwd);
  return {
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
      : `No agent profiles yet. Create ${config.files.user} (just you) or ${config.files.project} (shared with the repository); see the README's "Agent profiles".`,
  };
}

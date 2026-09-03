import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

export const AUTH_METHODS = ["apiToken", "accessToken", "oauth"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * The scopes a write tool needs.
 *
 * Checked rather than requested: Bitbucket Cloud ignores a `scope` parameter on a
 * grant, so scopes are fixed when the OAuth consumer is created. A consumer without
 * `pullrequest:write` will answer 403 on every merge, and saying so up front is much
 * cheaper than letting the model find out one tool call at a time.
 */
export const WRITE_SCOPES = ["pullrequest:write", "pipeline:write"] as const;

const ConfigSchema = z
  .object({
    baseUrl: z.url().default("https://api.bitbucket.org/2.0"),
    /** Undefined when nothing is configured — never an error. See loadConfig. */
    authMethod: z.enum(AUTH_METHODS).optional(),
    apiToken: z.string().min(1).optional(),
    /**
     * The Atlassian account email.
     *
     * Its presence is what selects the transport: Basic with it, Bearer without. Worth
     * setting even though Bearer works, because Bitbucket answers a scope problem with
     * a specific message over Basic and a generic one over Bearer.
     */
    email: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    oauthClientId: z.string().min(1).optional(),
    oauthClientSecret: z.string().min(1).optional(),
    /** Default workspace, so most tools do not need it passed per call. */
    workspace: z.string().min(1).optional(),
    /** Default repository slug, for a server pointed at one repo. */
    repository: z.string().min(1).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    /**
     * Where `bb`'s own credential store lives.
     *
     * A path rather than a flag so the test suite can point it at somewhere that
     * cannot exist. Without that the suite would read the developer's real login and
     * pass on their machine while failing in CI, or the reverse.
     */
    hostsFile: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Deliberately NOT an error when no credentials are set. An MCP server that exits
    // on startup shows up in the client as a bare "Connection closed" with stderr
    // swallowed, so the one message that would have explained what to configure never
    // reaches anyone. `bitbucket_auth_status` carries that message instead.
    //
    // Only genuinely incoherent combinations are errors: a flag that demands something
    // it does not have, or one that is a silent no-op without another.
    if (cfg.oauthClientId !== undefined && cfg.oauthClientSecret === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["oauthClientSecret"],
        message:
          "BITBUCKET_OAUTH_CLIENT_ID needs BITBUCKET_OAUTH_CLIENT_SECRET too. Bitbucket Cloud " +
          "does not support PKCE, so the browser flow is a confidential-client grant and the " +
          "secret is required — both to log in and to refresh afterwards.",
      });
    }
    if (cfg.oauthClientSecret !== undefined && cfg.oauthClientId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["oauthClientId"],
        message: "BITBUCKET_OAUTH_CLIENT_SECRET has no effect without BITBUCKET_OAUTH_CLIENT_ID.",
      });
    }
    if (cfg.repository !== undefined && cfg.workspace === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message:
          "BITBUCKET_REPOSITORY needs BITBUCKET_WORKSPACE — a repository slug is only unique " +
          "within a workspace, and there is no way to look one up across all of them: " +
          "Atlassian removed the cross-workspace listing (it now returns HTTP 410).",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document.
 *
 * Keys are camelCase to mirror `Config` rather than the env var names: this is a typed
 * JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `apiTokan` must be an error. Silently ignoring an
 * unknown key looks exactly like "that setting had no effect", which is the worst
 * possible way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    baseUrl: z.string().min(1).optional(),
    authMethod: z.enum(AUTH_METHODS).optional(),
    apiToken: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    oauthClientId: z.string().min(1).optional(),
    oauthClientSecret: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    maxRetries: z.number().int().optional(),
    hostsFile: z.string().min(1).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/** Most specific first: an explicit override, then XDG, then the conventional `~/.config`. */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.BITBUCKET_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "bitbucket-mcp", "config.json");
};

/**
 * Where the `bb` CLI keeps its credentials.
 *
 * Read so that anyone already logged in with `bb auth login` needs no second setup —
 * including the OAuth refresh token, which is the whole point of sharing the file
 * rather than copying a token out of it.
 */
export const resolveHostsPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.BITBUCKET_HOSTS_FILE);
  if (explicit) return expandTilde(explicit);
  const bbDir = trimmed(env.BB_CONFIG_DIR);
  if (bbDir) return join(expandTilde(bbDir), "hosts.yml");
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "bb", "hosts.yml");
};

/**
 * These files hold a token, so being readable by other users is worth saying out loud.
 * A warning and not an error: refusing to start would be a worse trade for someone on
 * a single-user machine.
 */
export const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(
        `[bitbucket-mcp] ${path} is readable by other users. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // A missing file is fine; the read below reports anything that matters.
  }
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other failure
 * throws and names the path, so a malformed file is never mistaken for a missing one —
 * that confusion sends you hunting for credentials that were sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Pick the auth method from whichever credentials are present.
 *
 * An explicit `BITBUCKET_AUTH_METHOD` always wins. Otherwise the order is deliberate:
 * an access token is the narrowest credential and the most likely to be set on purpose,
 * OAuth is next because it is a real login, and an API token last because it is the
 * easiest to leave lying around in a shell profile.
 *
 * A bare token string cannot be told apart by inspection — an Atlassian API token and a
 * repository access token look alike but need different headers and have different
 * capabilities. So the type is *declared, never sniffed*: which variable the token
 * arrives in is the declaration.
 */
export const inferAuthMethod = (cfg: {
  authMethod?: AuthMethod | undefined;
  accessToken?: string | undefined;
  oauthClientId?: string | undefined;
  apiToken?: string | undefined;
}): AuthMethod | undefined => {
  if (cfg.authMethod !== undefined) return cfg.authMethod;
  if (cfg.accessToken !== undefined) return "accessToken";
  if (cfg.oauthClientId !== undefined) return "oauth";
  if (cfg.apiToken !== undefined) return "apiToken";
  return undefined;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 *
 * Docker and CI inject the environment and must keep working untouched, while a one-off
 * `BITBUCKET_ALLOW_WRITES=0` still has to override a file that says `true`. Merging
 * field by field is the only rule that gives both.
 *
 * Never throws for "nothing is configured". An MCP server that exits at startup shows
 * up in the client as a bare `MCP error -32000: Connection closed`, with stderr
 * swallowed, so the one message that would have explained what to set never reaches
 * anyone. The server stays up and reports the gap as data instead.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
  hostsPath: string = resolveHostsPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const merged = {
    baseUrl: trimmed(env.BITBUCKET_API_URL) ?? file.baseUrl,
    apiToken: trimmed(env.BITBUCKET_API_TOKEN) ?? trimmed(env.BITBUCKET_TOKEN) ?? file.apiToken,
    email: trimmed(env.BITBUCKET_EMAIL) ?? file.email,
    accessToken: trimmed(env.BITBUCKET_ACCESS_TOKEN) ?? file.accessToken,
    oauthClientId: trimmed(env.BITBUCKET_OAUTH_CLIENT_ID) ?? file.oauthClientId,
    oauthClientSecret: trimmed(env.BITBUCKET_OAUTH_CLIENT_SECRET) ?? file.oauthClientSecret,
    workspace: trimmed(env.BITBUCKET_WORKSPACE) ?? file.workspace,
    repository: trimmed(env.BITBUCKET_REPOSITORY) ?? file.repository,
    allowWrites: parseBool(env.BITBUCKET_ALLOW_WRITES) ?? file.allowWrites,
    maxRetries: parseIntOpt(env.BITBUCKET_MAX_RETRIES) ?? file.maxRetries,
    hostsFile: expandTilde(trimmed(env.BITBUCKET_HOSTS_FILE) ?? file.hostsFile ?? hostsPath),
  };
  const declared =
    (trimmed(env.BITBUCKET_AUTH_METHOD) as AuthMethod | undefined) ?? file.authMethod;
  return ConfigSchema.parse({
    ...merged,
    authMethod: inferAuthMethod({ ...merged, authMethod: declared }),
  });
};

/**
 * True once the server has a complete credential for its method.
 *
 * OAuth counts as configured with only the consumer pair: the login itself may not have
 * happened yet, and `bitbucket_auth_login` is how it does. Reporting "not configured"
 * there would hide the very tool that fixes it.
 */
export const isConfigured = (config: Config): boolean => {
  switch (config.authMethod) {
    case "apiToken":
      return Boolean(config.apiToken);
    case "accessToken":
      return Boolean(config.accessToken);
    case "oauth":
      return Boolean(config.oauthClientId && config.oauthClientSecret);
    default:
      return false;
  }
};

const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Returned by `bitbucket_auth_status` and printed to stderr at startup.
 *
 * Prose rather than a code, because this is the text someone acts on when nothing
 * works — and it is the only channel left once the server has given up its ability to
 * signal a problem by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => {
  if (isConfigured(config)) return [];
  return [
    "No Bitbucket credentials found. Pick one method:",
    `(A) Atlassian API token, simplest — create one at ${TOKEN_PAGE} using "Create API token ` +
      'with scopes" and pick Bitbucket as the app. A plain unscoped token authenticates but ' +
      'every Bitbucket call then fails with "API Token provided has no Bitbucket scopes". ' +
      "Set BITBUCKET_API_TOKEN, and BITBUCKET_EMAIL alongside it — Bitbucket reports a scope " +
      "problem clearly over Basic auth and vaguely over Bearer.",
    "(B) OAuth browser login — create a consumer under Workspace settings → Apps and " +
      "features → OAuth consumers, set its callback URL to http://localhost:8724/callback, " +
      "then set BITBUCKET_OAUTH_CLIENT_ID and BITBUCKET_OAUTH_CLIENT_SECRET and call " +
      "bitbucket_auth_login. Note the scopes you tick are fixed: Bitbucket ignores a scope " +
      "request at login time, so a consumer without pullrequest:write can never merge.",
    "(C) A repository, project or workspace access token in BITBUCKET_ACCESS_TOKEN. These have " +
      "no Atlassian account, so anything needing an identity is unavailable.",
    "Already signed in with the `bb` CLI? This server reads ~/.config/bb/hosts.yml, so there " +
      "is nothing more to set.",
    "App passwords were removed by Atlassian on 2026-07-28 and are not an option.",
  ];
};

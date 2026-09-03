import { dirname } from "node:path";

import {
  createAccessTokenAuth,
  createAnonymousAuth,
  createApiTokenAuth,
  createOAuthAuth,
  readCredential,
  writeCredential,
  type AuthStrategy,
  type OAuthTokenStore,
  type StoredCredential,
} from "@mgcrea/bitbucket-cli";

import type { Config } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/**
 * A credential store rooted at one explicit file.
 *
 * The library's own `hostsTokenStore` reads `BB_CONFIG_DIR` from the real environment.
 * That is right for the CLI and wrong here: nothing below `config.ts` may touch
 * `process.env`, and the test suite has to be able to point this at a path that cannot
 * exist. Passing a synthetic env is how one file path becomes the whole configuration.
 */
export const fileTokenStore = (hostsFile: string): OAuthTokenStore => {
  const env: NodeJS.ProcessEnv = { BB_CONFIG_DIR: dirname(hostsFile) };
  return {
    read: () => readCredential(undefined, env),
    write: (credential) => writeCredential(credential, undefined, env),
  };
};

/** Read whatever `bb auth login` left behind, without caring whether it is there. */
export const readStoredCredential = async (
  hostsFile: string,
): Promise<StoredCredential | undefined> => {
  try {
    return await readCredential(undefined, { BB_CONFIG_DIR: dirname(hostsFile) });
  } catch {
    // A missing or unreadable store is "not logged in", not a failure worth surfacing.
    return undefined;
  }
};

export type AuthContext = {
  config: Config;
  logger?: Logger | undefined;
  fetch?: typeof fetch | undefined;
};

/**
 * Build the strategy the configured method calls for.
 *
 * Total by construction: an unconfigured server still gets a strategy, so
 * `createServer` never throws and the credential-free tools stay reachable. The
 * anonymous strategy sends no auth header at all, which is the honest thing to do —
 * Bitbucket answers public repositories fine and everything else with a 401 that says
 * so.
 */
export const createAuth = (ctx: AuthContext): AuthStrategy => {
  const { config } = ctx;
  switch (config.authMethod) {
    case "apiToken":
      return createApiTokenAuth({
        token: config.apiToken ?? "",
        email: config.email,
        // Basic where an email is available, Bearer otherwise. Not merely a preference:
        // Bitbucket reports a missing-scope problem specifically over Basic and
        // generically over Bearer, which is the difference between a diagnosable
        // failure and a puzzling one.
        transport: config.email === undefined ? "bearer" : "basic",
        source: "BITBUCKET_API_TOKEN",
      });

    case "accessToken":
      return createAccessTokenAuth({
        token: config.accessToken ?? "",
        source: "BITBUCKET_ACCESS_TOKEN",
      });

    case "oauth":
      return createOAuthAuth({
        clientId: config.oauthClientId ?? "",
        clientSecret: config.oauthClientSecret ?? "",
        store: fileTokenStore(config.hostsFile ?? ""),
        ...(ctx.fetch === undefined ? {} : { fetchImpl: ctx.fetch }),
        source: "BITBUCKET_OAUTH_CLIENT_ID",
      });

    default:
      return createAnonymousAuth();
  }
};

import { createBitbucketClient, type BitbucketClient } from "@mgcrea/bitbucket-cli";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { createAuth, type Logger } from "#/client/auth";
import { createRateLimitRecorder, type RateLimitRecorder } from "#/client/rate-limit";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
/** Bitbucket does not reject a generic agent, but it is the only handle on a request. */
export const USER_AGENT = `mcp-bitbucket-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the credential (tests), so no login has to be staged. */
  auth?: ReturnType<typeof createAuth>;
};

export type CreatedServer = {
  server: McpServer;
  client: BitbucketClient;
  rateLimits: RateLimitRecorder;
};

/**
 * Build the server. A pure factory: three injectable seams — `fetch`, `logger`, `auth`
 * — and they exist for exactly one reason, which is that the test harness drives real
 * tools through the real SDK with no network and no credentials.
 *
 * Nothing below `config.ts` reads `process.env`, which is why `auth` and `baseUrl` are
 * always passed explicitly: `createBitbucketClient` would otherwise consult
 * `BB_API_BASE_URL` and call `resolveAuthFromEnv()` on its own.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const auth =
    opts.auth ??
    createAuth({
      config,
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });

  const rateLimits = createRateLimitRecorder();

  const client = createBitbucketClient({
    auth,
    baseUrl: config.baseUrl,
    userAgent: USER_AGENT,
    retry: { maxAttempts: config.maxRetries + 1 },
    // Bitbucket reports the budget on ordinary responses, not only on a 429, so the
    // snapshot is worth keeping even when nothing has gone wrong yet.
    onRateLimit: (snapshot) => rateLimits.record(snapshot),
    onRequest: () => rateLimits.countRequest(),
    ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
    ...(opts.logger?.debug
      ? { onRetry: (event) => opts.logger?.warn?.(`retrying ${event.method} ${event.url}`) }
      : {}),
  });

  registerTools(server, client, { config, allowWrites: config.allowWrites, rateLimits });
  return { server, client, rateLimits };
};

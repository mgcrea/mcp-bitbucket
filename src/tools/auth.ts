import {
  authorizeUrl,
  createOAuthAuth,
  createState,
  DEFAULT_REDIRECT_URI,
  exchangeCode,
  toStored,
  waitForCallbackCode,
} from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fileTokenStore, readStoredCredential } from "#/client/auth";
import { isConfigured, setupInstructions, WRITE_SCOPES } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Which curated tools work with no credentials at all.
 *
 * Named explicitly rather than computed, because the point of the list is to tell a
 * first-time caller what they *can* do, and a computed one would silently start
 * claiming tools that need a login.
 */
const CREDENTIAL_FREE = ["bitbucket_auth_status", "bitbucket_auth_login"];

/**
 * Registered first and unconditionally, before any credential check, so an unconfigured
 * server answers "here is what to set" instead of closing the connection with its own
 * explanation swallowed.
 */
export const registerAuthTools = (server: McpServer, ctx: ToolContext): void => {
  const { config } = ctx;

  server.registerTool(
    "bitbucket_auth_status",
    {
      title: "Bitbucket: Auth Status",
      description:
        "Report whether this server has working Bitbucket credentials, which method and " +
        "workspace it defaults to, whether writes are enabled, which OAuth scopes were " +
        "granted, and — when something is missing — exactly what to set. Call this first " +
        "when a tool you expected is not listed: an absent tool means missing configuration " +
        "or a disabled capability rather than a bug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const stored = await readStoredCredential(config.hostsFile ?? "");
        const scopes = stored?.scopes;
        const missingWriteScopes =
          scopes === undefined ? [] : WRITE_SCOPES.filter((scope) => !scopes.includes(scope));

        return {
          configured: isConfigured(config),
          auth_method: config.authMethod ?? null,
          // Presence, never the value. `email` is echoed because it is a public
          // identifier and getting it wrong is a common cause of a puzzling 401.
          credential: config.apiToken
            ? "api token set"
            : config.accessToken
              ? "access token set"
              : config.oauthClientId
                ? "oauth consumer set"
                : null,
          email: config.email ?? null,
          default_workspace: config.workspace ?? null,
          default_repository: config.repository ?? null,
          writes: config.allowWrites ? "ENABLED" : "disabled",
          ...(stored === undefined
            ? {}
            : {
                stored_login: {
                  kind: stored.kind,
                  from: config.hostsFile,
                  ...(stored.username === undefined ? {} : { username: stored.username }),
                  ...(stored.expiresAt === undefined ? {} : { expires_at: stored.expiresAt }),
                  ...(scopes === undefined ? {} : { granted_scopes: scopes }),
                },
              }),
          // Bitbucket fixes scopes on the consumer and ignores a scope request at login
          // time, so a write tool cannot ask for the permission it needs. Saying this
          // here is much cheaper than a 403 per tool call.
          ...(config.allowWrites && missingWriteScopes.length > 0
            ? {
                warning:
                  `Writes are enabled but this login lacks ${missingWriteScopes.join(" and ")}. ` +
                  "Bitbucket sets scopes on the OAuth consumer and ignores a scope request at " +
                  "login, so add the permission to the consumer and run bitbucket_auth_login " +
                  "again — re-authorising the existing consumer will not widen it.",
              }
            : {}),
          available_without_credentials: isConfigured(config) ? undefined : CREDENTIAL_FREE,
          setup: setupInstructions(config),
        };
      }),
  );

  server.registerTool(
    "bitbucket_auth_login",
    {
      title: "Bitbucket: Auth Login",
      description:
        "Sign in to Bitbucket in a browser, and store the result so it survives a restart. " +
        "Needs BITBUCKET_OAUTH_CLIENT_ID and BITBUCKET_OAUTH_CLIENT_SECRET — Bitbucket Cloud " +
        "does not support PKCE, so a consumer secret is required both to log in and to " +
        "refresh afterwards. The OAuth consumer's callback URL must be set to " +
        `${DEFAULT_REDIRECT_URI} (Bitbucket matches it by prefix, so the port cannot vary). ` +
        "Returns the authorize URL either way, so a machine that cannot open a browser can " +
        "still be used by visiting it elsewhere. Prefer an API token if you only need to read.",
      inputSchema: z.object({
        open: z
          .boolean()
          .default(true)
          .describe(
            "Open the URL in a browser. Set false to get the URL back without launching one, " +
              "which is also how this is exercised in a test.",
          ),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(600)
          .default(120)
          .describe(
            "How long to wait for the browser to come back before giving the port up. " +
              "Bounded so an abandoned login cannot hold the fixed callback port forever.",
          ),
      }),
      // Not read-only — it writes a credential file — but deliberately NOT gated behind
      // allowWrites: it changes nothing in Bitbucket, and gating the only way to
      // authenticate would make a write-enabled server impossible to set up.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ open, timeout_seconds }) =>
      wrap(async () => {
        const clientId = config.oauthClientId;
        const clientSecret = config.oauthClientSecret;
        if (clientId === undefined || clientSecret === undefined) {
          return {
            ok: false,
            error: "No OAuth consumer configured.",
            setup: setupInstructions(config),
          };
        }

        const state = createState();
        const url = authorizeUrl({ clientId, state, redirectUri: DEFAULT_REDIRECT_URI });

        if (!open) {
          return {
            ok: false,
            authorize_url: url,
            note:
              "Not opened, as requested. Visiting this URL will not complete the login either " +
              "— the callback listener is only running while this tool waits. Call again with " +
              "open: true from a machine that has a browser.",
          };
        }

        // The listener starts before the browser opens, so a fast redirect cannot arrive
        // at a port that is not bound yet.
        const code = await waitForCallbackCode({
          state,
          redirectUri: DEFAULT_REDIRECT_URI,
          timeoutMs: timeout_seconds * 1000,
          onListening: () => {
            void import("node:child_process").then(({ exec }) => {
              const opener =
                process.platform === "darwin"
                  ? "open"
                  : process.platform === "win32"
                    ? "start"
                    : "xdg-open";
              exec(`${opener} "${url}"`);
            });
          },
        });

        const tokens = await exchangeCode({
          clientId,
          clientSecret,
          code,
          redirectUri: DEFAULT_REDIRECT_URI,
        });
        const store = fileTokenStore(config.hostsFile ?? "");
        await store.write(toStored(undefined, tokens, { clientId, clientSecret }));

        // Identity comes from the strategy that will be used from now on, which proves
        // the stored credential actually works rather than just that the exchange did.
        const auth = createOAuthAuth({ clientId, clientSecret, store });
        const headers = await auth.authorize({ method: "GET", url: config.baseUrl });

        const missing = WRITE_SCOPES.filter((scope) => !tokens.scopes.includes(scope));
        return {
          ok: true,
          authenticated: headers.authorization !== undefined,
          granted_scopes: tokens.scopes,
          expires_at: new Date(tokens.expiresAt).toISOString(),
          stored_at: config.hostsFile,
          note:
            "Scopes are fixed on the OAuth consumer; Bitbucket ignores a scope request at " +
            "login time. To change them, edit the consumer and log in again.",
          ...(config.allowWrites && missing.length > 0
            ? { warning: `Writes are enabled but this consumer lacks ${missing.join(" and ")}.` }
            : {}),
        };
      }),
  );

  // Only offered once there is something to log out of. With no stored login it would
  // be a tool that can only ever say "nothing to do".
  if (config.authMethod !== "oauth") return;

  server.registerTool(
    "bitbucket_auth_logout",
    {
      title: "Bitbucket: Auth Logout",
      description:
        "Forget the stored Bitbucket login. Only removes this machine's copy of the token — " +
        "it does not revoke the OAuth grant, which is done from Bitbucket's own settings. " +
        "Note this clears the shared credential file, so the `bb` CLI is signed out too.",
      inputSchema: z.object({ confirm: confirmLogout }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        const store = fileTokenStore(config.hostsFile ?? "");
        const existing = await store.read();
        if (existing === undefined) return { ok: true, note: "No stored login to remove." };
        // Overwritten with an unusable placeholder rather than deleted, so a shared
        // hosts.yml holding other hosts' credentials is not clobbered.
        await store.write({ kind: "oauth", token: "" });
        return { ok: true, removed_from: config.hostsFile };
      }),
  );
};

const confirmLogout = z
  .literal(true)
  .describe("Must be true. Acknowledges that this signs out the `bb` CLI as well.");

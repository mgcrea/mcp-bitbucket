import type { BitbucketClient } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import { stripNoise, unwrapPage } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Keep the escape hatch pointed at Bitbucket.
 *
 * At another host it would leak the credential, and `..` segments could climb out of
 * the API root. The path is not merely validated but *required* to be relative, so the
 * server always decides the host.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("`path` must be a path, not an absolute URL — the server sets the host.");
  }
  if (path.startsWith("//")) {
    throw new Error("`path` may not start with `//` — that is a protocol-relative URL.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` may not contain `..` segments.");
  }
};

export const registerRequestTool = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { allowWrites, rateLimits } = ctx;
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "bitbucket_request",
    {
      title: "Bitbucket: Request",
      description:
        "Escape hatch: call any Bitbucket Cloud `2.0` endpoint directly, for the many " +
        "endpoints this server does not wrap — webhooks, deploy keys, branch restrictions, " +
        "default reviewers, downloads, snippets, deployments and environments. `path` is " +
        "relative to https://api.bitbucket.org/2.0, e.g. `/repositories/acme/api/hooks`. " +
        "The reference is at https://developer.atlassian.com/cloud/bitbucket/rest/. " +
        "Three things to know: the response is returned only lightly shaped, so keep " +
        "`pagelen` small; the issue-tracker endpoints are GONE and answer HTTP 410 with no " +
        "replacement; and a single commit is `/commit/{sha}` while the list is " +
        "`/commits` — the singular/plural split is real and the wrong one 404s. " +
        (allowWrites
          ? "Writes are ENABLED, so POST/PUT/DELETE are permitted — there is no confirmation " +
            "step here, so check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set BITBUCKET_ALLOW_WRITES=1 to " +
            "allow mutations."),
      inputSchema: z.object({
        method: z.enum(methods).default("GET").describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe(
            'Path below the `2.0` API root, starting with "/", e.g. ' +
              '"/repositories/acme/api/hooks". Must be relative — the server sets the host.',
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Query parameters. `pagelen` is clamped by Bitbucket to 10-100 and a value " +
              "outside that is rejected outright rather than clamped.",
          ),
        body: z.unknown().optional().describe("JSON request body, for POST/PUT/DELETE."),
        unwrap: z
          .boolean()
          .default(true)
          .describe(
            "Collapse a paginated response to `{values, total, has_more}` and drop the " +
              "self-referential `links` blocks. Set false to see the untouched payload, " +
              "which is roughly three times the size.",
          ),
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body, unwrap }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`bitbucket_request with method ${method}`);
        }
        assertSafePath(path);
        const response = await client.request({
          method,
          path: path.startsWith("/") ? path : `/${path}`,
          ...(query === undefined ? {} : { query }),
          ...(body === undefined ? {} : { body }),
        });
        if (!unwrap) return response;
        // A `values` array means this was a collection; anything else is a single object.
        return response !== null &&
          typeof response === "object" &&
          Array.isArray((response as { values?: unknown }).values)
          ? unwrapPage(response)
          : stripNoise(response);
      }),
  );

  server.registerTool(
    "bitbucket_rate_limit_status",
    {
      title: "Bitbucket: Rate Limit Status",
      description:
        "Report what Bitbucket has said about the remaining request budget for this " +
        "credential. Bitbucket sends these headers on ordinary responses and not only on a " +
        "429, so check here BEFORE a large paginated read rather than after being throttled. " +
        "The quota is per credential per hour, not per endpoint. Atlassian documents that " +
        "the headers are not returned on every response, so an empty report is normal.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => rateLimits.report()),
  );
};

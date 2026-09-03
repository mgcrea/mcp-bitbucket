import type { BitbucketClient } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";

import type { RateLimitRecorder } from "#/client/rate-limit";
import { isConfigured, type Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerCommitTools, registerRefTools } from "#/tools/commits";
import { registerPipelineTools } from "#/tools/pipelines";
import { registerPullRequestTools } from "#/tools/pull-requests";
import { registerRepoTools, registerWorkspaceTools } from "#/tools/repositories";
import { registerRequestTool } from "#/tools/request";
import { registerSourceTools } from "#/tools/source";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see BITBUCKET_ALLOW_WRITES. */
  allowWrites: boolean;
  rateLimits: RateLimitRecorder;
};

/**
 * All capability decisions live here, so "why can I not call X" is answered by reading
 * one file.
 *
 * Two gates, and neither of them is a refusal:
 *
 *  1. **Credentials.** The auth tools are registered first and unconditionally, so an
 *     unconfigured server is still a useful one — it can say what to set — rather than
 *     a connection that closes with its own error message swallowed. That failure mode
 *     surfaces in the client as a bare "Connection closed" and is the single most
 *     expensive mistake available in an MCP server.
 *  2. **Writes.** Mutating tools are registered inside their domain modules after an
 *     `if (!allowWrites) return;`, so with the flag off they are not merely refused —
 *     they are absent from `tools/list` and cannot be called at all. A refusal still
 *     lets a model try, retry and reason about a way around it; a tool that does not
 *     exist ends the conversation.
 *
 * There is deliberately no third gate on OAuth scopes. Bitbucket fixes those on the
 * consumer and this server cannot widen them, so registering by scope would hide tools
 * that a re-configured consumer would make work — `bitbucket_auth_status` reports the
 * gap as a warning instead.
 */
export const registerTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  registerAuthTools(server, ctx);
  if (!isConfigured(ctx.config)) return;

  registerWorkspaceTools(server, client, ctx);
  registerRepoTools(server, client, ctx);
  registerPullRequestTools(server, client, ctx);
  registerCommitTools(server, client, ctx);
  registerRefTools(server, client, ctx);
  registerSourceTools(server, client, ctx);
  registerPipelineTools(server, client, ctx);
  registerRequestTool(server, client, ctx);
};

import type { BitbucketClient } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { collected } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  confirmArg,
  limitArg,
  okText,
  repositoryArg,
  resolveRepo,
  take,
  workspaceArg,
  wrap,
  wrapResult,
} from "#/tools/util";

/**
 * The flattened statuses the client library reports.
 *
 * Bitbucket's own representation is a nested union — a finished run is
 * `{name: "COMPLETED", result: {name: "SUCCESSFUL" | "FAILED" | …}}` — so `state.name`
 * alone cannot tell success from failure. The library flattens that; these are the
 * flattened names.
 */
const STATUSES = [
  "pending",
  "in-progress",
  "successful",
  "failed",
  "error",
  "stopped",
  "unknown",
] as const;

const selectorArg = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe(
    "A build number, e.g. 1234, or a pipeline UUID in braces. The build number is what the " +
      "Bitbucket UI shows and is much easier to use.",
  );

export const registerPipelineTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { config, allowWrites } = ctx;

  server.registerTool(
    "bitbucket_list_pipelines",
    {
      title: "Bitbucket: List Pipelines",
      description:
        "List pipeline runs, newest first. Bitbucket's own default is OLDEST first, which " +
        "surfaces a years-old run — this tool overrides that, so the first result is the " +
        "most recent. `status` is filtered client-side because Bitbucket's status is a " +
        "nested union that its query language cannot address, so a narrow status filter may " +
        "need a larger `limit` to find matches.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        ref: z.string().optional().describe("Only runs against this branch or tag, e.g. `main`."),
        status: z
          .array(z.enum(STATUSES))
          .optional()
          .describe(
            "Only runs with one of these outcomes. Lower-case, and flattened from Bitbucket's " +
              "nested state — a finished run's top-level state is COMPLETED, so `successful` and " +
              "`failed` are the useful distinction. Filtered after fetching, so combine with " +
              "a generous `limit` when looking for something rare like ERROR.",
          ),
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, ref, status, ...args }) =>
      wrap(async () => {
        const items = await take(
          client.pipelines.list({
            ...resolveRepo(config, args),
            ...(ref === undefined ? {} : { ref }),
            ...(status === undefined ? {} : { status }),
          }),
          limit,
        );
        return collected(items, limit);
      }),
  );

  server.registerTool(
    "bitbucket_get_pipeline",
    {
      title: "Bitbucket: Get Pipeline",
      description:
        "Get one pipeline run: its status, trigger, target ref, duration and creator. Takes " +
        "the build number from `bitbucket_list_pipelines`. Use `bitbucket_list_pipeline_steps` " +
        "to see which step failed, and `bitbucket_get_pipeline_log` for its output.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        selector: selectorArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ selector, ...args }) =>
      wrap(async () => client.pipelines.get(resolveRepo(config, args), selector)),
  );

  server.registerTool(
    "bitbucket_list_pipeline_steps",
    {
      title: "Bitbucket: List Pipeline Steps",
      description:
        "List a pipeline run's steps with their individual outcomes — this is how to find " +
        "which step failed. Returns each step's UUID, which `bitbucket_get_pipeline_log` " +
        "takes. A single-step pipeline has no name in Bitbucket's response at all, so an " +
        "unnamed step is expected rather than a fault.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        pipeline_uuid: z
          .string()
          .min(1)
          .describe(
            "The pipeline's UUID in braces, from `bitbucket_get_pipeline`. A build number is " +
              "not accepted here — resolve it first.",
          ),
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ pipeline_uuid, limit, ...args }) =>
      wrap(async () => {
        const items = await take(
          client.pipelines.steps(resolveRepo(config, args), pipeline_uuid),
          limit,
        );
        return collected(items, limit);
      }),
  );

  server.registerTool(
    "bitbucket_get_pipeline_log",
    {
      title: "Bitbucket: Get Pipeline Log",
      description:
        "Get one pipeline step's log as raw text — what you want in order to diagnose a " +
        "failure. Can be very large on a verbose build. Note that logs EXPIRE well before " +
        "the run record does, so a 404 here usually means the log has aged out rather than " +
        "that the step never existed.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        pipeline_uuid: z
          .string()
          .min(1)
          .describe("The pipeline's UUID in braces, from `bitbucket_get_pipeline`."),
        step_uuid: z
          .string()
          .min(1)
          .describe("The step's UUID in braces, from `bitbucket_list_pipeline_steps`."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ pipeline_uuid, step_uuid, ...args }) =>
      wrapResult(async () =>
        // Raw, not stringified: a build log through JSON.stringify is one unreadable
        // escaped line that costs more than the log itself.
        okText(await client.pipelines.log(resolveRepo(config, args), pipeline_uuid, step_uuid)),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "bitbucket_run_pipeline",
    {
      title: "Bitbucket: Run Pipeline",
      description:
        "Trigger a pipeline run. This executes whatever `bitbucket-pipelines.yml` defines, " +
        "which may deploy — check what the target pipeline does before calling it. Returns " +
        "immediately with the run's identity rather than waiting; poll " +
        "`bitbucket_get_pipeline` for the outcome. Costs build minutes.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        ref: z
          .string()
          .optional()
          .describe("Branch or tag to run against. Defaults to the repository's main branch."),
        ref_type: z
          .enum(["branch", "tag"])
          .optional()
          .describe("Whether `ref` names a branch or a tag. Defaults to branch."),
        pipeline: z
          .string()
          .optional()
          .describe(
            "A named custom pipeline from `bitbucket-pipelines.yml`, e.g. `deploy-staging`. " +
              "Omit to run the default pipeline for the ref.",
          ),
        commit: z
          .string()
          .optional()
          .describe("Run against this exact commit rather than the tip of the ref."),
        variables: z
          .array(
            z.object({
              key: z.string().min(1).describe("Variable name."),
              value: z.string().describe("Variable value."),
              secured: z
                .boolean()
                .optional()
                .describe("Mask the value in logs. Use for anything credential-shaped."),
            }),
          )
          .optional()
          .describe("Pipeline variables for this run only. They do not persist."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ref, ref_type, pipeline, commit, variables, ...args }) =>
      wrap(async () =>
        client.pipelines.trigger(resolveRepo(config, args), {
          ...(ref === undefined ? {} : { ref }),
          ...(ref_type === undefined ? {} : { refType: ref_type }),
          ...(pipeline === undefined ? {} : { pipeline }),
          ...(commit === undefined ? {} : { commit }),
          ...(variables === undefined ? {} : { variables }),
        }),
      ),
  );

  server.registerTool(
    "bitbucket_stop_pipeline",
    {
      title: "Bitbucket: Stop Pipeline",
      description:
        "Stop a running pipeline. There is no resume — a stopped run must be re-triggered " +
        "from the start, losing any work it had done. If the run has a deployment step that " +
        "has already begun, stopping mid-way can leave the target partially updated.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        pipeline_uuid: z
          .string()
          .min(1)
          .describe("The pipeline's UUID in braces, from `bitbucket_get_pipeline`."),
        confirm: confirmArg,
      }),
      // Not idempotent: a second call against a re-triggered run would stop that one
      // too, and marking it idempotent is an invitation to exactly that retry.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ pipeline_uuid, ...args }) =>
      wrap(async () => {
        await client.pipelines.stop(resolveRepo(config, args), pipeline_uuid);
        return { stopped: pipeline_uuid };
      }),
  );
};

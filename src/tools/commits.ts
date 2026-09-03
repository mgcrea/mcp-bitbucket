import { paths, type BitbucketClient, type CommitSummary } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { collected, stripNoise, summarizeCommit, unwrapPage } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  commitArg,
  limitArg,
  okText,
  repositoryArg,
  resolveRepo,
  revisionArg,
  workspaceArg,
  wrap,
  wrapResult,
} from "#/tools/util";

export const registerCommitTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { config } = ctx;

  server.registerTool(
    "bitbucket_list_commits",
    {
      title: "Bitbucket: List Commits",
      description:
        "List commits on a branch, tag or commit, newest first. Subject lines only — use " +
        "`bitbucket_get_commit` for a full message. Bounded by `limit` and paged internally: " +
        "this endpoint is cursor-based with no total, so a repository's whole history is " +
        "reachable and asking for it would be very expensive.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        revision: revisionArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, revision, ...args }) =>
      wrap(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        const items: CommitSummary[] = [];
        for await (const page of client.paginatePages<Record<string, unknown>>(
          { method: "GET", path: paths.REPO_COMMITS(workspace, repository, revision) },
          { limit },
        )) {
          for (const raw of page.values) {
            items.push({
              hash: String(raw.hash ?? ""),
              message: String(raw.message ?? ""),
              author: {
                displayName: String(
                  (raw.author as { user?: { display_name?: string }; raw?: string } | undefined)
                    ?.user?.display_name ??
                    (raw.author as { raw?: string } | undefined)?.raw ??
                    "unknown",
                ),
              },
              date: String(raw.date ?? ""),
            });
            if (items.length >= limit) break;
          }
          if (items.length >= limit) break;
        }
        return collected(items.map(summarizeCommit), limit);
      }),
  );

  server.registerTool(
    "bitbucket_get_commit",
    {
      title: "Bitbucket: Get Commit",
      description:
        "Get one commit: its full message, author, date, parents and the participants who " +
        "approved it. Note the endpoint is singular `/commit/` while the list is plural " +
        "`/commits/` — this tool handles that, but the escape hatch will not.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        commit: commitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ commit, ...args }) =>
      wrap(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        return stripNoise(
          await client.request({
            method: "GET",
            path: paths.COMMIT(workspace, repository, commit),
          }),
        );
      }),
  );

  server.registerTool(
    "bitbucket_get_commit_diff",
    {
      title: "Bitbucket: Get Commit Diff",
      description:
        "Get a diff as raw unified-diff text, for one commit or between two. For a range " +
        "use `to..from` — Bitbucket's order is DESTINATION FIRST, the reverse of `git diff`, " +
        "so `main..feature` shows what feature would bring into main. Pass `stat` for a " +
        "per-file summary instead, which is far smaller and usually the right first look.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        spec: z
          .string()
          .min(1)
          .describe(
            "A commit hash for one commit, or `to..from` for a range — destination first, " +
              "e.g. `main..feature`. Branch names work and resolve to their current tips.",
          ),
        stat: z
          .boolean()
          .default(false)
          .describe(
            "Return a per-file summary of lines added and removed rather than the diff " +
              "itself. Much smaller; use it to decide whether the full diff is worth reading.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ spec, stat, ...args }) =>
      wrapResult(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        if (stat) {
          // diffstat is a JSON collection, unlike the diff itself which is plain text.
          const page = await client.request({
            method: "GET",
            path: paths.DIFFSTAT(workspace, repository, spec),
            query: { pagelen: 100 },
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(unwrapPage(page)) }] };
        }
        const diff = await client.request<string>({
          method: "GET",
          path: paths.DIFF(workspace, repository, spec),
          accept: "text",
        });
        return okText(diff);
      }),
  );

  server.registerTool(
    "bitbucket_list_commit_statuses",
    {
      title: "Bitbucket: List Commit Statuses",
      description:
        "List the build statuses reported against one commit — how to tell whether CI passed " +
        "for a specific revision rather than for a pull request. An empty list means nothing " +
        "reported, which is not the same as success.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        commit: commitArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ commit, limit, ...args }) =>
      wrap(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        return unwrapPage(
          await client.request({
            method: "GET",
            path: paths.COMMIT_STATUSES(workspace, repository, commit),
            query: { pagelen: Math.min(limit, 100) },
          }),
        );
      }),
  );
};

export const registerRefTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { config } = ctx;

  const refTool = (
    name: "bitbucket_list_branches" | "bitbucket_list_tags",
    title: string,
    description: string,
    path: (workspace: string, repository: string) => string,
  ): void => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: z.object({
          workspace: workspaceArg,
          repository: repositoryArg,
          query: z
            .string()
            .optional()
            .describe(
              'Filter by name, e.g. "release" to match release branches. Escaped before it ' +
                "reaches Bitbucket's query language.",
            ),
          sort: z
            .string()
            .optional()
            .describe(
              "One field only. `-target.date` for most recently committed first, which is " +
                "usually what you want on a repository with many stale branches.",
            ),
          limit: limitArg,
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ limit, query, sort, ...args }) =>
        wrap(async () => {
          const { workspace, repository } = resolveRepo(config, args);
          return unwrapPage(
            await client.request({
              method: "GET",
              path: path(workspace, repository),
              query: {
                pagelen: Math.min(limit, 100),
                ...(query === undefined ? {} : { q: `name ~ "${query.replace(/"/g, '\\"')}"` }),
                ...(sort === undefined ? {} : { sort }),
              },
            }),
          );
        }),
    );
  };

  refTool(
    "bitbucket_list_branches",
    "Bitbucket: List Branches",
    "List a repository's branches with the commit each points at. Sort by `-target.date` to " +
      "find active ones — a long-lived repository accumulates branches that will otherwise " +
      "fill the response with things nobody has touched in years.",
    paths.REPO_REFS_BRANCHES,
  );

  refTool(
    "bitbucket_list_tags",
    "Bitbucket: List Tags",
    "List a repository's tags with the commit each points at. Sort by `-target.date` for the " +
      "most recent releases first; the default order is not chronological.",
    paths.REPO_REFS_TAGS,
  );
};

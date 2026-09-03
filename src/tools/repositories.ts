import { paths, type Repository, type RepositorySummary } from "@mgcrea/bitbucket-cli";
import type { BitbucketClient } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  collected,
  stripNoise,
  summarizeRepository,
  summarizeRepositoryDetail,
  unwrapPage,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  limitArg,
  repositoryArg,
  resolveRepo,
  resolveWorkspace,
  take,
  workspaceArg,
  wrap,
} from "#/tools/util";

export const registerWorkspaceTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "bitbucket_list_workspaces",
    {
      title: "Bitbucket: List Workspaces",
      description:
        "List the workspaces this credential can reach. Start here when you do not know the " +
        "workspace slug: it is the only remaining way to discover one, because Atlassian " +
        "removed `GET /workspaces` and the cross-workspace repository listing and both now " +
        "return HTTP 410. A repository access token has no account, so this returns nothing " +
        "for one — use the workspace it was issued for.",
      inputSchema: z.object({ limit: limitArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      wrap(async () => {
        const items = await take(client.workspaces.list(), limit);
        return collected(
          items.map((workspace) => ({
            slug: workspace.slug,
            name: workspace.name,
            ...(workspace.isAdministrator ? { isAdministrator: true } : {}),
          })),
          limit,
        );
      }),
  );

  server.registerTool(
    "bitbucket_get_workspace",
    {
      title: "Bitbucket: Get Workspace",
      description:
        "Get one workspace's details — its name, privacy, and whether forking is allowed. " +
        "Use `bitbucket_list_workspaces` to find the slug.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () =>
        stripNoise(
          await client.request({ path: paths.WORKSPACE(resolveWorkspace(ctx.config, args)) }),
        ),
      ),
  );

  server.registerTool(
    "bitbucket_list_projects",
    {
      title: "Bitbucket: List Projects",
      description:
        "List the projects in a workspace. Projects group repositories; a repository's " +
        "project key is what `bitbucket_get_repository` reports. Not every workspace uses " +
        "them, so an empty list is normal rather than a permissions problem.",
      inputSchema: z.object({ workspace: workspaceArg, limit: limitArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, ...args }) =>
      wrap(async () =>
        unwrapPage(
          await client.request({
            path: paths.WORKSPACE_PROJECTS(resolveWorkspace(ctx.config, args)),
            query: { pagelen: Math.min(limit, 100) },
          }),
        ),
      ),
  );

  server.registerTool(
    "bitbucket_get_project",
    {
      title: "Bitbucket: Get Project",
      description:
        "Get one project by its key — the short upper-case code such as `PROJ`, not its " +
        "display name.",
      inputSchema: z.object({
        workspace: workspaceArg,
        project: z
          .string()
          .min(1)
          .describe("Project key, upper-case, e.g. `PROJ`. From `bitbucket_list_projects`."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, ...args }) =>
      wrap(async () =>
        stripNoise(
          await client.request({
            path: paths.WORKSPACE_PROJECT(resolveWorkspace(ctx.config, args), project),
          }),
        ),
      ),
  );
};

export const registerRepoTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "bitbucket_list_repositories",
    {
      title: "Bitbucket: List Repositories",
      description:
        "List the repositories in one workspace. A workspace is REQUIRED and there is no " +
        "way around it — Atlassian removed the cross-workspace listing and it now answers " +
        "HTTP 410, so to search everywhere you must call this once per workspace from " +
        "`bitbucket_list_workspaces`. Returns each repo's slug, which every other tool takes.",
      inputSchema: z.object({
        workspace: workspaceArg,
        role: z
          .enum(["owner", "admin", "contributor", "member"])
          .optional()
          .describe("Only repositories where you hold this role. Narrows a large workspace."),
        query: z
          .string()
          .optional()
          .describe(
            'Free text matched against the repository name, e.g. "api". Passed to Bitbucket ' +
              "as a BBQL clause and escaped, so it cannot inject a query of its own.",
          ),
        sort: z
          .string()
          .optional()
          .describe(
            "One field only — Bitbucket rejects a list. `-updated_on` for most recently " +
              "changed first; `name` for alphabetical. A leading `-` reverses.",
          ),
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, role, query, sort, ...args }) =>
      wrap(async () => {
        const items: RepositorySummary[] = await take(
          client.repositories.list({
            workspace: resolveWorkspace(ctx.config, args),
            ...(role === undefined ? {} : { role }),
            ...(query === undefined ? {} : { query }),
            ...(sort === undefined ? {} : { sort }),
            // The `list` preset is a server-side `fields=` projection, which is a far
            // better lever than trimming here: it cuts 50 repos from ~162 kB to ~4 kB
            // on the wire, so the tokens are never spent in the first place.
            fields: "list",
          }),
          limit,
        );
        return collected(items.map(summarizeRepository), limit);
      }),
  );

  server.registerTool(
    "bitbucket_get_repository",
    {
      title: "Bitbucket: Get Repository",
      description:
        "Get one repository in full: its main branch, project, size, fork policy and clone " +
        "URLs. The main branch is what every tool taking an optional `revision` falls back " +
        "to, so this is how to find out what that will be.",
      inputSchema: z.object({ workspace: workspaceArg, repository: repositoryArg }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () => {
        const repo: Repository = await client.repositories.get(resolveRepo(ctx.config, args));
        return summarizeRepositoryDetail(repo);
      }),
  );
};

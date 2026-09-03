import type {
  BitbucketClient,
  MergeStrategy,
  PullRequest,
  PullRequestState,
} from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  collected,
  formatUser,
  summarizeCommit,
  summarizePullRequest,
  summarizePullRequestDetail,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  confirmArg,
  dryRunArg,
  limitArg,
  pullRequestIdArg,
  repositoryArg,
  resolveRepo,
  take,
  workspaceArg,
  wrap,
  wrapResult,
  okText,
} from "#/tools/util";

const STATES = ["open", "merged", "declined", "superseded"] as const;

/**
 * Bitbucket's wire names, which are snake_case and not what the UI calls them.
 *
 * `fast_forward` fails outright rather than falling back when the branches have
 * diverged, which is the usual surprise here.
 */
const MERGE_STRATEGIES = [
  "merge_commit",
  "squash",
  "fast_forward",
  "squash_fast_forward",
  "rebase_fast_forward",
  "rebase_merge",
] as const;

export const registerPullRequestTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { config, allowWrites } = ctx;

  server.registerTool(
    "bitbucket_list_pull_requests",
    {
      title: "Bitbucket: List Pull Requests",
      description:
        "List pull requests in a repository. Defaults to open ones only — pass `state` to " +
        "see merged or declined. Returns each PR's id, which every other pull-request tool " +
        "takes. Rows are trimmed to what a list needs; call `bitbucket_get_pull_request` for " +
        "the description and reviewers.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        state: z
          .array(z.enum(STATES))
          .optional()
          .describe('Which states to include. Defaults to ["open"]. Pass all four for everything.'),
        author: z
          .string()
          .optional()
          .describe(
            "Filter by author. Prefer a UUID in braces, e.g. `{1234abcd-…}` — Atlassian " +
              "deprecated filtering by username. `bitbucket_auth_status` reports your own.",
          ),
        reviewer: z.string().optional().describe("Filter by reviewer, same format as `author`."),
        source_branch: z
          .string()
          .optional()
          .describe("Only PRs opened from this branch. Useful to find the PR for a branch."),
        destination_branch: z
          .string()
          .optional()
          .describe("Only PRs targeting this branch, e.g. `main`."),
        search: z
          .string()
          .optional()
          .describe(
            "Free text matched against the title. Escaped before it reaches Bitbucket's " +
              "query language, so it cannot inject clauses of its own.",
          ),
        sort: z
          .string()
          .optional()
          .describe(
            "One field only — Bitbucket rejects a list. `-updated_on` for most recently " +
              "active first. A leading `-` reverses.",
          ),
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({
      limit,
      state,
      author,
      reviewer,
      source_branch,
      destination_branch,
      search,
      sort,
      ...args
    }) =>
      wrap(async () => {
        const items = await take(
          client.pullRequests.list({
            ...resolveRepo(config, args),
            ...(state === undefined ? {} : { state: state as readonly PullRequestState[] }),
            ...(author === undefined ? {} : { author }),
            ...(reviewer === undefined ? {} : { reviewer }),
            ...(source_branch === undefined ? {} : { sourceBranch: source_branch }),
            ...(destination_branch === undefined ? {} : { destinationBranch: destination_branch }),
            ...(search === undefined ? {} : { search }),
            ...(sort === undefined ? {} : { sort }),
            // A server-side `fields=` projection, which is what keeps this cheap on the
            // wire rather than only in the response we build.
            fields: "list",
          }),
          limit,
        );
        return collected(items.map(summarizePullRequest), limit);
      }),
  );

  server.registerTool(
    "bitbucket_get_pull_request",
    {
      title: "Bitbucket: Get Pull Request",
      description:
        "Get one pull request in full: description, reviewers grouped by their decision, " +
        "merge commit and close reason. Use this rather than reading a list row when you " +
        "need to know who has approved or what the PR actually says.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, ...args }) =>
      wrap(async () => {
        const pr: PullRequest = await client.pullRequests.get({
          ...resolveRepo(config, args),
          id,
        });
        return summarizePullRequestDetail(pr);
      }),
  );

  server.registerTool(
    "bitbucket_get_pull_request_diff",
    {
      title: "Bitbucket: Get Pull Request Diff",
      description:
        "Get a pull request's diff as raw unified-diff text, which is what you want in order " +
        "to review the change. Can be very large on a wide PR — check the PR's own file count " +
        "first, or read individual files with `bitbucket_get_file`. Pass `patch` for the " +
        "git-format-patch form, which includes commit messages and authorship.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        patch: z
          .boolean()
          .default(false)
          .describe(
            "Return `git format-patch` output instead of a plain diff — one patch per commit, " +
              "with messages and authorship. Larger; use it when history matters.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, patch, ...args }) =>
      wrapResult(async () => {
        const ref = { ...resolveRepo(config, args), id };
        // Returned raw, not JSON-stringified: a diff put through JSON.stringify becomes
        // one escaped line that nothing can read and that costs more tokens than the
        // diff itself.
        return okText(
          patch ? await client.pullRequests.patch(ref) : await client.pullRequests.diff(ref),
        );
      }),
  );

  server.registerTool(
    "bitbucket_list_pull_request_comments",
    {
      title: "Bitbucket: List Pull Request Comments",
      description:
        "List a pull request's comments, including inline ones with the file and line they " +
        "are attached to. Deleted comments come back with their content removed rather than " +
        "being omitted, so a gap in the thread is expected.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit, ...args }) =>
      wrap(async () => {
        const items = await take(
          client.pullRequests.comments({ ...resolveRepo(config, args), id }),
          limit,
        );
        return collected(
          items.map((comment) => ({
            id: comment.id,
            author: formatUser(comment.author),
            content: comment.content,
            createdAt: comment.createdAt,
            ...(comment.deleted ? { deleted: true } : {}),
            ...(comment.parentId === undefined ? {} : { replyTo: comment.parentId }),
            ...(comment.inline === undefined
              ? {}
              : {
                  inline: {
                    path: comment.inline.path,
                    ...(comment.inline.to === undefined ? {} : { line: comment.inline.to }),
                    ...(comment.inline.from === undefined
                      ? {}
                      : { originalLine: comment.inline.from }),
                  },
                }),
          })),
          limit,
        );
      }),
  );

  server.registerTool(
    "bitbucket_list_pull_request_commits",
    {
      title: "Bitbucket: List Pull Request Commits",
      description:
        "List the commits a pull request would bring in. Subject lines only; use " +
        "`bitbucket_get_commit` for a full message. This is the cheap way to see the shape " +
        "of a change before pulling its whole diff.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit, ...args }) =>
      wrap(async () => {
        const items = await take(
          client.pullRequests.commits({ ...resolveRepo(config, args), id }),
          limit,
        );
        return collected(items.map(summarizeCommit), limit);
      }),
  );

  server.registerTool(
    "bitbucket_list_pull_request_statuses",
    {
      title: "Bitbucket: List Pull Request Statuses",
      description:
        "List the build statuses reported against a pull request's head commit — this is " +
        "how to tell whether CI passed. An empty list means nothing has reported yet, which " +
        "is not the same as passing.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit, ...args }) =>
      wrap(async () => {
        const items = await take(
          client.pullRequests.statuses({ ...resolveRepo(config, args), id }),
          limit,
        );
        return collected(items, limit);
      }),
  );

  // Everything below mutates Bitbucket. Registered only when writes are enabled, so
  // with the default they are not merely refused — they are absent from tools/list and
  // cannot be called at all.
  if (!allowWrites) return;

  server.registerTool(
    "bitbucket_create_pull_request",
    {
      title: "Bitbucket: Create Pull Request",
      description:
        "Open a pull request. The source branch must already be pushed — this does not push " +
        "for you, and Bitbucket answers a missing branch with a validation error rather than " +
        "creating anything. `destination_branch` defaults to the repository's main branch. " +
        "Reviewers are given as UUIDs in braces, not usernames.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        title: z.string().min(1).describe("Pull request title."),
        description: z
          .string()
          .optional()
          .describe("Markdown body. Bitbucket renders the same flavour as its comment boxes."),
        source_branch: z
          .string()
          .min(1)
          .describe("Branch to merge FROM. Must already exist on the remote."),
        destination_branch: z
          .string()
          .optional()
          .describe("Branch to merge INTO. Defaults to the repository's main branch."),
        source_repository: z
          .string()
          .optional()
          .describe(
            "For a cross-fork PR, the source repo as `workspace/slug`. Omit for a branch in " +
              "the same repository.",
          ),
        reviewers: z
          .array(z.string())
          .optional()
          .describe(
            "Reviewer UUIDs in braces, e.g. `{1234abcd-…}`. Usernames are not accepted here. " +
              "A user who cannot see the repository makes the whole call fail.",
          ),
        close_source_branch: z
          .boolean()
          .optional()
          .describe("Delete the source branch when the PR merges."),
        draft: z
          .boolean()
          .optional()
          .describe("Open as a draft, which blocks merging until marked ready."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({
      title,
      description,
      source_branch,
      destination_branch,
      source_repository,
      reviewers,
      close_source_branch,
      draft,
      ...args
    }) =>
      wrap(async () => {
        const pr = await client.pullRequests.create(resolveRepo(config, args), {
          title,
          sourceBranch: source_branch,
          ...(description === undefined ? {} : { description }),
          ...(destination_branch === undefined ? {} : { destinationBranch: destination_branch }),
          ...(source_repository === undefined ? {} : { sourceRepository: source_repository }),
          ...(reviewers === undefined ? {} : { reviewers }),
          ...(close_source_branch === undefined ? {} : { closeSourceBranch: close_source_branch }),
          ...(draft === undefined ? {} : { draft }),
        });
        return summarizePullRequestDetail(pr);
      }),
  );

  server.registerTool(
    "bitbucket_update_pull_request",
    {
      title: "Bitbucket: Update Pull Request",
      description:
        "Change a pull request's title, description, target branch, reviewers or draft state. " +
        "Only the fields you pass are sent. Note `reviewers` REPLACES the whole list rather " +
        "than adding to it — read the current set with `bitbucket_get_pull_request` first.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        title: z.string().optional().describe("New title."),
        description: z.string().optional().describe("New markdown body."),
        destination_branch: z.string().optional().describe("Retarget onto this branch."),
        reviewers: z
          .array(z.string())
          .optional()
          .describe(
            "REPLACES the reviewer list with these UUIDs in braces. Passing one name drops " +
              "everybody else.",
          ),
        draft: z.boolean().optional().describe("Mark as draft (true) or ready for review (false)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, title, description, destination_branch, reviewers, draft, ...args }) =>
      wrap(async () => {
        const input = {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(destination_branch === undefined ? {} : { destinationBranch: destination_branch }),
          ...(reviewers === undefined ? {} : { reviewers }),
          ...(draft === undefined ? {} : { draft }),
        };
        if (Object.keys(input).length === 0) {
          throw new Error(
            "Nothing to update — pass at least one of title, description, destination_branch, " +
              "reviewers or draft.",
          );
        }
        const pr = await client.pullRequests.update({ ...resolveRepo(config, args), id }, input);
        return summarizePullRequestDetail(pr);
      }),
  );

  server.registerTool(
    "bitbucket_merge_pull_request",
    {
      title: "Bitbucket: Merge Pull Request",
      description:
        "Merge a pull request. Defaults to a DRY RUN that reports the PR's current state and " +
        "the strategy that would be used, so a call that forgets `dry_run: false` previews " +
        "instead of merging. To actually merge, pass dry_run: false AND confirm: true. " +
        "Merging is not reversible from the API. Bitbucket may answer asynchronously with a " +
        "task to poll; this waits for it so the result is the real outcome rather than " +
        '"pending". `fast_forward` fails outright when the branches have diverged rather ' +
        "than falling back to a merge commit.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        strategy: z
          .enum(MERGE_STRATEGIES)
          .optional()
          .describe(
            "Wire names, which are not what the UI calls them. Defaults to the repository's " +
              "configured strategy.",
          ),
        message: z.string().optional().describe("Override the merge commit message."),
        close_source_branch: z
          .boolean()
          .optional()
          .describe("Delete the source branch after merging. Defaults to the PR's own setting."),
        dry_run: dryRunArg,
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true when dry_run is false. Acknowledges that this merges for real."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id, strategy, message, close_source_branch, dry_run, confirm, ...args }) =>
      wrapResult(async () => {
        const ref = { ...resolveRepo(config, args), id };

        if (dry_run) {
          const pr = await client.pullRequests.get(ref);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  dry_run: true,
                  would_merge: pr.state === "open" && !pr.draft,
                  id: pr.id,
                  title: pr.title,
                  state: pr.state,
                  draft: pr.draft,
                  source: pr.source.name,
                  destination: pr.destination.name,
                  strategy: strategy ?? "the repository default",
                  reviewers: summarizePullRequestDetail(pr).reviewers,
                  ...(pr.state !== "open"
                    ? { blocked: `This pull request is ${pr.state}, so it cannot be merged.` }
                    : pr.draft
                      ? {
                          blocked:
                            "This pull request is a draft. Mark it ready with " +
                            "bitbucket_update_pull_request first.",
                        }
                      : {}),
                  note: "Nothing was changed. Pass dry_run: false and confirm: true to merge.",
                }),
              },
            ],
          };
        }

        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "Refusing to merge: pass confirm: true together with dry_run: false. Run " +
                    "the dry run first and read the reported state.",
                }),
              },
            ],
            isError: true,
          };
        }

        const outcome = await client.pullRequests.merge(ref, {
          ...(strategy === undefined ? {} : { strategy: strategy as MergeStrategy }),
          ...(message === undefined ? {} : { message }),
          ...(close_source_branch === undefined ? {} : { closeSourceBranch: close_source_branch }),
          // Bitbucket answers either 200 with the merged PR or 202 with a task to poll.
          // Waiting turns that into one answer instead of making the caller decide
          // whether "pending" means it worked.
          wait: true,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
      }),
  );

  server.registerTool(
    "bitbucket_decline_pull_request",
    {
      title: "Bitbucket: Decline Pull Request",
      description:
        "Decline (close without merging) a pull request. IRREVERSIBLE on Bitbucket Cloud: " +
        "there is no reopen endpoint, so a declined PR can only be replaced by a new one, " +
        "losing its comments and review history. If you only want to pause review, mark it " +
        "a draft with `bitbucket_update_pull_request` instead.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, ...args }) =>
      wrap(async () => {
        const pr = await client.pullRequests.decline({ ...resolveRepo(config, args), id });
        return { declined: pr.id, state: pr.state };
      }),
  );

  server.registerTool(
    "bitbucket_review_pull_request",
    {
      title: "Bitbucket: Review Pull Request",
      description:
        "Approve a pull request, request changes on it, or clear your existing decision. " +
        "This is your own review as the authenticated user; it cannot be set on someone " +
        "else's behalf. Setting `none` clears whichever decision you had — doing that when " +
        "you had none is a no-op rather than an error.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        decision: z
          .enum(["approved", "changes-requested", "none"])
          .describe(
            "`approved` to approve, `changes-requested` to block, `none` to withdraw whatever " +
              "you previously set.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, decision, ...args }) =>
      wrap(async () => {
        await client.pullRequests.setReview({ ...resolveRepo(config, args), id }, decision);
        return { id, decision };
      }),
  );

  server.registerTool(
    "bitbucket_comment_pull_request",
    {
      title: "Bitbucket: Comment on Pull Request",
      description:
        "Add a comment to a pull request, either at the top level or inline against a file " +
        "and line. An inline comment needs both `path` and `line`; the line number is the " +
        "one in the NEW version of the file, as the diff shows it. Reply to an existing " +
        "comment with `reply_to` to keep a thread together instead of starting a new one.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        id: pullRequestIdArg,
        body: z.string().min(1).describe("Comment text. Markdown is rendered."),
        path: z
          .string()
          .optional()
          .describe(
            "File to attach the comment to, repository-relative, e.g. `src/api.ts`. Requires " +
              "`line`. The path must appear in the PR's diff.",
          ),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Line number in the NEW version of the file, as numbered in the diff. Requires " +
              "`path`.",
          ),
        reply_to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Comment id to reply to, from `bitbucket_list_pull_request_comments`."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, body, path, line, reply_to, ...args }) =>
      wrap(async () => {
        if ((path === undefined) !== (line === undefined)) {
          throw new Error(
            "An inline comment needs both `path` and `line`. Omit both for a top-level comment.",
          );
        }
        const comment = await client.pullRequests.addComment(
          { ...resolveRepo(config, args), id },
          {
            body,
            ...(path !== undefined && line !== undefined ? { inline: { path, to: line } } : {}),
            ...(reply_to === undefined ? {} : { parentId: reply_to }),
          },
        );
        return { id: comment.id, createdAt: comment.createdAt };
      }),
  );
};

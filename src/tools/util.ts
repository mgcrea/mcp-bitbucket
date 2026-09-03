import { describeError } from "@mgcrea/bitbucket-cli";
import { z } from "zod";

import { MissingTargetError, WritesDisabledError } from "#/client/errors";
import type { Config } from "#/config";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. Measured on real list rows across this fleet, `null, 2`
 * adds 19-41% to every response — worst on wide lists of short-keyed objects, which are
 * exactly the replies already big enough to hurt. No model needs the indentation, and
 * every tool returns through here.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a diff or a source file into
 * one escaped `"diff --git a/…\n"` line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/**
 * `extra` is spread at the top level, not nested under `details`, so a `remedy` lands
 * beside the error rather than three levels inside an upstream envelope. That matters:
 * the remedy is the half the model should act on, and a nested one gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/**
 * Render a thrown value as a tool error.
 *
 * `describeError` already flattens the client library's whole hierarchy to
 * `{kind, title, detail, hint, fields}`, so there is no per-class branching to write
 * here. The one transformation worth making is lifting `hint` to a top-level `remedy`:
 * the library's hints are genuinely actionable ("Listing repositories across all
 * workspaces was removed. Pass a workspace.") and burying one inside a nested object is
 * how it gets ignored.
 */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof WritesDisabledError || err instanceof MissingTargetError) {
    return fail(err.message);
  }
  const described = describeError(err);
  return fail(described.title, {
    kind: described.kind,
    ...(described.hint === undefined ? {} : { remedy: described.hint }),
    ...(described.detail === undefined ? {} : { detail: described.detail }),
    // Per-field validation messages. Bitbucket returns these on a 400 and they name
    // exactly which field it objected to, which the top-level message never does.
    ...(described.fields === undefined ? {} : { fields: described.fields }),
  });
};

/** Run a tool body, JSON-formatting the result and turning a throw into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (raw text, say). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

// ---- Arg atoms ---------------------------------------------------------------------
//
// Defined once and reused by identifier. This is where the API's traps live, because an
// argument description is read at exactly the moment it is relevant.

export const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Workspace slug (the first path segment of a repo URL, not its display name). " +
      "Defaults to BITBUCKET_WORKSPACE. There is no way to search across workspaces — " +
      "Atlassian removed both `GET /workspaces` and the cross-workspace repository listing, " +
      "and they now return HTTP 410 — so `bitbucket_list_workspaces` is the only way to " +
      "discover which ones this credential can reach.",
  );

export const repositoryArg = z
  .string()
  .optional()
  .describe(
    "Repository slug, e.g. `my-api` — the last path segment of the repo URL, lower-case, " +
      "not the display name. Defaults to BITBUCKET_REPOSITORY.",
  );

export const pullRequestIdArg = z
  .number()
  .int()
  .positive()
  .describe("Pull request number, as shown in its URL and by `bitbucket_list_pull_requests`.");

export const revisionArg = z
  .string()
  .optional()
  .describe(
    "A branch name, tag or commit hash. Defaults to the repository's main branch. " +
      "Prefer a commit hash when the branch name contains a slash: Bitbucket splits the " +
      "ref and the file path on the same separator, so `feature/x` is ambiguous.",
  );

export const commitArg = z
  .string()
  .min(7)
  .describe(
    "A commit hash, full or abbreviated to at least 7 characters. A branch name works on " +
      "most endpoints but resolves to whatever the tip is right now.",
  );

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(25)
  .describe(
    "Maximum number of items to return (1-200). Defaults to 25. This server pages " +
      "internally, so a large value means several requests against one hourly quota — " +
      "check `bitbucket_rate_limit_status` before asking for hundreds.",
  );

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes state in Bitbucket.");

export const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "Report what would happen without doing it. Defaults to TRUE, so a call that forgets " +
      "to set it is a preview rather than a mutation.",
  );

/** Drop undefined values so we never send `{"q": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Resolve the workspace/repository a tool is aimed at.
 *
 * Kept in one place because the fallback to configuration is the same everywhere and
 * the error has to name both routes — the argument is optional in the schema precisely
 * so `BITBUCKET_WORKSPACE` can supply it, which makes "missing" a configuration
 * question rather than a validation one.
 */
export const resolveRepo = (
  config: Config,
  args: { workspace?: string | undefined; repository?: string | undefined },
): { workspace: string; repository: string } => {
  const workspace = args.workspace ?? config.workspace;
  if (workspace === undefined) throw new MissingTargetError("workspace", "BITBUCKET_WORKSPACE");
  const repository = args.repository ?? config.repository;
  if (repository === undefined) throw new MissingTargetError("repository", "BITBUCKET_REPOSITORY");
  return { workspace, repository };
};

export const resolveWorkspace = (
  config: Config,
  args: { workspace?: string | undefined },
): string => {
  const workspace = args.workspace ?? config.workspace;
  if (workspace === undefined) throw new MissingTargetError("workspace", "BITBUCKET_WORKSPACE");
  return workspace;
};

/**
 * Take at most `limit` items from an async iterable.
 *
 * The client library's `paginate` stops requesting pages the moment the consumer stops
 * pulling, so returning from inside this loop genuinely ends the HTTP chain rather than
 * draining a collection first. That is the difference between a bounded read and an
 * unbounded one on a repository with 40,000 commits.
 */
export const take = async <T>(source: AsyncIterable<T>, limit: number): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
};

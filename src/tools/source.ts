import { paths, type BitbucketClient } from "@mgcrea/bitbucket-cli";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { unwrapPage } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  limitArg,
  okText,
  repositoryArg,
  resolveRepo,
  revisionArg,
  workspaceArg,
  wrap,
  wrapResult,
} from "#/tools/util";

/**
 * A ceiling on a single file read, in bytes.
 *
 * Not about correctness — about not silently spending the whole context window on a
 * minified bundle or a checked-in lockfile. Generous enough for any hand-written source
 * file; `max_bytes` raises it deliberately.
 */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Written as an escape so the byte itself never appears in this source file. */
const NUL = "\u0000";

export const registerSourceTools = (
  server: McpServer,
  client: BitbucketClient,
  ctx: ToolContext,
): void => {
  const { config } = ctx;

  server.registerTool(
    "bitbucket_get_file",
    {
      title: "Bitbucket: Get File",
      description:
        "Read one file's contents at a branch, tag or commit. Returned as raw text, so it " +
        "can be read directly rather than unescaped from JSON. Prefer a commit hash for " +
        "`revision` when a branch name contains a slash: Bitbucket splits the ref and the " +
        "path on the same separator, so `feature/x` plus a path is ambiguous. Binary files " +
        "and anything over `max_bytes` are refused rather than dumped into the conversation.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        path: z
          .string()
          .min(1)
          .describe("Repository-relative file path, e.g. `src/index.ts`. No leading slash."),
        revision: revisionArg,
        max_bytes: z
          .number()
          .int()
          .min(1024)
          .max(5 * 1024 * 1024)
          .default(DEFAULT_MAX_BYTES)
          .describe(
            `Refuse a file larger than this. Defaults to ${DEFAULT_MAX_BYTES} bytes, which is ` +
              "ample for source but stops a lockfile or a minified bundle from filling the " +
              "context window. Raise it deliberately.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path, revision, max_bytes, ...args }) =>
      wrapResult(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        const text = await client.request<string>({
          method: "GET",
          path: paths.REPO_SRC(workspace, repository, revision ?? "HEAD", path),
          accept: "text",
        });

        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > max_bytes) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `${path} is ${bytes} bytes, over the ${max_bytes}-byte limit.`,
                  remedy:
                    "Raise max_bytes if you genuinely need the whole file, or read the diff " +
                    "instead with bitbucket_get_commit_diff, which shows only what changed.",
                  bytes,
                }),
              },
            ],
            isError: true,
          };
        }

        // A NUL byte is the cheapest reliable binary signal, and a binary file rendered
        // as text is both unreadable and expensive.
        if (text.includes(NUL)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `${path} looks like a binary file.`,
                  remedy: "Nothing useful can be shown as text. Fetch it outside this server.",
                  bytes,
                }),
              },
            ],
            isError: true,
          };
        }

        return okText(text);
      }),
  );

  server.registerTool(
    "bitbucket_list_directory",
    {
      title: "Bitbucket: List Directory",
      description:
        "List the files and directories at a path in the repository, at a branch, tag or " +
        "commit. Use this to explore a tree before reading files. Note this is the SAME " +
        "endpoint as `bitbucket_get_file` — Bitbucket returns raw bytes for a file and a " +
        "listing for a directory, so pointing this at a file will not do what you want; use " +
        "the other tool for that.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        path: z
          .string()
          .optional()
          .describe(
            "Repository-relative directory path, e.g. `src/client`. Omit for the repository " +
              "root. No leading slash.",
          ),
        revision: revisionArg,
        limit: limitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path, revision, limit, ...args }) =>
      wrap(async () => {
        const { workspace, repository } = resolveRepo(config, args);
        const page = await client.request({
          method: "GET",
          path: paths.REPO_SRC(workspace, repository, revision ?? "HEAD", path),
          query: { pagelen: Math.min(limit, 100) },
        });
        // Entries carry a `commit` object apiece — the same commit for every file in a
        // listing — plus `links` and `attributes`. Only the shape and size are useful
        // when deciding what to read next.
        return unwrapPage(page, (entry) => {
          const item = entry as {
            type?: unknown;
            path?: unknown;
            size?: unknown;
            mimetype?: unknown;
          };
          return {
            type: item.type,
            path: item.path,
            ...(typeof item.size === "number" ? { size: item.size } : {}),
            ...(typeof item.mimetype === "string" ? { mimetype: item.mimetype } : {}),
          };
        });
      }),
  );
};

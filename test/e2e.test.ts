import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "cli.js");

/**
 * Drives the BUILT bundle over real stdio against a stand-in Bitbucket.
 *
 * The rest of the suite drives the tools through an in-memory transport with a mocked
 * `fetch`, which is faster and needs no build. This covers what that structurally
 * cannot: that `dist/cli.js` starts at all, that `bin` points at a file that exists,
 * and that the whole stack — SDK, client library, shaping layer — composes when the
 * only thing faked is the API.
 *
 * Skipped when there is no build, so `pnpm test` on a clean checkout still passes. CI
 * runs `build` before `test`, and the same suite then covers it.
 */
describe.skipIf(!existsSync(BIN))("the built server, end to end", () => {
  let server: Server;
  // Assigned by the kernel rather than hard-coded: a fixed port makes the suite fail on
  // whichever developer machine happens to be running something else on it, which looks
  // exactly like a real failure and is not one.
  let port: number;
  let child: ChildProcessWithoutNullStreams;
  let requests: string[] = [];
  let nextId = 1;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();

  const send = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean; unregistered: boolean }> => {
    const response = await send("tools/call", { name, arguments: args });
    // An unregistered tool is rejected by the SDK at the protocol layer and comes back
    // as a JSON-RPC error with no `result` at all. That is distinct from a tool that
    // ran and failed, and the distinction is exactly what the write gate is for.
    if (response.error !== undefined) {
      return { text: JSON.stringify(response.error), isError: true, unregistered: true };
    }
    const result = response.result as { content?: { text?: string }[]; isError?: boolean };
    return {
      text: result.content?.[0]?.text ?? "",
      isError: result.isError === true,
      unregistered: false,
    };
  };

  const routes: Record<string, () => unknown> = {
    "/2.0/repositories/acme/api/pullrequests": () => ({
      page: 1,
      pagelen: 10,
      size: 1,
      values: [
        {
          id: 42,
          title: "Add the widget",
          state: "OPEN",
          author: { display_name: "Ada Lovelace", username: "ada", uuid: "{a}" },
          source: { branch: { name: "feature/widget" }, repository: { full_name: "acme/api" } },
          destination: { branch: { name: "main" } },
          created_on: "2026-01-01T00:00:00Z",
          updated_on: "2026-01-02T00:00:00Z",
          comment_count: 3,
          task_count: 0,
          draft: false,
          close_source_branch: true,
          links: {
            html: { href: "https://bitbucket.org/acme/api/pull-requests/42" },
            self: { href: "…" },
            diff: { href: "…" },
          },
        },
      ],
    }),
    "/2.0/repositories/acme/api/refs/branches": () => ({
      pagelen: 10,
      size: 1,
      values: [
        {
          name: "main",
          type: "branch",
          target: { hash: "abc123", date: "2026-01-01T00:00:00Z", links: { self: { href: "…" } } },
          links: { self: { href: "…" }, html: { href: "…" } },
        },
      ],
    }),
    "/2.0/repositories/acme/api/src/main/src/index.ts": () => "export const x = 1;\n",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      requests.push(`${req.method} ${url.pathname}`);
      const route = routes[url.pathname];
      if (route === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: "Not found" } }));
        return;
      }
      const body = route();
      if (typeof body === "string") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-limit": "1000, 1000;w=3600",
        "x-ratelimit-remaining": "997",
      });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    child = spawn("node", [BIN], {
      env: {
        ...process.env,
        // Nothing real, so the developer's own credentials cannot take part.
        HOME: "/nonexistent",
        BITBUCKET_CONFIG: "/nonexistent.json",
        BITBUCKET_HOSTS_FILE: "/nonexistent/hosts.yml",
        BITBUCKET_API_URL: `http://127.0.0.1:${port}/2.0`,
        BITBUCKET_API_TOKEN: "e2e-token",
        BITBUCKET_EMAIL: "e2e@example.com",
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_REPOSITORY: "api",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") {
          const message = JSON.parse(line) as Record<string, unknown>;
          const resolve = pending.get(message.id as number);
          if (resolve !== undefined) {
            pending.delete(message.id as number);
            resolve(message);
          }
        }
        index = buffer.indexOf("\n");
      }
    });

    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    requests = [];
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("shapes a pull-request list through the whole stack", async () => {
    const { text } = await callTool("bitbucket_list_pull_requests", { limit: 5 });
    const row = (JSON.parse(text) as { values: Record<string, unknown>[] }).values[0];

    expect(row).toEqual({
      id: 42,
      title: "Add the widget",
      state: "open",
      author: "Ada Lovelace (@ada)",
      source: "feature/widget",
      destination: "main",
      updatedAt: "2026-01-02T00:00:00Z",
      url: "https://bitbucket.org/acme/api/pull-requests/42",
      commentCount: 3,
    });
    // The three things that would each blow the context window on a real repository.
    expect(text).not.toContain("links");
    expect(text).not.toContain("full_name");
    expect(row).not.toHaveProperty("taskCount"); // zero costs no tokens
  });

  it("returns a file as raw text rather than JSON-escaping it", async () => {
    const { text } = await callTool("bitbucket_get_file", {
      path: "src/index.ts",
      revision: "main",
    });
    expect(text).toBe("export const x = 1;\n");
  });

  it("strips noise from an endpoint the client library does not model", async () => {
    const { text } = await callTool("bitbucket_list_branches");
    expect(text).toContain("abc123");
    expect(text).not.toContain("links");
  });

  it("reports the budget Bitbucket sent on an ordinary response", async () => {
    await callTool("bitbucket_list_pull_requests");
    const { text } = await callTool("bitbucket_rate_limit_status");
    expect(JSON.parse(text)).toMatchObject({
      limit: 1000,
      remaining: 997,
      window_seconds: 3600,
    });
  });

  it("turns a real 404 into a legible tool error", async () => {
    const { text, isError } = await callTool("bitbucket_get_repository", { repository: "nope" });
    expect(isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ kind: "not-found" });
  });

  it("does not merely refuse a write with the gate off — the tool does not exist", async () => {
    const before = requests.length;
    const { unregistered } = await callTool("bitbucket_merge_pull_request", { id: 42 });

    expect(unregistered).toBe(true);
    // And nothing reached Bitbucket, because there was no handler to reach it.
    expect(requests.length).toBe(before);
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * Paths that cannot exist.
 *
 * Passing BOTH explicitly is what stops a developer's real credentials leaking into the
 * suite. This server reads two files — its own config, and `bb`'s shared
 * `~/.config/bb/hosts.yml` — and the second one is the dangerous one: anybody who has
 * run `bb auth login` has a live OAuth token there. Without these the suite passes on
 * the machine that has a login and fails in CI, or, worse, the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/bitbucket-mcp/config.json";
export const ABSENT_HOSTS = "/nonexistent/bb/hosts.yml";

/** The minimum env that makes the server consider itself configured. */
export const READY_ENV: Record<string, string> = {
  BITBUCKET_API_TOKEN: "test-token",
  BITBUCKET_EMAIL: "test@example.com",
  BITBUCKET_WORKSPACE: "acme",
  BITBUCKET_REPOSITORY: "api",
};

export const WRITE_ENV: Record<string, string> = { ...READY_ENV, BITBUCKET_ALLOW_WRITES: "1" };

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

export const textResponse = (body: string, init: { status?: number } = {}): Response =>
  new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain" },
  });

/** A Bitbucket pagination envelope, so a fixture reads like the real thing. */
export const page = (values: unknown[], next?: string): Record<string, unknown> => ({
  pagelen: values.length,
  size: values.length,
  values,
  ...(next === undefined ? {} : { next }),
});

export type Harness = Awaited<ReturnType<typeof connect>>;

export const connect = async (
  env: Record<string, string> = READY_ENV,
  fetchImpl?: ReturnType<typeof vi.fn>,
) => {
  const config: Config = loadConfig(env, ABSENT_CONFIG, ABSENT_HOSTS);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse(page([])));
  const { server, rateLimits } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep private
  // state that does not cross. Mixing them makes the pair hang rather than fail, which
  // is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    rateLimits,
    /**
     * How many requests went out. A number rather than the mock itself: a vitest mock's
     * type drags @vitest/spy internals into this function's inferred return type, and
     * `tsc --noEmit` then fails with TS2883 ("cannot be named without a reference to
     * 'Procedure'"). Returning primitives keeps the harness shareable.
     */
    callCount: (): number => fetchMock.mock.calls.length,
    urls: (): string[] => fetchMock.mock.calls.map((c) => String(c[0])),
    methodAt: (index: number): string => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return String(init.method ?? "GET");
    },
    bodyAt: (index: number): unknown => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    },
    headerAt: (index: number, name: string): string | undefined => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      const headers = init.headers;
      if (headers instanceof Headers) return headers.get(name) ?? undefined;
      return (headers as Record<string, string> | undefined)?.[name];
    },
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    /** The raw first text block, for tools that return a document rather than JSON. */
    callText: async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as { type: string; text: string }[])[0]?.text ?? "";
    },
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and never
      // reaches the tool body — which is the behaviour we want, so the harness reports
      // it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};

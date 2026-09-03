import { beforeAll, describe, expect, it, vi } from "vitest";

import { connect, jsonResponse, page, READY_ENV, textResponse, WRITE_ENV } from "#test/helpers";

/** Registered before any credential check, so an unconfigured server is still useful. */
const AUTH_TOOLS = ["bitbucket_auth_login", "bitbucket_auth_status"];

const READ_TOOLS = [
  "bitbucket_get_commit",
  "bitbucket_get_commit_diff",
  "bitbucket_get_file",
  "bitbucket_get_pipeline",
  "bitbucket_get_pipeline_log",
  "bitbucket_get_project",
  "bitbucket_get_pull_request",
  "bitbucket_get_pull_request_diff",
  "bitbucket_get_repository",
  "bitbucket_get_workspace",
  "bitbucket_list_branches",
  "bitbucket_list_commit_statuses",
  "bitbucket_list_commits",
  "bitbucket_list_directory",
  "bitbucket_list_pipeline_steps",
  "bitbucket_list_pipelines",
  "bitbucket_list_projects",
  "bitbucket_list_pull_request_comments",
  "bitbucket_list_pull_request_commits",
  "bitbucket_list_pull_request_statuses",
  "bitbucket_list_pull_requests",
  "bitbucket_list_repositories",
  "bitbucket_list_tags",
  "bitbucket_list_workspaces",
  "bitbucket_rate_limit_status",
  "bitbucket_request",
];

const WRITE_TOOLS = [
  "bitbucket_comment_pull_request",
  "bitbucket_create_pull_request",
  "bitbucket_decline_pull_request",
  "bitbucket_merge_pull_request",
  "bitbucket_review_pull_request",
  "bitbucket_run_pipeline",
  "bitbucket_stop_pipeline",
  "bitbucket_update_pull_request",
];

/** The method enum narrows at REGISTRATION time, not in the handler. */
const methodEnum = async (env: Record<string, string>): Promise<string[] | undefined> => {
  const tool = await (await connect(env)).tool("bitbucket_request");
  // Asserted rather than optional-chained: a missing tool is a failure to report, not
  // something to silently read `undefined` through.
  expect(tool, "bitbucket_request is not registered").toBeDefined();
  const properties = tool!.inputSchema.properties as { method?: { enum?: string[] } };
  return properties.method?.enum;
};

describe("tool registration", () => {
  let unconfigured: string[];
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    unconfigured = await (await connect({})).toolNames();
    readOnly = await (await connect(READY_ENV)).toolNames();
    withWrites = await (await connect(WRITE_ENV)).toolNames();
  });

  it("still connects with no credentials, and serves the tools that need none", () => {
    // The regression that produces "MCP error -32000: Connection closed": a server that
    // exits on startup takes the credential-free tools with it and leaves no way to
    // discover what to configure.
    expect(unconfigured).toEqual(AUTH_TOOLS);
  });

  it("registers exactly the read surface once configured", () => {
    // toEqual, not toContain: adding a tool should be a deliberate act with a visible
    // diff rather than something that slips in.
    expect(readOnly).toEqual([...AUTH_TOOLS, ...READ_TOOLS].toSorted());
  });

  it("does not merely refuse the write tools when writes are off — they do not exist", () => {
    for (const tool of WRITE_TOOLS) expect(readOnly, tool).not.toContain(tool);
  });

  it("registers exactly the write surface when writes are enabled", () => {
    expect(withWrites).toEqual([...AUTH_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  it("only ever ADDS when the write flag goes on", () => {
    // A gate written the wrong way round removes read tools instead of adding write
    // ones, which a "no write tools leaked" check structurally cannot see.
    const missing = readOnly.filter((name) => !withWrites.includes(name));
    expect(missing).toEqual([]);
  });

  it("lets an env var beat a config file, so BITBUCKET_ALLOW_WRITES=0 always wins", async () => {
    const names = await (await connect({ ...READY_ENV, BITBUCKET_ALLOW_WRITES: "0" })).toolNames();
    expect(names).not.toContain("bitbucket_merge_pull_request");
  });

  it("offers logout only when there is an OAuth login to forget", async () => {
    expect(readOnly).not.toContain("bitbucket_auth_logout");
    const oauth = await (
      await connect({
        BITBUCKET_OAUTH_CLIENT_ID: "id",
        BITBUCKET_OAUTH_CLIENT_SECRET: "secret",
        BITBUCKET_WORKSPACE: "acme",
      })
    ).toolNames();
    expect(oauth).toContain("bitbucket_auth_logout");
  });
});

describe("auth status", () => {
  it("answers an unconfigured server with usable setup text", async () => {
    const harness = await connect({});
    const result = await harness.call("bitbucket_auth_status");

    expect(result.configured).toBe(false);
    expect(result.setup).toBeInstanceOf(Array);
    expect((result.setup as string[]).join(" ")).toMatch(/BITBUCKET_API_TOKEN/);
    // The three real routes in, all named, because this is the only channel left once
    // the server has given up refusing to start.
    expect((result.setup as string[]).join(" ")).toMatch(/OAuth consumer/);
    expect((result.setup as string[]).join(" ")).toMatch(/BITBUCKET_ACCESS_TOKEN/);
    expect(result.available_without_credentials).toEqual([
      "bitbucket_auth_status",
      "bitbucket_auth_login",
    ]);
  });

  it("reports presence, never the token itself", async () => {
    const result = await (await connect(READY_ENV)).call("bitbucket_auth_status");
    expect(JSON.stringify(result)).not.toContain("test-token");
    expect(result.credential).toBe("api token set");
    expect(result.auth_method).toBe("apiToken");
  });

  it("warns when writes are enabled but no login is stored to check scopes against", async () => {
    const result = await (await connect(WRITE_ENV)).call("bitbucket_auth_status");
    expect(result.writes).toBe("ENABLED");
  });

  it("makes no request at all, so it works while the API is unreachable", async () => {
    const harness = await connect({});
    await harness.call("bitbucket_auth_status");
    expect(harness.callCount()).toBe(0);
  });
});

describe("the tool contract", () => {
  // Run with writes ON so the gated tools are covered too. All three of these are
  // invisible in review and at runtime, and simply make the model guess.
  it("gives every tool a service-prefixed title, so a permission dialog is unambiguous", async () => {
    const tools = (await (await connect(WRITE_ENV)).client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.title, tool.name).toMatch(/^Bitbucket: /);
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    for (const tool of (await (await connect(WRITE_ENV)).client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool", async () => {
    for (const tool of (await (await connect(WRITE_ENV)).client.listTools()).tools) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });

  it("marks reads read-only and irreversible writes destructive", async () => {
    const harness = await connect(WRITE_ENV);
    for (const name of READ_TOOLS.filter((n) => n !== "bitbucket_request")) {
      expect((await harness.tool(name))?.annotations?.readOnlyHint, name).toBe(true);
    }
    // Declining is irreversible on Cloud — there is no reopen endpoint at all.
    expect(
      (await harness.tool("bitbucket_decline_pull_request"))?.annotations?.destructiveHint,
    ).toBe(true);
    expect((await harness.tool("bitbucket_merge_pull_request"))?.annotations?.destructiveHint).toBe(
      true,
    );
    expect((await harness.tool("bitbucket_stop_pipeline"))?.annotations?.destructiveHint).toBe(
      true,
    );
    // Creating a pull request is a write but destroys nothing.
    expect(
      (await harness.tool("bitbucket_create_pull_request"))?.annotations?.destructiveHint,
    ).toBe(false);
  });

  it("flips the escape hatch's annotations with the write gate", async () => {
    const read = await (await connect(READY_ENV)).tool("bitbucket_request");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);

    const write = await (await connect(WRITE_ENV)).tool("bitbucket_request");
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.destructiveHint).toBe(true);
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm, and never reach Bitbucket", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const harness = await connect(WRITE_ENV, fetchMock);

    const result = await harness.call("bitbucket_decline_pull_request", { id: 42 });

    expect(result.isToolError).toBe(true);
    // The SDK rejects a schema violation at the protocol layer, so the handler never
    // ran — which is the whole point of confirm being z.literal(true).
    expect(harness.callCount()).toBe(0);
  });

  it("default a merge to a dry run, so a forgotten flag previews instead of merging", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 42,
        title: "Add a thing",
        state: "OPEN",
        draft: false,
        source: { branch: { name: "feature" } },
        destination: { branch: { name: "main" } },
        author: { display_name: "Ada" },
        created_on: "2026-01-01T00:00:00Z",
        updated_on: "2026-01-02T00:00:00Z",
        links: { html: { href: "https://bitbucket.org/acme/api/pull-requests/42" } },
      }),
    );
    const harness = await connect(WRITE_ENV, fetchMock);

    const result = await harness.call("bitbucket_merge_pull_request", { id: 42 });

    expect(result.dry_run).toBe(true);
    expect(result.would_merge).toBe(true);
    // A GET to read the PR, and nothing else. No POST to /merge.
    expect(harness.methodAt(0)).toBe("GET");
    expect(harness.urls().some((url) => url.includes("/merge"))).toBe(false);
  });

  it("refuse a real merge without confirm, even with dry_run off", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const harness = await connect(WRITE_ENV, fetchMock);

    const result = await harness.call("bitbucket_merge_pull_request", {
      id: 42,
      dry_run: false,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/confirm: true/);
    expect(harness.callCount()).toBe(0);
  });
});

describe("request shape", () => {
  it("targets the workspace and repository from configuration", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page([])));
    const harness = await connect(READY_ENV, fetchMock);

    await harness.call("bitbucket_list_pull_requests");

    expect(harness.urls()[0]).toContain("/repositories/acme/api/pullrequests");
  });

  it("lets an argument override the configured target", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page([])));
    const harness = await connect(READY_ENV, fetchMock);

    await harness.call("bitbucket_list_pull_requests", {
      workspace: "other",
      repository: "thing",
    });

    expect(harness.urls()[0]).toContain("/repositories/other/thing/pullrequests");
  });

  it("names both routes in when there is no workspace anywhere", async () => {
    const harness = await connect({ BITBUCKET_API_TOKEN: "t" });
    const result = await harness.call("bitbucket_list_pull_requests");

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/BITBUCKET_WORKSPACE/);
    expect(harness.callCount()).toBe(0);
  });

  it("sends Basic when an email is configured, and keeps it out of the URL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page([])));
    const harness = await connect(READY_ENV, fetchMock);

    await harness.call("bitbucket_list_pull_requests");

    expect(harness.headerAt(0, "authorization")).toBe(
      `Basic ${Buffer.from("test@example.com:test-token").toString("base64")}`,
    );
    expect(harness.urls()[0]).not.toContain("test@example.com");
  });

  it("sends Bearer when no email is configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page([])));
    const harness = await connect(
      { BITBUCKET_API_TOKEN: "t", BITBUCKET_WORKSPACE: "acme" },
      fetchMock,
    );

    await harness.call("bitbucket_list_repositories");

    expect(harness.headerAt(0, "authorization")).toBe("Bearer t");
  });

  it("uses the singular /commit/ for one commit and the plural for the list", async () => {
    // Bitbucket really does split these, and the wrong one 404s.
    const fetchMock = vi.fn(async () => jsonResponse(page([])));
    const harness = await connect(READY_ENV, fetchMock);

    await harness.call("bitbucket_list_commits");
    await harness.call("bitbucket_get_commit", { commit: "abc1234" });

    expect(harness.urls()[0]).toContain("/repositories/acme/api/commits");
    expect(harness.urls()[1]).toContain("/repositories/acme/api/commit/abc1234");
  });

  it("keeps separators inside a source path but still encodes each segment", async () => {
    const fetchMock = vi.fn(async () => textResponse("hello"));
    const harness = await connect(READY_ENV, fetchMock);

    await harness.callText("bitbucket_get_file", {
      path: "src/a b.ts",
      revision: "main",
    });

    // `src%2Fa.ts` would be a file literally named "src/a.ts" and would 404.
    expect(harness.urls()[0]).toContain("/src/main/src/a%20b.ts");
  });
});

describe("the escape hatch", () => {
  it("refuses an absolute URL, so it cannot be pointed off-host", async () => {
    const harness = await connect(READY_ENV);
    const result = await harness.call("bitbucket_request", {
      path: "https://evil.example.com/steal",
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/must be a path, not an absolute URL/);
    expect(harness.callCount()).toBe(0);
  });

  it("refuses `..` segments, so it cannot climb out of the API root", async () => {
    const harness = await connect(READY_ENV);
    const result = await harness.call("bitbucket_request", { path: "/repositories/../../admin" });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/\.\./);
    expect(harness.callCount()).toBe(0);
  });

  it("refuses a protocol-relative path", async () => {
    const harness = await connect(READY_ENV);
    const result = await harness.call("bitbucket_request", { path: "//evil.example.com/steal" });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });

  it("does not offer a write method at all when writes are off", async () => {
    expect(await methodEnum(READY_ENV)).toEqual(["GET"]);
  });

  it("offers the write methods when writes are on", async () => {
    expect(await methodEnum(WRITE_ENV)).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });

  it("rejects a write even if a client skips schema validation", async () => {
    // Belt and braces: the enum already excludes it, but the handler checks again.
    const harness = await connect(READY_ENV);
    const result = await harness.call("bitbucket_request", { path: "/x", method: "DELETE" });
    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("rate limit status", () => {
  it("says so plainly before any request has been made", async () => {
    const result = await (await connect(READY_ENV)).call("bitbucket_rate_limit_status");
    expect(result.requests_this_session).toBe(0);
    expect(String(result.note)).toMatch(/No requests made yet/);
  });

  it("reports the budget Bitbucket sent on an ordinary response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(page([])), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "1000, 1000;w=3600",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-nearlimit": "true",
          },
        }),
    );
    const harness = await connect(READY_ENV, fetchMock);

    await harness.call("bitbucket_list_pull_requests");
    const result = await harness.call("bitbucket_rate_limit_status");

    expect(result.limit).toBe(1000);
    expect(result.window_seconds).toBe(3600);
    expect(result.remaining).toBe(42);
    expect(result.near_limit).toBe(true);
  });
});

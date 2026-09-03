import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inferAuthMethod, isConfigured, loadConfig, setupInstructions } from "#/config";
import { ABSENT_CONFIG, ABSENT_HOSTS } from "#test/helpers";

/**
 * Written 0600 so the group-readable warning does not fire on every case. That warning
 * is correct behaviour — it has its own test below rather than being background noise.
 */
const writeConfigAt = (path: string, body: string): void =>
  writeFileSync(path, body, { mode: 0o600 });

/** Drive loadConfig directly. Nothing here touches process.env. */
const load = (env: Record<string, string>, configPath = ABSENT_CONFIG) =>
  loadConfig(env, configPath, ABSENT_HOSTS);

describe("loadConfig", () => {
  it("never throws when nothing is configured", () => {
    // Rule 2, pinned. A server that throws here surfaces in the client as a bare
    // "Connection closed" with stderr swallowed.
    const config = load({});
    expect(config.authMethod).toBeUndefined();
    expect(isConfigured(config)).toBe(false);
  });

  it("declares the credential type from the variable it arrived in", () => {
    // A bare token cannot be told apart by inspection, so the type is never sniffed.
    expect(load({ BITBUCKET_API_TOKEN: "t" }).authMethod).toBe("apiToken");
    expect(load({ BITBUCKET_ACCESS_TOKEN: "t" }).authMethod).toBe("accessToken");
  });

  it("prefers an access token over an API token when both are set", () => {
    expect(load({ BITBUCKET_ACCESS_TOKEN: "a", BITBUCKET_API_TOKEN: "b" }).authMethod).toBe(
      "accessToken",
    );
  });

  it("accepts BITBUCKET_TOKEN as an alias for the API token", () => {
    expect(load({ BITBUCKET_TOKEN: "t" }).apiToken).toBe("t");
  });

  it("honours an explicit BITBUCKET_AUTH_METHOD over the inference", () => {
    const config = load({ BITBUCKET_API_TOKEN: "t", BITBUCKET_AUTH_METHOD: "accessToken" });
    expect(config.authMethod).toBe("accessToken");
  });

  it("treats an empty env var as unset rather than as an empty value", () => {
    expect(load({ BITBUCKET_API_TOKEN: "   " }).apiToken).toBeUndefined();
    expect(load({ BITBUCKET_API_TOKEN: "" }).authMethod).toBeUndefined();
  });

  it("defaults writes to off", () => {
    expect(load({ BITBUCKET_API_TOKEN: "t" }).allowWrites).toBe(false);
  });

  it("reads the truthy spellings people actually type", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      expect(load({ BITBUCKET_ALLOW_WRITES: value }).allowWrites, value).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(load({ BITBUCKET_ALLOW_WRITES: value }).allowWrites, value).toBe(false);
    }
  });

  it("errors on an OAuth client id with no secret", () => {
    // Bitbucket Cloud has no PKCE, so a consumer id alone can never complete a login.
    // An incoherent combination IS an error, unlike missing credentials.
    expect(() => load({ BITBUCKET_OAUTH_CLIENT_ID: "id" })).toThrow(
      /BITBUCKET_OAUTH_CLIENT_SECRET/,
    );
  });

  it("errors on an OAuth secret with no client id", () => {
    expect(() => load({ BITBUCKET_OAUTH_CLIENT_SECRET: "s" })).toThrow(
      /no effect without BITBUCKET_OAUTH_CLIENT_ID/,
    );
  });

  it("errors on a repository with no workspace, since a slug is not unique alone", () => {
    expect(() => load({ BITBUCKET_REPOSITORY: "api" })).toThrow(/BITBUCKET_WORKSPACE/);
  });

  it("accepts a complete OAuth consumer", () => {
    const config = load({
      BITBUCKET_OAUTH_CLIENT_ID: "id",
      BITBUCKET_OAUTH_CLIENT_SECRET: "secret",
    });
    expect(config.authMethod).toBe("oauth");
    // Configured with only the consumer: the login may not have happened yet, and
    // reporting "not configured" would hide the very tool that fixes it.
    expect(isConfigured(config)).toBe(true);
  });
});

describe("loadConfig with a file", () => {
  let dir: string;
  let configPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-bitbucket-config-"));
    configPath = join(dir, "config.json");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (body: string): void => writeConfigAt(configPath, body);

  it("reads a config file when the env is silent", () => {
    writeConfig(JSON.stringify({ apiToken: "from-file", workspace: "acme" }));
    const config = load({}, configPath);
    expect(config.apiToken).toBe("from-file");
    expect(config.workspace).toBe("acme");
  });

  it("lets the env beat the file per field, not whole-source", () => {
    // Docker and CI inject the environment and must keep working, while a one-off
    // BITBUCKET_ALLOW_WRITES=0 still has to override a file that says true.
    writeConfig(JSON.stringify({ apiToken: "from-file", workspace: "acme", allowWrites: true }));
    const config = load({ BITBUCKET_ALLOW_WRITES: "0" }, configPath);
    expect(config.allowWrites).toBe(false);
    // The other fields still come from the file — the override is per field.
    expect(config.apiToken).toBe("from-file");
    expect(config.workspace).toBe("acme");
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A typo'd key that is silently ignored looks exactly like "that setting had no
    // effect", which is the worst way to learn your credentials came from elsewhere.
    writeConfig(JSON.stringify({ apiTokan: "typo" }));
    expect(() => load({}, configPath)).toThrow(/not valid/);
  });

  it("distinguishes a malformed file from a missing one", () => {
    writeConfig("{ not json");
    expect(() => load({}, configPath)).toThrow(/not valid JSON/);
  });

  it("treats a missing file as contributing nothing", () => {
    expect(() => load({}, join(dir, "does-not-exist.json"))).not.toThrow();
  });

  it("warns about a world-readable credentials file rather than refusing to start", () => {
    // A warning and not an error: refusing to start would be a worse trade for someone
    // on a single-user machine, and the file still works.
    const loose = join(dir, "loose.json");
    writeFileSync(loose, JSON.stringify({ apiToken: "t" }), { mode: 0o644 });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(load({}, loose).apiToken).toBe("t");
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toMatch(/readable by other users/);
  });
});

describe("inferAuthMethod", () => {
  it("returns undefined when there is nothing to infer from", () => {
    expect(inferAuthMethod({})).toBeUndefined();
  });

  it("ranks an access token first, then oauth, then an api token", () => {
    expect(inferAuthMethod({ accessToken: "a", oauthClientId: "b", apiToken: "c" })).toBe(
      "accessToken",
    );
    expect(inferAuthMethod({ oauthClientId: "b", apiToken: "c" })).toBe("oauth");
    expect(inferAuthMethod({ apiToken: "c" })).toBe("apiToken");
  });
});

describe("setupInstructions", () => {
  it("is empty once configured, so nothing nags a working server", () => {
    expect(setupInstructions(load({ BITBUCKET_API_TOKEN: "t" }))).toEqual([]);
  });

  it("names all three routes in, and the trap on each", () => {
    const text = setupInstructions(load({})).join("\n");
    expect(text).toMatch(/no Bitbucket scopes/); // the unscoped-token trap
    expect(text).toMatch(/localhost:8724\/callback/); // the callback URL that must match
    expect(text).toMatch(/no Atlassian account/); // what an access token cannot do
    expect(text).toMatch(/bb.*hosts\.yml|hosts\.yml/); // the shared CLI login
    expect(text).toMatch(/App passwords were removed/); // the option that no longer exists
  });
});

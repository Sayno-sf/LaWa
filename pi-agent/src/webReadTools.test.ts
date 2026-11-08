import assert from "node:assert/strict";
import test from "node:test";
import type { lookup } from "node:dns/promises";
import type { Octokit } from "@octokit/rest";

import { readPublicGitHubPath, readPublicWebPage, searchPublicGitHubRepositories } from "./webReadTools.js";

test("GitHub search returns bounded source-linked repository results", async () => {
  const octokit = { rest: { search: { repos: async () => ({ data: {
    total_count: 1,
    items: [{ full_name: "example/algorithms", description: "Examples", default_branch: "main", html_url: "https://github.com/example/algorithms", updated_at: "2026-09-25" }],
  } }) } } } as unknown as Octokit;
  const result = await searchPublicGitHubRepositories("algorithms", { octokit });
  assert.equal(result.totalCount, 1);
  assert.equal(result.repositories[0]?.url, "https://github.com/example/algorithms");
});

test("GitHub path lists a directory then reads text without cloning", async () => {
  let contents: unknown = [{ name: "README.md", path: "README.md", type: "file", html_url: "https://github.com/example/algorithms/blob/main/README.md" }];
  const octokit = { rest: { repos: { getContent: async () => ({ data: contents }) } } } as unknown as Octokit;
  const directory = await readPublicGitHubPath("example", "algorithms", "", undefined, { octokit });
  assert.equal(directory.kind, "directory");
  assert.equal(directory.entries?.[0]?.path, "README.md");
  contents = { type: "file", path: "README.md", sha: "abc", html_url: "https://github.com/example/algorithms/blob/main/README.md", size: 9, encoding: "base64", content: Buffer.from("# Example").toString("base64") };
  const file = await readPublicGitHubPath("example", "algorithms", "README.md", "main", { octokit });
  assert.equal(file.kind, "file");
  assert.equal(file.text, "# Example");
  assert.equal(file.sha, "abc");
});

test("web reader extracts article text but never executes page scripts", async () => {
  const html = `<html><head><title>Graph lesson</title></head><body><article><h1>Graph lesson</h1>${"<p>Shortest path algorithms explain how to choose the next node in a graph. </p>".repeat(12)}</article><script>globalThis.__untrustedRan = true</script></body></html>`;
  const fetchImpl = async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  const lookupImpl = async () => [{ address: "93.184.215.14", family: 4 }];
  const result = await readPublicWebPage("https://example.com/graph", {
    fetchImpl: fetchImpl as typeof fetch,
    lookupImpl: lookupImpl as unknown as typeof lookup,
  });
  assert.match(result.text, /Shortest path algorithms/);
  assert.equal(result.url, "https://example.com/graph");
  assert.equal((globalThis as Record<string, unknown>).__untrustedRan, undefined);
});

test("web reader rejects local targets and redirects before fetching them", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8000/api/learning/overview" } });
  };
  const lookupImpl = async () => [{ address: "93.184.215.14", family: 4 }];
  const options = { fetchImpl: fetchImpl as typeof fetch, lookupImpl: lookupImpl as unknown as typeof lookup };
  await assert.rejects(() => readPublicWebPage("http://127.0.0.1:8000/", options), /public HTTPS/);
  assert.equal(calls, 0);
  await assert.rejects(() => readPublicWebPage("https://example.com/", options), /public HTTPS/);
  assert.equal(calls, 1);
});

test("web reader rejects a hostname resolving to a private address", async () => {
  const fetchImpl = async () => { throw new Error("must not fetch"); };
  const lookupImpl = async () => [{ address: "192.168.1.10", family: 4 }];
  await assert.rejects(() => readPublicWebPage("https://internal.example.org/", {
    fetchImpl: fetchImpl as typeof fetch,
    lookupImpl: lookupImpl as unknown as typeof lookup,
  }), /private network/);
});

test("GitHub path rejects malformed owner and parent traversal", async () => {
  await assert.rejects(() => readPublicGitHubPath("example.com/evil", "repo", "README.md"), /Invalid GitHub/);
  await assert.rejects(() => readPublicGitHubPath("example", "repo", "../secret"), /Invalid GitHub/);
});

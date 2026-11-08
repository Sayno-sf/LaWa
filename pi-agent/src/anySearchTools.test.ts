import assert from "node:assert/strict";
import test from "node:test";

import { searchAnySearchWeb } from "./anySearchTools.js";

test("anonymous AnySearch search returns bounded public source links without credentials", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedInit = init;
    return new Response(JSON.stringify({ code: 0, data: { results: [
      { title: "Algorithm guide", url: "https://example.org/guide", snippet: "A".repeat(1_000), content: "Do not include full search content" },
      { title: "Internal", url: "http://127.0.0.1:8000/private", snippet: "reject" },
      { title: "Internal HTTPS", url: "https://127.0.0.1/private", snippet: "reject" },
    ], metadata: { total_results: 2 } } }), { headers: { "content-type": "application/json" } });
  };

  const result = await searchAnySearchWeb("  graph algorithms  ", { fetchImpl: fetchImpl as typeof fetch });
  assert.equal(requestedUrl, "https://api.anysearch.com/v1/search");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(new Headers(requestedInit?.headers).has("Authorization"), false);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), { query: "graph algorithms", max_results: 5 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.url, "https://example.org/guide");
  assert.equal(result.results[0]?.snippet.length, 800);
  assert.equal(JSON.stringify(result).includes("Do not include full search content"), false);
});

test("AnySearch quota response never exposes auto-generated credentials", async () => {
  const fetchImpl = async () => new Response("username=person\npassword=secret\napi_key=secret", { status: 402 });
  await assert.rejects(
    () => searchAnySearchWeb("graph algorithms", { fetchImpl: fetchImpl as typeof fetch }),
    (error: unknown) => {
      assert.match(String(error), /anonymous search quota/);
      assert.doesNotMatch(String(error), /secret|api_key|password/);
      return true;
    },
  );
});

test("AnySearch rejects malformed queries and oversized or invalid responses", async () => {
  const fetchImpl = async () => new Response("x".repeat(270_000), { headers: { "content-type": "application/json" } });
  await assert.rejects(() => searchAnySearchWeb(" ", { fetchImpl: fetchImpl as typeof fetch }), /2 to 180/);
  await assert.rejects(() => searchAnySearchWeb("graph algorithms", { fetchImpl: fetchImpl as typeof fetch }), /too large/);
  const malformed = async () => new Response(JSON.stringify({ code: 0, data: { results: "unexpected" } }));
  await assert.rejects(() => searchAnySearchWeb("graph algorithms", { fetchImpl: malformed as typeof fetch }), /invalid response/);
});

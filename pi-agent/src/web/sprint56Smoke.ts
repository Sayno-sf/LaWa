import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderSettingsService } from "./providerSettings.js";

const directory = mkdtempSync(join(tmpdir(), "lawa-sprint56-"));
let requests = 0;
let observedAuthorization = "";
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests += 1;
  observedAuthorization = request.headers.authorization ?? "";
  assert.match(request.url ?? "", /chat\/completions/);
  const payload = JSON.parse(body) as {
    model?: string;
    messages?: Array<{ role?: string }>;
    reasoning_effort?: string;
    max_tokens?: number;
    max_completion_tokens?: number;
  };
  assert.equal(payload.model, "fake-model");
  assert.equal(payload.reasoning_effort, "high");
  assert.equal(
    payload.messages?.[0]?.role,
    "system",
    "OpenAI-compatible requests must not assume the provider accepts developer role",
  );
  if (requests === 2) {
    assert.ok(
      (payload.max_tokens ?? payload.max_completion_tokens ?? 0) >= 32_768,
      "reasoning and the visible answer need more than the previous 8K shared output budget",
    );
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "fake-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "fake-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});

try {
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const settingsPath = join(directory, "provider-settings.json");
  const secretsPath = join(directory, "provider-secrets.json");
  const input = {
    provider: "sprint56-fake",
    model: "fake-model",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "smoke-secret-1234",
    thinkingLevel: "high" as const,
    maxOutputTokens: 32_768,
  };
  const service = new ProviderSettingsService({ settingsPath, secretsPath });
  const tested = await service.testConnection(input);
  assert.equal(tested.ok, true);
  assert.equal(observedAuthorization, "Bearer smoke-secret-1234");
  const saved = await service.saveAndUse(input);
  const firstProfileId = saved.settings.activeProfileId!;
  assert.equal(saved.settings.active.apiKeyHint, "••••1234");
  assert.equal(saved.settings.active.thinkingLevel, "high");
  const active = await service.getActiveRuntime();
  const agentProbe = await active.runtime.completeSimple(
    active.model,
    {
      systemPrompt: "You are a concise learning teacher.",
      messages: [{ role: "user", content: "Explain the topic.", timestamp: Date.now() }],
    },
    {
      ...(active.thinkingLevel === "off" ? {} : { reasoning: active.thinkingLevel }),
      maxRetries: 0,
    },
  );
  assert.equal(agentProbe.stopReason, "stop");
  await service.saveAndUse({
    ...input,
    name: "Second fake model",
    model: "fake-model-2",
    apiKey: "smoke-secret-5678",
  });
  const switched = await service.activate(firstProfileId);
  assert.equal(switched.settings.profiles.length, 2);
  assert.doesNotMatch(JSON.stringify(saved.settings), /smoke-secret/);
  assert.equal(requests, 2);

  const restarted = new ProviderSettingsService({ settingsPath, secretsPath });
  const restored = await restarted.getPublicSettings();
  assert.equal(restored.active.model, "fake-model");
  assert.equal(restored.active.thinkingLevel, "high");
  assert.equal(restored.active.hasApiKey, true);
  assert.equal(restored.profiles.length, 2);
  assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /smoke-secret/);
  assert.ok(existsSync(secretsPath));
  console.log("Sprint 5.6 smoke passed: reasoning effort, system-role compatibility, output budget, profiles, secrets, and restart restore.");
} finally {
  provider.close();
  if (provider.listening) await once(provider, "close");
  rmSync(directory, { recursive: true, force: true });
}

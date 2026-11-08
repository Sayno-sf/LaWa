import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { KernelSourceBackend } from "./backend.js";
import { RetrievalSettingsStore } from "./settings.js";
import { RetrievalRuntime } from "./runtime.js";

const runtimes = new Map<string, Promise<RetrievalRuntime>>();
export function getRetrievalRuntime(baseUrl = process.env.LEARNING_API_BASE_URL ?? "http://127.0.0.1:8000") {
  const data = fileURLToPath(new URL("../../../data/", import.meta.url));
  const isolated = baseUrl !== "http://127.0.0.1:8000"
    ? join(data, "retrieval-instances", createHash("sha256").update(baseUrl).digest("hex").slice(0,16)) : data;
  const root = process.env.LEARNING_RETRIEVAL_DIR?.trim() ? resolve(process.env.LEARNING_RETRIEVAL_DIR)
    : join(process.env.WEB_SESSION_DIR ? dirname(resolve(process.env.WEB_SESSION_DIR)) : isolated, "retrieval");
  const key = root + "|" + baseUrl;
  if (!runtimes.has(key)) runtimes.set(key, (async () => {
    const settings = new RetrievalSettingsStore(join(root, "settings.json"),
      process.env.PROVIDER_SETTINGS_PATH ? resolve(process.env.PROVIDER_SETTINGS_PATH) : join(data, "provider-settings.json"),
      process.env.PROVIDER_SECRETS_PATH ? resolve(process.env.PROVIDER_SECRETS_PATH) : join(data, "provider-secrets.json"));
    const runtime = new RetrievalRuntime(root, new KernelSourceBackend(baseUrl), settings);
    await runtime.start();
    return runtime;
  })());
  return runtimes.get(key)!;
}

import type { SourceBackend, SearchScope, FullContextInput, FullSourceIdentity } from "./types.js";
export class KernelSourceError extends Error {
  constructor(readonly code: string, readonly status: number) {super(`Source API HTTP ${status} (${code})`);}
}
export class KernelSourceBackend implements SourceBackend {
  constructor(private baseUrl: string, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, params: Record<string, string> = {}, body?: object, signal?: AbortSignal): Promise<any> {
    const response = await this.fetcher(this.baseUrl.replace(/\/$/, "") + "/api/learning/retrieval/" + path
      + "?" + new URLSearchParams(params), { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(path.startsWith("full-context") ? 30_000 : path === "visual-asset" ? 35_000 : 15_000), ...(signal ? [signal] : [])]) });
    const value = await response.json();
    if (!response.ok) throw new KernelSourceError(typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
      ? value.code : "SOURCE_API_FAILED", response.status);
    return value;
  }
  catalog(offset = 0) { return this.request("catalog", { offset: String(offset), limit: "100" }); }
  materialDeletions(offset = 0) {return this.request("material-deletions", {offset: String(offset), limit: "100"});}
  retryMaterialDeletion(id: string, signal?: AbortSignal) {return this.request(`material-deletions/${encodeURIComponent(id)}/retry`, {}, {}, signal);}
  fullContext(scope: SearchScope, input: FullContextInput, draft?: string | null, signal?: AbortSignal) {
    return this.request("full-context", {scope, ...(draft ? {draft_session_id: draft} : {})}, input, signal);
  }
  async validateFullContext(sources: FullSourceIdentity[], draft?: string | null, signal?: AbortSignal) {
    return (await this.request("full-context/validate", draft ? {draft_session_id: draft} : {}, {sources}, signal)).valid_sources;
  }
  visualPlan(materialId: string, fingerprint: string) { return this.request("visual-plan", {material_id: materialId, fingerprint}); }
  visualAsset(materialId: string, assetId: string) { return this.request("visual-asset", {material_id: materialId, asset_id: assetId}); }
  publishVisual(value: object) { return this.request("visual-result", {}, value); }
  chunks(sourceId: string, offset = 0) { return this.request("chunks", { source_id: sourceId, offset: String(offset), limit: "50" }); }
  context(query: string, scope: SearchScope, draft?: string | null) {
    return this.request("context", { query, scope, ...(draft ? { draft_session_id: draft } : {}) });
  }
  async validate(refs: string[], scope: SearchScope, draft?: string | null): Promise<string[]> {
    return (await this.request("validate", { scope, ...(draft ? { draft_session_id: draft } : {}) }, { refs })).valid_refs;
  }
  read(ref: string, scope: SearchScope, options: Record<string, string | number> = {}, draft?: string | null) {
    return this.request("read", { source_ref: ref, scope, ...Object.fromEntries(Object.entries(options).map(([k,v]) => [k,String(v)])),
      ...(draft ? { draft_session_id: draft } : {}) });
  }
}

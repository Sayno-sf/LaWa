export type SourceKind = "card" | "note" | "material";
export type SearchScope = "current" | "library";
export interface SourceDescriptor {
  source_id: string; kind: SourceKind; name: string; goal_id: string | null;
  goal_name: string; draft_session_id: string | null; skill_id: string; version: string;
  parse_status: "queued" | "processing" | "ready" | "failed";
  warnings: string[]; unit_count?: number; size_bytes?: number; visual_count?: number;
}
export interface SourceChunk {
  chunk_id: string; ordinal: number; text: string; heading: string | null;
  locator: { kind: string; start: number; end: number; char_start: number; char_end: number };
  source_ref: string; embedding_text: string; lexical_text: string; embedding_hash: string;
  retrieval_text?: string;
}
export interface IndexRow {
  id: string; source_id: string; source_version: string; kind: SourceKind; name: string;
  scope_id: string; goal_name: string; skill_id: string; chunk_id: string; ordinal: number;
  text: string; heading: string; locator_json: string; source_ref: string;
  lexical_text: string; embedding_hash: string; vector: number[]; has_vector: boolean;
}
export interface Candidate extends Omit<IndexRow, "vector"> {
  score: number; score_parts: Record<string, number>;
  graph_context?: GraphPath[];
}
export interface GraphPath { from: string; to: string; relation: string; quote: string; source_ref: string }
export interface VisualPlan { source_hash: string; parser_version: string; total: number; completed: number;
  assets: Array<{id: string; unit: number; label: string; context: string}> }
export interface RetrievalSettings {
  version: 1; enabled: boolean; profileId: string; embeddingModel: string; dimensions: number;
  embeddingUrl: string; rerankModel: string; rerankUrl: string; minimumRerankScore: number;
  visionEnabled?: boolean; graphEnabled?: boolean; visionModel?: string; extractionModel?: string;
}
export interface Models {
  analyzeVisual?(asset: {mime: string; data: string}, context: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  extractGraph?(chunks: Array<{chunk_id: string; text: string}>, signal?: AbortSignal): Promise<unknown>;
  refineQuery?(query: string, signal?: AbortSignal): Promise<string | null>;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  rerank(query: string, texts: string[], signal?: AbortSignal): Promise<Array<{ index: number; score: number }>>;
}
export interface SourceBackend {
  materialDeletions?(offset?: number): Promise<{version: 1; deletions: Array<{id: string; source_hash: string; original_cleanup: "pending" | "complete"}>;
    next_offset: number | null; catalog_version: string}>;
  retryMaterialDeletion?(id: string, signal?: AbortSignal): Promise<unknown>;
  fullContext?(scope: SearchScope, input: FullContextInput, draft?: string | null, signal?: AbortSignal): Promise<FullContextResult>;
  validateFullContext?(sources: FullSourceIdentity[], draft?: string | null, signal?: AbortSignal): Promise<FullSourceIdentity[]>;
  visualPlan?(materialId: string, fingerprint: string): Promise<VisualPlan>;
  visualAsset?(materialId: string, assetId: string): Promise<{mime: string; data: string}>;
  publishVisual?(value: object): Promise<unknown>;
  catalog(offset?: number): Promise<{ sources: SourceDescriptor[]; next_offset: number | null; catalog_version: string }>;
  chunks(sourceId: string, offset?: number): Promise<{ source: SourceDescriptor; chunks: SourceChunk[]; next_offset: number | null }>;
  context(query: string, scope: SearchScope, draft?: string | null): Promise<{ current_scope: string; allowed_scopes: string[]; lexical_query: string }>;
  validate(refs: string[], scope: SearchScope, draft?: string | null): Promise<string[]>;
  read(ref: string, scope: SearchScope, options?: Record<string, string | number>, draft?: string | null): Promise<Record<string, unknown>>;
}

export interface FullSourceIdentity { source_id: string; version: string; scope: SearchScope; current_scope: string }
export interface FullSourceRead {
  source: SourceDescriptor; text?: string; citation: string; citation_ref: string;
  scope: SearchScope; current_scope: string; already_in_context?: boolean;
  estimated_tokens: number; truncated: false;
  [key: string]: unknown;
}
export interface FullContextInput {
  max_tokens: number; available_tokens: number; known_sources: FullSourceIdentity[];
  material_id?: string; kinds?: SourceKind[];
}
export interface FullContextResult {
  mode: "full_context" | "rag"; reason?: string; scope: SearchScope; current_scope: string;
  sources: FullSourceRead[]; estimated_tokens?: number; new_tokens?: number; complete?: boolean; notice?: string;
}

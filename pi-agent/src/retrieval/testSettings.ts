import type {RetrievalSettings} from "./types.js";

export const testRetrievalSettings: RetrievalSettings = {
  version: 1, enabled: true, profileId: "p",
  embeddingModel: "test-embedding", embeddingUrl: "https://example.test/compatible-mode/v1/embeddings", dimensions: 64,
  rerankModel: "test-rerank", rerankUrl: "https://example.test/compatible-api/v1/reranks", minimumRerankScore: .5,
};

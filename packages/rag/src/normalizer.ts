import type { Evidence } from "@sre/evidence";
import type { RetrievalHit } from "./retriever-client.ts";

export function retrievalHitToEvidence(hit: RetrievalHit, options: { agentId: string; environment: string; requestId: string }): Evidence {
  return {
    id: `rag:${hit.documentId}:${hit.chunkId}`,
    kind: "wiki",
    source: hit.title,
    system: "wiki",
    environment: options.environment,
    ...(hit.sourceModifiedAt ? { sourceModifiedAt: hit.sourceModifiedAt } : {}),
    rawExcerpt: hit.content,
    confidence: Math.max(0, Math.min(1, hit.score)),
    citation: hit.citation,
    status: "ok",
    requestId: options.requestId,
    agentId: options.agentId,
  };
}

export function ragFailureEvidence(options: { agentId: string; environment: string; requestId: string; source?: string }): Evidence {
  return { id: `rag:${options.agentId}:missing`, kind: "missing", source: options.source ?? "wiki", system: "rag", environment: options.environment, citation: "RAG unavailable", status: "missing", requestId: options.requestId, agentId: options.agentId };
}

export function ragEmptyEvidence(options: { agentId: string; environment: string; requestId: string }): Evidence {
  return { id: `rag:${options.agentId}:empty`, kind: "wiki", source: "wiki", system: "rag", environment: options.environment, citation: `rag://${options.agentId}/query`, status: "empty", requestId: options.requestId, agentId: options.agentId };
}

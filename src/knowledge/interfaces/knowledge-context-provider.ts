/**
 * KnowledgeContextProvider — anti-corruption interface for organisational knowledge.
 *
 * Wraps: document stores, procedure registries, memory systems, org-specific context.
 * Read-oriented. The governance layer queries this for context to inform decisions;
 * it never drives execution directly.
 *
 * Substitution criteria:
 * - Retrieve documents/procedures by reference or search
 * - Return structured context with provenance metadata
 * - Support scoped queries (by domain, topic, recency)
 * - Be read-only from the governance layer's perspective
 */

export interface ContextRef {
  /** Unique identifier for this context item. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Content type (e.g. "document", "procedure", "memory", "conversation"). */
  kind: string;
  /** Source system or path. */
  source: string;
  /** Last modified timestamp. */
  updatedAt: string;
}

export interface ContextItem extends ContextRef {
  /** Full content body. */
  content: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
}

export interface ContextQuery {
  /** Free-text search query. */
  query?: string;
  /** Filter by content kind. */
  kind?: string;
  /** Filter by source system. */
  source?: string;
  /** Filter by domain relevance. */
  domain?: string;
  /** Maximum number of results. */
  limit?: number;
}

export interface KnowledgeContextProvider {
  /** Retrieve a specific context item by ID. */
  get(id: string): Promise<ContextItem | null>;

  /** Search for context items matching a query. */
  search(query: ContextQuery): Promise<ContextRef[]>;

  /** Retrieve full content for multiple items by ID. */
  getBatch(ids: string[]): Promise<ContextItem[]>;

  /** List available context sources (document stores, memory systems, etc). */
  listSources(): Promise<Array<{ name: string; kind: string; itemCount: number }>>;
}

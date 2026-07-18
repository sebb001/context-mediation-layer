/**
 * EventAuditBus — anti-corruption interface for operational event transport.
 *
 * Wraps: activity log, event fanout, live event streams.
 * Exposes events as transport, not meaning. The governance layer decides
 * what events mean; this interface only moves them.
 *
 * Substitution criteria:
 * - Emit structured events with type, source, and payload
 * - Subscribe to event streams with optional type filtering
 * - Query historical events with pagination
 * - Events are append-only and immutable once emitted
 */

export type EventId = string;

export interface RuntimeEvent {
  id: EventId;
  /** Event type (e.g. "invocation.started", "run.completed", "workspace.created"). */
  type: string;
  /** Source identifier (agent name, service name). */
  source: string;
  /** Structured payload. Schema depends on event type. */
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

export interface EventFilter {
  /** Filter by event type prefix (e.g. "invocation." matches all invocation events). */
  typePrefix?: string;
  /** Filter by source. */
  source?: string;
  /** Only events after this timestamp. */
  after?: string;
  /** Only events before this timestamp. */
  before?: string;
}

export interface EventPage {
  events: RuntimeEvent[];
  /** Cursor for next page. Null if no more events. */
  cursor: string | null;
}

export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;

export interface EventAuditBus {
  /** Emit a new event. Returns the assigned event ID. */
  emit(type: string, source: string, payload: Record<string, unknown>): Promise<EventId>;

  /** Query historical events with optional filtering and pagination. */
  query(filter?: EventFilter, cursor?: string, limit?: number): Promise<EventPage>;

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(filter: EventFilter, handler: EventHandler): () => void;
}

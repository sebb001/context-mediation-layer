import { randomUUID } from "node:crypto";
import type {
  EventAuditBus,
  EventFilter,
  EventHandler,
  EventId,
  EventPage,
  RuntimeEvent,
} from "../../interfaces/event-audit-bus.js";

/**
 * Local event/audit bus.
 *
 * This provides a small activity log and live-event fanout without importing
 * broader ontology into the interface boundary.
 *
 * The provider stays intentionally narrow:
 * - append-only event storage
 * - immutable emitted records
 * - simple filtered live subscriptions
 * - cursor pagination over event history
 */

type StoredEvent = Readonly<RuntimeEvent>;

function cloneEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    ...event,
    payload: { ...event.payload },
  };
}

function matchesFilter(event: RuntimeEvent, filter: EventFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.typePrefix && !event.type.startsWith(filter.typePrefix)) return false;
  if (filter.source && event.source !== filter.source) return false;
  if (filter.after && event.timestamp <= filter.after) return false;
  if (filter.before && event.timestamp >= filter.before) return false;
  return true;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Number.parseInt(cursor, 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function encodeCursor(index: number): string {
  return String(index);
}

export interface LocalEventAuditBusOptions {
  now?: () => string;
  idFactory?: () => EventId;
}

export function createLocalEventAuditBus(
  options: LocalEventAuditBusOptions = {},
): EventAuditBus {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;
  const events: StoredEvent[] = [];
  const subscribers = new Set<{ filter: EventFilter; handler: EventHandler }>();

  async function emit(type: string, source: string, payload: Record<string, unknown>): Promise<EventId> {
    const event: StoredEvent = Object.freeze({
      id: idFactory(),
      type,
      source,
      payload: Object.freeze({ ...payload }),
      timestamp: now(),
    });
    events.push(event);

    for (const subscriber of subscribers) {
      if (!matchesFilter(event, subscriber.filter)) continue;
      void Promise.resolve(subscriber.handler(cloneEvent(event))).catch(() => {});
    }

    return event.id;
  }

  async function query(
    filter: EventFilter = {},
    cursor?: string,
    limit = 100,
  ): Promise<EventPage> {
    const filtered = events.filter((event) => matchesFilter(event, filter));
    const start = decodeCursor(cursor);
    const pageSize = Math.max(0, limit);
    const pageEvents = filtered.slice(start, start + pageSize).map(cloneEvent);
    const nextIndex = start + pageEvents.length;

    return {
      events: pageEvents,
      cursor: nextIndex < filtered.length ? encodeCursor(nextIndex) : null,
    };
  }

  function subscribe(filter: EventFilter, handler: EventHandler): () => void {
    const subscriber = { filter, handler };
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  return {
    emit,
    query,
    subscribe,
  };
}

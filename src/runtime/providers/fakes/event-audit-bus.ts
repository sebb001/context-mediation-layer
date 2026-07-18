import type {
  EventAuditBus,
  EventFilter,
  EventHandler,
  EventId,
  EventPage,
  RuntimeEvent,
} from "../../interfaces/event-audit-bus.js";

function matchesFilter(event: RuntimeEvent, filter: EventFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.typePrefix && !event.type.startsWith(filter.typePrefix)) return false;
  if (filter.source && event.source !== filter.source) return false;
  if (filter.after && event.timestamp <= filter.after) return false;
  if (filter.before && event.timestamp >= filter.before) return false;
  return true;
}

export function createFakeEventAuditBus(seedEvents: RuntimeEvent[] = []): EventAuditBus {
  const events = seedEvents.map((event) => ({
    ...event,
    payload: { ...event.payload },
  }));
  const subscribers = new Set<{ filter: EventFilter; handler: EventHandler }>();

  return {
    async emit(type: string, source: string, payload: Record<string, unknown>): Promise<EventId> {
      const event: RuntimeEvent = {
        id: `fake-${events.length + 1}`,
        type,
        source,
        payload: { ...payload },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, events.length)).toISOString(),
      };
      events.push(event);
      for (const subscriber of subscribers) {
        if (!matchesFilter(event, subscriber.filter)) continue;
        void Promise.resolve(subscriber.handler({
          ...event,
          payload: { ...event.payload },
        })).catch(() => {});
      }
      return event.id;
    },

    async query(filter: EventFilter = {}, cursor?: string, limit = 100): Promise<EventPage> {
      const filtered = events.filter((event) => matchesFilter(event, filter));
      const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
      const pageEvents = filtered.slice(start, start + Math.max(0, limit)).map((event) => ({
        ...event,
        payload: { ...event.payload },
      }));
      const next = start + pageEvents.length;
      return {
        events: pageEvents,
        cursor: next < filtered.length ? String(next) : null,
      };
    },

    subscribe(filter: EventFilter, handler: EventHandler): () => void {
      const subscriber = { filter, handler };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

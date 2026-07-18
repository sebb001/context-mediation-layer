import { describe, expect, it, vi } from "vitest";
import type { EventAuditBus } from "../../src/runtime/interfaces/event-audit-bus.js";
import {
  createFakeEventAuditBus,
  createLocalEventAuditBus,
} from "../../src/runtime/providers/index.js";

async function runEventAuditBusContract(name: string, factory: () => EventAuditBus) {
  describe(name, () => {
    it("emits append-only immutable events and returns event ids", async () => {
      const bus = factory();
      const eventId = await bus.emit("invocation.started", "agent.alpha", { run: 1 });
      const page = await bus.query();

      expect(eventId).toBeTruthy();
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.id).toBe(eventId);
      expect(page.events[0]?.type).toBe("invocation.started");
      expect(page.events[0]?.source).toBe("agent.alpha");
      expect(page.events[0]?.payload).toEqual({ run: 1 });

      page.events[0]!.payload.run = 999;
      const reread = await bus.query();
      expect(reread.events[0]?.payload).toEqual({ run: 1 });
    });

    it("filters history by type prefix and source", async () => {
      const bus = factory();
      await bus.emit("invocation.started", "agent.alpha", {});
      await bus.emit("invocation.completed", "agent.alpha", {});
      await bus.emit("workspace.created", "workspace.service", {});

      const invocationOnly = await bus.query({ typePrefix: "invocation." });
      const agentOnly = await bus.query({ source: "agent.alpha" });

      expect(invocationOnly.events).toHaveLength(2);
      expect(agentOnly.events).toHaveLength(2);
      expect(agentOnly.events.every((event) => event.source === "agent.alpha")).toBe(true);
    });

    it("paginates using opaque cursor strings", async () => {
      const bus = factory();
      await bus.emit("event.1", "source", {});
      await bus.emit("event.2", "source", {});
      await bus.emit("event.3", "source", {});

      const firstPage = await bus.query({}, undefined, 2);
      expect(firstPage.events).toHaveLength(2);
      expect(firstPage.cursor).not.toBeNull();

      const secondPage = await bus.query({}, firstPage.cursor ?? undefined, 2);
      expect(secondPage.events).toHaveLength(1);
      expect(secondPage.events[0]?.type).toBe("event.3");
      expect(secondPage.cursor).toBeNull();
    });

    it("supports filtered live subscriptions and unsubscribe", async () => {
      const bus = factory();
      const handler = vi.fn();
      const unsubscribe = bus.subscribe({ typePrefix: "invocation." }, handler);

      await bus.emit("workspace.created", "workspace.service", {});
      await bus.emit("invocation.started", "agent.alpha", { run: 1 });
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        type: "invocation.started",
        source: "agent.alpha",
      });

      unsubscribe();
      await bus.emit("invocation.completed", "agent.alpha", { run: 1 });
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
}

describe("EventAuditBus contract", async () => {
  await runEventAuditBusContract("fake provider", () => createFakeEventAuditBus());
  await runEventAuditBusContract("local provider", () =>
    createLocalEventAuditBus({
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `local-${++counter}`;
      })(),
    }),
  );
});

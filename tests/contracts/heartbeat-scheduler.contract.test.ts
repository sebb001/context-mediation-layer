import { describe, expect, it } from "vitest";
import type { HeartbeatScheduler } from "../../src/runtime/interfaces/heartbeat-scheduler.js";
import {
  createFakeEventAuditBus,
  createFakeHeartbeatScheduler,
  createLocalHeartbeatScheduler,
} from "../../src/runtime/providers/index.js";

function runHeartbeatSchedulerContract(name: string, factory: () => HeartbeatScheduler) {
  describe(name, () => {
    it("creates schedules and lists them", async () => {
      const scheduler = factory();
      const scheduleId = await scheduler.upsertSchedule({
        agent: "agent.alpha",
        task: "Check open work",
        interval: "*/5 * * * *",
        workspaceRef: "ws-main",
        enabled: true,
      });

      const schedules = await scheduler.listSchedules();
      expect(scheduleId).toBeTruthy();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        id: scheduleId,
        agent: "agent.alpha",
        task: "Check open work",
      });
    });

    it("reuses a stable schedule id on upsert for the same schedule identity", async () => {
      const scheduler = factory();
      const id1 = await scheduler.upsertSchedule({
        agent: "agent.alpha",
        task: "Check open work",
        enabled: true,
      });
      const id2 = await scheduler.upsertSchedule({
        agent: "agent.alpha",
        task: "Check open work",
        interval: 60000,
        enabled: false,
      });

      expect(id2).toBe(id1);
      const schedules = await scheduler.listSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.enabled).toBe(false);
    });

    it("creates a session and run history when triggered", async () => {
      const scheduler = factory();
      const scheduleId = await scheduler.upsertSchedule({
        agent: "agent.alpha",
        task: "Check open work",
        enabled: true,
      });

      const runId = await scheduler.triggerNow(scheduleId);
      const session = await scheduler.getSession(scheduleId);
      const runs = await scheduler.listRuns(scheduleId);

      expect(runId).toBeTruthy();
      expect(session).not.toBeNull();
      expect(session?.runCount).toBe(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: runId,
        scheduleId,
        sessionId: session?.id,
        status: "completed",
      });
    });

    it("removes schedules and associated sessions/runs", async () => {
      const scheduler = factory();
      const scheduleId = await scheduler.upsertSchedule({
        agent: "agent.alpha",
        task: "Check open work",
        enabled: true,
      });
      await scheduler.triggerNow(scheduleId);

      await scheduler.removeSchedule(scheduleId);

      expect(await scheduler.listSchedules()).toHaveLength(0);
      expect(await scheduler.getSession(scheduleId)).toBeNull();
      expect(await scheduler.listRuns(scheduleId)).toEqual([]);
    });
  });
}

describe("HeartbeatScheduler contract", () => {
  runHeartbeatSchedulerContract("fake provider", () => createFakeHeartbeatScheduler());

  runHeartbeatSchedulerContract("local provider", () =>
    createLocalHeartbeatScheduler({
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `hb-${++counter}`;
      })(),
      eventBus: createFakeEventAuditBus(),
    }),
  );
});

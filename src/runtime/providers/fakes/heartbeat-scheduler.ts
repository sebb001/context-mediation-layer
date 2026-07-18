import type {
  HeartbeatScheduler,
  RunId,
  RunRecord,
  ScheduleId,
  ScheduleSpec,
  SessionInfo,
} from "../../interfaces/heartbeat-scheduler.js";

type FakeSchedule = ScheduleSpec & { id: ScheduleId };

export function createFakeHeartbeatScheduler(): HeartbeatScheduler {
  const schedules = new Map<ScheduleId, FakeSchedule>();
  const sessions = new Map<ScheduleId, SessionInfo>();
  const runs = new Map<ScheduleId, RunRecord[]>();
  let nextId = 1;

  function newId(prefix: string): string {
    return `${prefix}-${nextId++}`;
  }

  return {
    async upsertSchedule(spec: ScheduleSpec): Promise<ScheduleId> {
      const existing = Array.from(schedules.values()).find(
        (schedule) =>
          schedule.agent === spec.agent &&
          schedule.task === spec.task &&
          schedule.workspaceRef === spec.workspaceRef,
      );

      if (existing) {
        schedules.set(existing.id, { ...existing, ...spec });
        return existing.id;
      }

      const id = newId("schedule");
      schedules.set(id, { ...spec, id });
      return id;
    },

    async removeSchedule(id: ScheduleId): Promise<void> {
      schedules.delete(id);
      sessions.delete(id);
      runs.delete(id);
    },

    async listSchedules(): Promise<Array<ScheduleSpec & { id: ScheduleId }>> {
      return Array.from(schedules.values()).map((schedule) => ({ ...schedule }));
    },

    async getSession(scheduleId: ScheduleId): Promise<SessionInfo | null> {
      const session = sessions.get(scheduleId);
      return session ? { ...session } : null;
    },

    async listRuns(scheduleId: ScheduleId, limit = 20): Promise<RunRecord[]> {
      return (runs.get(scheduleId) ?? [])
        .slice(-Math.max(0, limit))
        .reverse()
        .map((run) => ({
          ...run,
          usage: run.usage ? { ...run.usage } : undefined,
        }));
    },

    async triggerNow(scheduleId: ScheduleId): Promise<RunId> {
      if (!schedules.has(scheduleId)) {
        throw new Error(`Unknown schedule: ${scheduleId}`);
      }

      const session =
        sessions.get(scheduleId) ??
        {
          id: newId("session"),
          scheduleId,
          runCount: 0,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, nextId)).toISOString(),
        };

      session.runCount += 1;
      session.lastRunAt = new Date(Date.UTC(2026, 0, 1, 0, 0, nextId)).toISOString();
      sessions.set(scheduleId, session);

      const run: RunRecord = {
        id: newId("run"),
        scheduleId,
        sessionId: session.id,
        status: "completed",
        startedAt: session.lastRunAt,
        completedAt: session.lastRunAt,
        output: "fake-complete",
      };

      const scheduleRuns = runs.get(scheduleId) ?? [];
      scheduleRuns.push(run);
      runs.set(scheduleId, scheduleRuns);
      return run.id;
    },
  };
}

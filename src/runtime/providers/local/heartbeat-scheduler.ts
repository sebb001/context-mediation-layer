import { randomUUID } from "node:crypto";
import type {
  HeartbeatScheduler,
  RunId,
  RunRecord,
  RunStatus,
  ScheduleId,
  ScheduleSpec,
  SessionId,
  SessionInfo,
} from "../../interfaces/heartbeat-scheduler.js";
import type { EventAuditBus } from "../../interfaces/event-audit-bus.js";

type StoredSchedule = ScheduleSpec & { id: ScheduleId };

interface StoredSession extends SessionInfo {}

interface LocalHeartbeatSchedulerOptions {
  now?: () => string;
  idFactory?: () => string;
  eventBus?: EventAuditBus;
}

function cloneSchedule(schedule: StoredSchedule): StoredSchedule {
  return { ...schedule };
}

function cloneSession(session: StoredSession): StoredSession {
  return { ...session };
}

function cloneRun(run: RunRecord): RunRecord {
  return {
    ...run,
    usage: run.usage ? { ...run.usage } : undefined,
  };
}

/**
 * Local heartbeat scheduler.
 *
 * This provides a narrow heartbeat substrate:
 * - stable schedule registry
 * - per-schedule session tracking
 * - append-only run history
 * - event emission for run lifecycle
 *
 * It intentionally stops short of work graph semantics.
 */
export function createLocalHeartbeatScheduler(
  options: LocalHeartbeatSchedulerOptions = {},
): HeartbeatScheduler {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;
  const schedules = new Map<ScheduleId, StoredSchedule>();
  const sessions = new Map<ScheduleId, StoredSession>();
  const runs = new Map<ScheduleId, RunRecord[]>();

  async function emitRunEvent(type: string, run: RunRecord): Promise<void> {
    if (!options.eventBus) return;
    await options.eventBus.emit(type, "heartbeat.scheduler", {
      runId: run.id,
      scheduleId: run.scheduleId,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
  }

  async function upsertSchedule(spec: ScheduleSpec): Promise<ScheduleId> {
    const existing = Array.from(schedules.values()).find(
      (schedule) =>
        schedule.agent === spec.agent &&
        schedule.task === spec.task &&
        schedule.workspaceRef === spec.workspaceRef,
    );

    if (existing) {
      schedules.set(existing.id, { ...existing, ...spec, id: existing.id });
      return existing.id;
    }

    const scheduleId = idFactory();
    schedules.set(scheduleId, { ...spec, id: scheduleId });
    return scheduleId;
  }

  async function removeSchedule(id: ScheduleId): Promise<void> {
    schedules.delete(id);
    sessions.delete(id);
    runs.delete(id);
  }

  async function listSchedules(): Promise<Array<ScheduleSpec & { id: ScheduleId }>> {
    return Array.from(schedules.values()).map(cloneSchedule);
  }

  async function getSession(scheduleId: ScheduleId): Promise<SessionInfo | null> {
    const session = sessions.get(scheduleId);
    return session ? cloneSession(session) : null;
  }

  async function listRuns(scheduleId: ScheduleId, limit = 20): Promise<RunRecord[]> {
    const scheduleRuns = runs.get(scheduleId) ?? [];
    return scheduleRuns.slice(-Math.max(0, limit)).reverse().map(cloneRun);
  }

  async function triggerNow(scheduleId: ScheduleId): Promise<RunId> {
    const schedule = schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Unknown schedule: ${scheduleId}`);
    }

    const timestamp = now();
    const session =
      sessions.get(scheduleId) ??
      {
        id: idFactory() as SessionId,
        scheduleId,
        runCount: 0,
        createdAt: timestamp,
      };

    session.runCount += 1;
    session.lastRunAt = timestamp;
    sessions.set(scheduleId, session);

    const run: RunRecord = {
      id: idFactory() as RunId,
      scheduleId,
      sessionId: session.id,
      status: "completed" satisfies RunStatus,
      startedAt: timestamp,
      completedAt: now(),
      output: `Triggered ${schedule.agent}`,
    };

    const scheduleRuns = runs.get(scheduleId) ?? [];
    scheduleRuns.push(run);
    runs.set(scheduleId, scheduleRuns);

    await emitRunEvent("heartbeat.run.completed", run);
    return run.id;
  }

  return {
    upsertSchedule,
    removeSchedule,
    listSchedules,
    getSession,
    listRuns,
    triggerNow,
  };
}

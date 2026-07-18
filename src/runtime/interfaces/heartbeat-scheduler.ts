/**
 * HeartbeatScheduler — anti-corruption interface for scheduled agent invocation.
 *
 * Wraps: heartbeat engine, session management, run lifecycle, process recovery.
 * CML vocabulary only. No issue/project/company concepts cross this boundary.
 *
 * Substitution criteria:
 * - Schedule recurring or one-shot agent invocations
 * - Manage invocation sessions (create, compact, resume)
 * - Track run lifecycle (start, complete, fail, recover)
 * - Emit run events for audit consumption
 */

export type ScheduleId = string;
export type SessionId = string;
export type RunId = string;

export interface ScheduleSpec {
  /** Which agent to invoke. */
  agent: string;
  /** Task description template. */
  task: string;
  /** Cron expression or interval in milliseconds. Null = one-shot. */
  interval?: string | number | null;
  /** Optional workspace reference for execution context. */
  workspaceRef?: string;
  /** Whether the schedule is active. */
  enabled: boolean;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "recovered";

export interface RunRecord {
  id: RunId;
  scheduleId: ScheduleId;
  sessionId: SessionId;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  /** Token/cost usage. */
  usage?: { inputTokens?: number; outputTokens?: number; costCents?: number };
  /** Summary output from the run. */
  output?: string;
  error?: string;
}

export interface SessionInfo {
  id: SessionId;
  scheduleId: ScheduleId;
  runCount: number;
  createdAt: string;
  lastRunAt?: string;
}

export interface HeartbeatScheduler {
  /** Create or update a schedule. */
  upsertSchedule(spec: ScheduleSpec): Promise<ScheduleId>;

  /** Remove a schedule. */
  removeSchedule(id: ScheduleId): Promise<void>;

  /** List all schedules. */
  listSchedules(): Promise<Array<ScheduleSpec & { id: ScheduleId }>>;

  /** Get the current session for a schedule. */
  getSession(scheduleId: ScheduleId): Promise<SessionInfo | null>;

  /** List recent runs for a schedule. */
  listRuns(scheduleId: ScheduleId, limit?: number): Promise<RunRecord[]>;

  /** Trigger an immediate run of a schedule (outside its interval). */
  triggerNow(scheduleId: ScheduleId): Promise<RunId>;
}

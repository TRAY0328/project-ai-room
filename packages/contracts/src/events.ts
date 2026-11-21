/**
 * WebSocket / realtime event contract — spec 19.3, 35.2, 35.4
 *
 *  - Event names are `noun.past_tense` and versioned by `schema_version`.
 *  - The server builds the envelope; `actor`, `received_at` and `revision`
 *    from a client are ignored/rejected.
 *  - `room_seq` (assigned by the Room Durable Object) is the only ordering
 *    authority for messages. A client that detects a gap must resync over
 *    HTTPS `GET /v1/rooms/{roomId}/events?cursor=`, never guess.
 *  - Unknown event types are ignored by consumers; unknown *versions* force an
 *    explicit resync.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "./time.js";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EVENT_TYPES = [
  // rooms & messages
  "room.created",
  "room.member.joined",
  "room.member.left",
  "room.message.created",
  "room.message.updated",
  "room.message.deleted",
  "room.message.restored",
  "message.version.created",
  "message.reaction.added",
  "message.delivery.acknowledged",
  // projects & tasks
  "project.created",
  "project.updated",
  "task.created",
  "task.claimed",
  "task.status.changed",
  "task.completed",
  "task.handoff.completed",
  "task.checkpoint.created",
  "project.metrics.updated",
  "project.report.created",
  // code, CI, artifacts
  "document.updated",
  "git.branch.created",
  "git.commit.created",
  "git.pull_request.opened",
  "git.review.submitted",
  "git.pull_request.merged",
  "job.queued",
  "job.started",
  "job.succeeded",
  "job.failed",
  "job.cancelled",
  "artifact.verified",
  // memory, files, approvals, providers, sessions
  "memory.created",
  "file.uploaded",
  "file.scan.completed",
  "approval.requested",
  "approval.resolved",
  "approval.invalidated",
  "provider.connection.verified",
  "provider.connection.revoked",
  "agent.presence.changed",
  "session.resumed",
  "session.expired",
  "alert.raised",
  "emergency_stop.engaged",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const zEventType = z.enum(EVENT_TYPES);

export const zEventActor = z.object({
  type: z.enum(["owner", "agent", "system"]),
  id: z.string().min(1),
});

export const zEventAggregate = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
});

export const zEventScope = z.object({
  room_id: z.string().min(1).nullable(),
  project_id: z.string().min(1).nullable(),
});

/**
 * Full envelope (spec 35.2). `received_at` is server-set; sending it from a
 * client is allowed syntactically but always overwritten server-side.
 */
export const zEventEnvelope = z.object({
  event_id: z.string().min(1),
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_type: zEventType,
  occurred_at: zUtcIsoMillis,
  received_at: zUtcIsoMillis,
  actor: zEventActor,
  aggregate: zEventAggregate,
  scope: zEventScope,
  correlation_id: z.string().min(1),
  causation_id: z.string().min(1).nullable(),
  idempotency_key: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof zEventEnvelope>;

/** The 19.3 example shape, kept as a separate schema for gateway fan-out. */
export const zWireEvent = z.object({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_id: z.string().min(1),
  type: zEventType,
  project_id: z.string().min(1).nullable(),
  room_id: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  correlation_id: z.string().min(1),
  occurred_at: zUtcIsoMillis,
  payload: z.record(z.string(), z.unknown()),
});

export type WireEvent = z.infer<typeof zWireEvent>;

/** Typed payloads for the events that carry stable fields. */
export const zTaskStatusPayload = z.object({
  task_id: z.string().min(1),
  status: z.enum([
    "proposed",
    "claimed",
    "in_progress",
    "blocked",
    "review_pending",
    "completed",
    "cancelled",
  ]),
  attempt_id: z.string().min(1).nullable(),
  fencing_generation: z.number().int().nonnegative(),
});

export const zMessageCreatedPayload = z.object({
  message_id: z.string().min(1),
  seq: z.number().int().positive(),
  author_kind: z.enum(["owner", "agent", "system"]),
  author_id: z.string().min(1),
  revision: z.number().int().positive(),
});

/** Ephemeral WebSocket ticket claims (spec 33.1 #5). Never a long-lived secret. */
export const zWsTicketClaims = z.object({
  ticket_id: z.string().min(1),
  subject_kind: z.enum(["owner", "agent"]),
  subject_id: z.string().min(1),
  room_id: z.string().min(1).nullable(),
  project_id: z.string().min(1).nullable(),
  permissions: z.array(z.string().min(1)).min(1),
  issued_at: zUtcIsoMillis,
  expires_at: zUtcIsoMillis,
  nonce: z.string().min(16),
});

export type WsTicketClaims = z.infer<typeof zWsTicketClaims>;

/** Client -> server frames. */
export const zClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HELLO"),
    ticket_id: z.string().min(1),
    last_seen_seq: z.number().int().nonnegative().nullable(),
    client_capabilities: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("PING"), sent_at: zUtcIsoMillis }),
  z.object({
    type: z.literal("ACK"),
    event_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("RESYNC_NEEDED"),
    reason: z.enum(["gap", "version_unknown", "permission_changed"]),
  }),
]);

export type ClientFrame = z.infer<typeof zClientFrame>;

/** Server -> client frames. */
export const zServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HELLO_OK"),
    session_id: z.string().min(1),
    resumed_from_seq: z.number().int().nonnegative().nullable(),
    latest_seq: z.number().int().nonnegative(),
    server_time: zUtcIsoMillis,
  }),
  z.object({
    type: z.literal("SNAPSHOT_REQUIRED"),
    reason: z.enum(["gap_too_large", "no_cursor", "tombstoned", "permission_changed"]),
    latest_seq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("EVENT"), event: zWireEvent }),
  z.object({ type: z.literal("PONG"), sent_at: zUtcIsoMillis }),
  z.object({
    type: z.literal("ERROR"),
    code: z.string().min(1),
    retryable: z.boolean(),
    request_id: z.string().min(1),
  }),
  z.object({ type: z.literal("CLOSE"), reason: z.enum(["revoked", "expired", "room_deleted", "heartbeat_timeout"]) }),
]);

export type ServerFrame = z.infer<typeof zServerFrame>;

/** Message send state machine (spec 35.3) — "sent" only after PERSISTED. */
export const MESSAGE_SEND_STATES = [
  "DRAFT",
  "VALIDATING",
  "ACCEPTED",
  "PERSISTED",
  "DISTRIBUTING",
  "CONFIRMED",
  "REJECTED",
  "RETRYABLE",
  "DEAD_LETTER",
  "CANCELLED",
] as const;
export type MessageSendState = (typeof MESSAGE_SEND_STATES)[number];

/** Delivery/read truth (spec 35.1): never claim READ without provider proof. */
export const DELIVERY_STATES = [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "ACKNOWLEDGED_BY_AGENT",
  "READ_CONFIRMED",
  "FAILED",
  "UNSUPPORTED",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface ResyncPlan {
  readonly mode: "replay" | "snapshot_required";
  readonly fromSeq: number | null;
  readonly reason: "replay" | "no_cursor" | "gap_too_large" | "tombstoned" | "permission_changed";
}

/**
 * Decides how a reconnecting client recovers (spec 35.4). A gap larger than
 * `maxReplay` forces an HTTPS snapshot instead of an unbounded replay.
 */
export function planResync(
  lastSeenSeq: number | null,
  latestSeq: number,
  maxReplay = 500,
): ResyncPlan {
  if (lastSeenSeq === null) return { mode: "snapshot_required", fromSeq: null, reason: "no_cursor" };
  if (lastSeenSeq > latestSeq) return { mode: "snapshot_required", fromSeq: null, reason: "gap_too_large" };
  if (latestSeq - lastSeenSeq > maxReplay) {
    return { mode: "snapshot_required", fromSeq: null, reason: "gap_too_large" };
  }
  return { mode: "replay", fromSeq: lastSeenSeq, reason: "replay" };
}

/**
 * Room realtime plumbing (spec 19.3, 35.2).
 *
 * Two directions, one owner:
 *  - a browser cannot put an `Authorization` header on a WebSocket, so the
 *    gateway authenticates the upgrade from the `air_session` cookie, mints the
 *    short-lived room ticket the Durable Object requires, and forwards the
 *    upgrade. Without this the client's `wss://…/events` had nothing to talk to
 *    and the UI could only ever say "재연결 중".
 *  - after D1 commits a message, the gateway hands the persisted row and the
 *    event envelope to the Room DO so already-connected clients receive it
 *    without a reload. A broadcast failure never fails the write: the message is
 *    already durable and clients recover the gap over HTTPS.
 */
import type { AuthService } from "@ai-room/auth";
import type { Subject, WireEvent } from "@ai-room/contracts";
import type { DurableObjectStubLike, Env } from "./env.js";

export function roomStub(env: Env, roomId: string): DurableObjectStubLike | null {
  const namespace = env.ROOM_DO;
  if (namespace === undefined) return null;
  return namespace.get(namespace.idFromName(roomId));
}

/** Mints the room ticket that both the upgrade and the broadcast hand-off use. */
export async function mintRoomTicket(
  auth: AuthService,
  env: Env,
  input: {
    readonly subject: Subject;
    readonly room_id: string;
    readonly project_id: string | null;
    readonly acl_revision: number;
    readonly request_id: string;
  },
): Promise<string> {
  void env;
  const issued = await auth.issueWsTicket({
    // `system` never holds a room ticket; the caller is always an owner or an agent.
    subject: input.subject,
    room_id: input.room_id,
    project_id: input.project_id,
    permissions: ["ws.subscribe", "room.message.read", "room.message.create"],
    acl_revision: input.acl_revision,
    request_id: input.request_id,
  });
  return issued.ticket;
}

/**
 * Forwards a browser WebSocket upgrade to the Room DO.
 *
 * The original request goes through untouched: rebuilding it would detach the
 * upgrade from the client connection, which Cloudflare then closes as an
 * abnormal 1006. The DO reads the room from the path and authenticates the
 * session cookie/bearer it already carries.
 */
export async function forwardRoomUpgrade(env: Env, input: { readonly roomId: string; readonly request: Request }): Promise<Response | null> {
  const stub = roomStub(env, input.roomId);
  if (stub === null) return null;
  return stub.fetch(input.request);
}

/**
 * Fans out one persisted message. Called after the D1 write; any failure here is
 * swallowed on purpose (the row is durable either way, and the client's cursor
 * resync repairs a missed frame).
 */
export async function publishPersistedMessage(  env: Env,
  auth: AuthService,
  input: {
    readonly roomId: string;
    readonly projectId: string | null;
    readonly subject: Subject;
    readonly aclRevision: number;
    readonly requestId: string;
    readonly event: WireEvent;
    readonly row: { message_id: string; room_seq: number; author_kind: "owner" | "agent" | "system"; author_id: string; revision: number };
  },
): Promise<number> {
  const stub = roomStub(env, input.roomId);
  if (stub === null) return 0;
  if (input.subject.kind === "system") return 0;
  try {
    const ticket = await mintRoomTicket(auth, env, {
      subject: input.subject,
      room_id: input.roomId,
      project_id: input.projectId,
      acl_revision: input.aclRevision,
      request_id: input.requestId,
    });
    const target = new URL(`https://room-do.internal/rooms/${encodeURIComponent(input.roomId)}/broadcast`);
    target.searchParams.set("ticket", ticket);
    const response = await stub.fetch(
      new Request(target.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ row: input.row, event: input.event }),
      }),
    );
    if (!response.ok) return 0;
    const body = (await response.json().catch(() => ({}))) as { delivered?: number };
    return typeof body.delivered === "number" ? body.delivered : 0;
  } catch {
    return 0;
  }
}

/**
 * Fans out a realtime-only notice (a read mark) to the sockets already in the
 * room. Unlike a message it carries no room_seq: the DO sends it without
 * touching the ordering state, and a client that missed it recovers the read
 * truth from the next page instead of from replay.
 */
export async function publishRoomNotice(
  env: Env,
  auth: AuthService,
  input: {
    readonly roomId: string;
    readonly projectId: string | null;
    readonly subject: Subject;
    readonly aclRevision: number;
    readonly requestId: string;
    readonly event: WireEvent;
  },
): Promise<number> {
  const stub = roomStub(env, input.roomId);
  if (stub === null) return 0;
  if (input.subject.kind === "system") return 0;
  try {
    const ticket = await mintRoomTicket(auth, env, {
      subject: input.subject,
      room_id: input.roomId,
      project_id: input.projectId,
      acl_revision: input.aclRevision,
      request_id: input.requestId,
    });
    const target = new URL(`https://room-do.internal/rooms/${encodeURIComponent(input.roomId)}/notice`);
    target.searchParams.set("ticket", ticket);
    const response = await stub.fetch(
      new Request(target.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: input.event }),
      }),
    );
    if (!response.ok) return 0;
    const body = (await response.json().catch(() => ({}))) as { delivered?: number };
    return typeof body.delivered === "number" ? body.delivered : 0;
  } catch {
    return 0;
  }
}

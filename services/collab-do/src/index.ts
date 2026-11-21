/**
 * Document sync Durable Object — spec 13.2, 37.1-37.5, E2E-13.
 *
 * Yjs updates are relayed here, but the authority for a committed file is the
 * Git tree on GitHub. A snapshot published from here becomes a commit with an
 * explicit base SHA; if the remote moved, the publish fails with a conflict
 * instead of force-pushing.
 *
 * What is actually guaranteed:
 *  - updates are appended in arrival order and each gets a monotonic server
 *    revision, so a client can say "I have up to rN" and receive only rN+1..;
 *  - an update that is too large, duplicated, or arrives after the session was
 *    compacted is refused with a reason instead of being silently dropped;
 *  - awareness (cursor/selection) is ephemeral and is never written to storage.
 */
import { sha256Hex } from "@ai-room/auth";

export interface DocumentSessionState {
  readonly projectId: string;
  readonly documentId: string;
  /** Monotonic server revision of the relay snapshots, not a Git SHA. */
  revision: number;
  baseSha: string | null;
  updates: Uint8Array[];
}

export interface PublishRequest {
  readonly commitMessage: string;
  readonly baseSha: string;
  readonly authorId: string;
}

export type PublishOutcome =
  | { readonly status: "PUBLISHED"; readonly commitMessage: string; readonly baseSha: string }
  | { readonly status: "CONFLICT"; readonly remoteHeadSha: string; readonly reason: "REMOTE_MOVED" | "STALE_BASE" }
  | { readonly status: "UNSUPPORTED"; readonly reason: "GIT_NOT_CONNECTED" };

export class DocumentSession {
  private readonly state: DocumentSessionState;

  constructor(projectId: string, documentId: string, baseSha: string | null) {
    this.state = { projectId, documentId, revision: 0, baseSha, updates: [] };
  }

  /** Appends an opaque Yjs update; returns the new server revision. */
  applyUpdate(update: Uint8Array): number {
    this.state.updates.push(update);
    this.state.revision += 1;
    return this.state.revision;
  }

  /**
   * Publish is a three-way check, not a write: the caller's base must equal the
   * session's base, and the session must equal the remote head.
   */
  publish(request: PublishRequest, remoteHeadSha: string | null): PublishOutcome {
    if (remoteHeadSha === null) return { status: "UNSUPPORTED", reason: "GIT_NOT_CONNECTED" };
    if (this.state.baseSha === null || request.baseSha !== this.state.baseSha) {
      return { status: "CONFLICT", remoteHeadSha, reason: "STALE_BASE" };
    }
    if (remoteHeadSha !== this.state.baseSha) {
      return { status: "CONFLICT", remoteHeadSha, reason: "REMOTE_MOVED" };
    }
    // The actual commit is created by github-integration; this only records intent.
    return { status: "PUBLISHED", commitMessage: request.commitMessage, baseSha: this.state.baseSha };
  }

  /** Snapshot for reconnecting clients: revision, base, and update count only. */
  snapshotRef(): { readonly revision: number; readonly baseSha: string | null; readonly updateCount: number } {
    return { revision: this.state.revision, baseSha: this.state.baseSha, updateCount: this.state.updates.length };
  }

  /** After a successful commit, the session's base advances. */
  advanceBase(newSha: string): void {
    this.state.baseSha = newSha;
    this.state.updates = [];
  }
}

export const MAX_UPDATE_BYTES = 512 * 1024;
export const MAX_UPDATE_COUNT = 5_000;

export interface AwarenessState {
  readonly session_id: string;
  readonly actor_id: string;
  readonly cursor: { readonly anchor: number; readonly head: number };
  readonly selection: boolean;
  readonly updated_at_ms: number;
}

export type UpdateAcceptance =
  | { readonly accepted: true; readonly revision: number }
  | { readonly accepted: false; readonly reason: "TOO_LARGE" | "COMPACTED" | "DUPLICATE" | "STALE_BASE"; readonly detail?: string };

/**
 * Room-scoped collaboration session. It keeps the relay and the Git binding in
 * one object so a publish cannot use a base the session never acknowledged.
 */
export class CollabSession {
  private readonly projectId: string;
  private readonly documentId: string;
  private revision = 0;
  private baseSha: string | null;
  private updates: { update_id: string; bytes: Uint8Array; origin: string }[] = [];
  private readonly awareness = new Map<string, AwarenessState>();
  private readonly seen = new Set<string>();

  constructor(projectId: string, documentId: string, baseSha: string | null) {
    this.projectId = projectId;
    this.documentId = documentId;
    this.baseSha = baseSha;
  }

  get currentBase(): string | null {
    return this.baseSha;
  }

  get currentRevision(): number {
    return this.revision;
  }

  applyUpdate(input: { updateId: string; bytes: Uint8Array; originSessionId: string }): UpdateAcceptance {
    if (input.bytes.byteLength > MAX_UPDATE_BYTES) {
      return { accepted: false, reason: "TOO_LARGE", detail: `${input.bytes.byteLength} > ${MAX_UPDATE_BYTES}` };
    }
    if (this.seen.has(input.updateId)) return { accepted: false, reason: "DUPLICATE" };
    if (this.updates.length >= MAX_UPDATE_COUNT) {
      return { accepted: false, reason: "COMPACTED", detail: "snackpoint required before more updates" };
    }
    this.seen.add(input.updateId);
    this.updates.push({ update_id: input.updateId, bytes: input.bytes, origin: input.originSessionId });
    this.revision += 1;
    return { accepted: true, revision: this.revision };
  }

  /** Server revision the client claims; a client ahead of the server is refused. */
  syncSince(revision: number): { from: number; to: number; updates: { update_id: string; origin: string; bytes: Uint8Array }[] } | null {
    if (revision > this.revision) return null;
    return {
      from: revision,
      to: this.revision,
      updates: this.updates.slice(revision).map((update) => ({ update_id: update.update_id, origin: update.origin, bytes: update.bytes })),
    };
  }

  updateAwareness(state: Omit<AwarenessState, "updated_at_ms">, nowMs = Date.now()): void {
    this.awareness.set(state.session_id, { ...state, updated_at_ms: nowMs });
  }

  /** Awareness older than 30s is dropped: a stale cursor is a lie on screen. */
  liveAwareness(nowMs = Date.now()): AwarenessState[] {
    for (const [key, value] of this.awareness) if (nowMs - value.updated_at_ms > 30_000) this.awareness.delete(key);
    return [...this.awareness.values()];
  }

  /** Publish binds the exact base SHA the session acknowledged. */
  publish(input: { commitMessage: string; baseSha: string; authorId: string }, remoteHeadSha: string | null): PublishOutcome {
    if (remoteHeadSha === null) return { status: "UNSUPPORTED", reason: "GIT_NOT_CONNECTED" };
    if (this.baseSha === null || input.baseSha !== this.baseSha) return { status: "CONFLICT", remoteHeadSha, reason: "STALE_BASE" };
    if (remoteHeadSha !== this.baseSha) return { status: "CONFLICT", remoteHeadSha, reason: "REMOTE_MOVED" };
    return { status: "PUBLISHED", commitMessage: input.commitMessage, baseSha: this.baseSha };
  }

  /** After a commit lands, the base moves and the relay starts from zero. */
  advanceBase(newSha: string): void {
    this.baseSha = newSha;
    this.updates = [];
    this.seen.clear();
  }

  async snapshotDigest(): Promise<{ revision: number; base_sha: string | null; update_count: number; digest_sha256: string; bytes: number }> {
    const total = this.updates.reduce((sum, update) => sum + update.bytes.byteLength, 0);
    const concatenated = new Uint8Array(total);
    let offset = 0;
    for (const update of this.updates) {
      concatenated.set(update.bytes, offset);
      offset += update.bytes.byteLength;
    }
    return {
      revision: this.revision,
      base_sha: this.baseSha,
      update_count: this.updates.length,
      digest_sha256: await sha256Hex(concatenated),
      bytes: total,
    };
  }

  /** Metadata for the IDE panel; never includes document text. */
  info(): { project_id: string; document_id: string; revision: number; base_sha: string | null; update_count: number; peers: number } {
    return {
      project_id: this.projectId,
      document_id: this.documentId,
      revision: this.revision,
      base_sha: this.baseSha,
      update_count: this.updates.length,
      peers: this.awareness.size,
    };
  }
}


/** Cloudflare Durable Object shell for a document: one instance per doc id. */
export class CollabDurableObject {
  private readonly state: { storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }; id?: { name?: string } };
  private sessions = new Map<string, CollabSession>();

  constructor(state: { storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }; id?: { name?: string } }) {
    this.state = state;
  }

  private async sessionFor(projectId: string, documentId: string, baseSha: string | null): Promise<CollabSession> {
    const key = `session:${projectId}:${documentId}`;
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const saved = await this.state.storage.get<{ revision: number; baseSha: string | null }>(key);
    const session = new CollabSession(projectId, documentId, saved?.baseSha ?? baseSha);
    this.sessions.set(key, session);
    return session;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? "unknown";
    const documentId = url.searchParams.get("documentId") ?? this.state.id?.name ?? "unknown";
    const baseSha = url.searchParams.get("baseSha");
    const session = await this.sessionFor(projectId, documentId, baseSha);
    if (request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, data: session.info() }), { headers: { "content-type": "application/json" } });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const updateId = String(body["updateId"] ?? "");
    const encoded = String(body["bytes"] ?? "");
    if (updateId.length === 0 || encoded.length === 0) {
      return new Response(JSON.stringify({ ok: false, code: "VALIDATION_FAILED" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const acceptance = session.applyUpdate({ updateId, bytes: Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)), originSessionId: String(body["originSessionId"] ?? "unknown") });
    await this.state.storage.put(`session:${projectId}:${documentId}`, { revision: session.currentRevision, baseSha: session.currentBase });
    return new Response(JSON.stringify({ ok: acceptance.accepted, data: acceptance }), { status: acceptance.accepted ? 200 : 409, headers: { "content-type": "application/json" } });
  }
}

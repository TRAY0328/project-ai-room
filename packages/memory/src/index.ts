/**
 * Three-layer memory — spec 11.2, 11.3, E2E-23, S36, S37.
 *
 * Layers and their authority:
 *   agent_private : one AI, never visible to another AI or to another project.
 *   room          : participants of that room (membership, not a display name).
 *   project       : project members; carries project_id for ACL filtering.
 *   shared        : explicit, version-pinned share; a reference to the source
 *                   record, never a copy, so revoking the source revokes it.
 *
 * A memory is prose plus provenance. It is not a fine-tuned parameter, and a
 * model's claim is stored as `hypothesis` until something else corroborates it.
 * Deleting a memory writes a tombstone that search sees (S37/E2E-23).
 */
import { ApiError, mintId, type Subject } from "@ai-room/contracts";
import { allRows, count, firstRow, nowIso, type SqlDb } from "@ai-room/auth";

export type MemoryScope = "agent_private" | "room" | "project" | "shared";
export type TrustState = "unverified" | "corroborated" | "disputed";
export type MemoryKind = "fact" | "decision" | "hypothesis" | "note" | "task_result";

export interface MemorySource {
  readonly source_kind: "message" | "file" | "artifact" | "job" | "manual" | "provider";
  readonly source_id: string;
  readonly quote?: string;
}

export interface MemoryRecord {
  readonly memory_id: string;
  readonly memory_scope: MemoryScope;
  readonly scope_id: string;
  readonly project_id: string | null;
  readonly memory_kind: MemoryKind;
  readonly body_text: string;
  readonly trust_state: TrustState;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sources: readonly MemorySource[];
}

export interface MemoryAccessContext {
  readonly subject: Subject;
  readonly roomIds: readonly string[];
  readonly projectIds: readonly string[];
}

function assertScopeAllowed(input: {
  readonly subject: Subject;
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly access: MemoryAccessContext;
  readonly requestId: string;
  readonly write: boolean;
}): void {
  const { subject, scope, scopeId, projectId, access } = input;
  if (scope === "agent_private") {
    if (subject.kind !== "agent" || scopeId !== subject.id) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    return;
  }
  if (scope === "project") {
    if (projectId === null || projectId !== scopeId) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: input.requestId, details: { field: "project_id" } });
    }
    if (subject.kind !== "owner" && !access.projectIds.includes(projectId)) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
    }
    return;
  }
  if (scope === "room") {
    if (subject.kind !== "owner" && !access.roomIds.includes(scopeId)) {
      throw new ApiError({ code: "ROOM_ACCESS_DENIED", requestId: input.requestId });
    }
    return;
  }
  // shared: only the owner or an actor holding an explicit grant may write.
  if (subject.kind !== "owner") {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "DEFAULT_DENY" } });
  }
  void input.write;
}

export class MemoryService {
  private readonly db: SqlDb;

  constructor(db: SqlDb) {
    this.db = db;
  }

  async create(input: {
    readonly subject: Subject;
    readonly access: MemoryAccessContext;
    readonly scope: MemoryScope;
    readonly scopeId: string;
    readonly projectId: string | null;
    readonly kind: MemoryKind;
    readonly body: string;
    readonly trust?: TrustState;
    readonly sources: readonly MemorySource[];
    readonly requestId: string;
  }): Promise<MemoryRecord> {
    assertScopeAllowed({
      subject: input.subject,
      scope: input.scope,
      scopeId: input.scopeId,
      projectId: input.projectId,
      access: input.access,
      requestId: input.requestId,
      write: true,
    });
    if (input.sources.length === 0) {
      // A fact with no source is a rumour; the schema keeps it but never as a fact.
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: input.requestId,
        message: "기억에는 출처가 최소 1개 필요합니다.",
        details: { field: "sources" },
      });
    }
    const now = nowIso();
    const memoryId = mintId("memory");
    const trust: TrustState = input.trust ?? (input.kind === "fact" || input.kind === "decision" ? "unverified" : "unverified");
    await this.db
      .prepare(
        `INSERT INTO memory_records
          (memory_id, memory_scope, scope_id, project_id, memory_kind, body_text, trust_state, source_json, revision, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .bind(
        memoryId,
        input.scope,
        input.scopeId,
        input.projectId,
        input.kind,
        input.body,
        trust,
        JSON.stringify(input.sources),
        now,
        now,
      )
      .run();
    for (const source of input.sources) {
      await this.db
        .prepare(
          `INSERT INTO memory_provenance (provenance_id, memory_id, source_kind, source_id, quote, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(mintId("event"), memoryId, source.source_kind, source.source_id, source.quote ?? null, now)
        .run();
    }
    if (input.scope === "shared" || input.subject.kind === "owner") {
      await this.db
        .prepare("INSERT OR IGNORE INTO memory_permissions (memory_id, actor_kind, actor_id, access, granted_at) VALUES (?,?,?,?,?)")
        .bind(memoryId, "owner", input.subject.kind === "owner" ? input.subject.id : "owner", "write", now)
        .run();
    }
    return {
      memory_id: memoryId,
      memory_scope: input.scope,
      scope_id: input.scopeId,
      project_id: input.projectId,
      memory_kind: input.kind,
      body_text: input.body,
      trust_state: trust,
      revision: 1,
      created_at: now,
      updated_at: now,
      sources: input.sources,
    };
  }

  private visibleClause(access: MemoryAccessContext): { sql: string; params: unknown[] } {
    if (access.subject.kind === "owner") return { sql: "1 = 1", params: [] };
    const parts: string[] = ["(m.memory_scope = 'shared')"];
    const params: unknown[] = [];
    if (access.subject.kind === "agent") {
      // A cross-project share is an explicit read grant, never a copy (spec 11.3).
      parts.push(
        "EXISTS (SELECT 1 FROM memory_permissions mp WHERE mp.memory_id = m.memory_id AND mp.actor_kind = 'agent' AND mp.actor_id = ? AND mp.access = 'read')",
      );
      params.push(access.subject.id);
      parts.push("(m.memory_scope = 'agent_private' AND m.scope_id = ?)");
      params.push(access.subject.id);
    }
    if (access.roomIds.length > 0) {
      parts.push(`(m.memory_scope = 'room' AND m.scope_id IN (${access.roomIds.map(() => "?").join(",")}))`);
      params.push(...access.roomIds);
    }
    if (access.projectIds.length > 0) {
      parts.push(`(m.memory_scope = 'project' AND m.scope_id IN (${access.projectIds.map(() => "?").join(",")}))`);
      params.push(...access.projectIds);
    }
    return { sql: `(${parts.join(" OR ")})`, params };
  }

  async list(input: {
    readonly access: MemoryAccessContext;
    readonly projectId: string | null;
    readonly scope?: MemoryScope;
    readonly limit: number;
    readonly cursor?: string;
    readonly includeText?: boolean;
  }): Promise<{ items: MemoryRecord[]; nextCursor: string | null }> {
    const visibility = this.visibleClause(input.access);
    const clauses = [visibility.sql, "m.deleted_at IS NULL"];
    const params: unknown[] = [...visibility.params];
    if (input.projectId !== null) {
      // A project view contains: its own rows, shared rows, the asking AI's
      // private rows, and rows another project explicitly granted to it.
      clauses.push(
        "(m.project_id = ? OR m.memory_scope = 'shared' OR m.memory_scope = 'agent_private' OR EXISTS (SELECT 1 FROM memory_permissions mp WHERE mp.memory_id = m.memory_id AND mp.actor_kind = ? AND mp.actor_id = ? AND mp.access = 'read'))",
      );
      params.push(input.projectId, input.access.subject.kind === "owner" ? "owner" : "agent", input.access.subject.id);
    }
    if (input.scope !== undefined) {
      clauses.push("m.memory_scope = ?");
      params.push(input.scope);
    }
    if (input.cursor !== undefined) {
      clauses.push("m.created_at < ?");
      params.push(input.cursor);
    }
    const rows = await allRows<{
      memory_id: string;
      memory_scope: MemoryScope;
      scope_id: string;
      project_id: string | null;
      memory_kind: MemoryKind;
      body_text: string;
      trust_state: TrustState;
      revision: number;
      created_at: string;
      updated_at: string;
      source_json: string;
    }>(
      this.db,
      `SELECT m.memory_id, m.memory_scope, m.scope_id, m.project_id, m.memory_kind, m.body_text,
              m.trust_state, m.revision, m.created_at, m.updated_at, m.source_json
       FROM memory_records m
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC, m.memory_id DESC
       LIMIT ?`,
      ...params,
      input.limit + 1,
    );
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        memory_id: row.memory_id,
        memory_scope: row.memory_scope,
        scope_id: row.scope_id,
        project_id: row.project_id,
        memory_kind: row.memory_kind,
        body_text: input.includeText === false ? row.body_text.slice(0, 160) : row.body_text,
        trust_state: row.trust_state,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        sources: JSON.parse(row.source_json) as MemorySource[],
      })),
      nextCursor: rows.length > input.limit ? (page[page.length - 1]?.created_at ?? null) : null,
    };
  }

  async search(input: {
    readonly access: MemoryAccessContext;
    readonly projectId: string | null;
    readonly query: string;
    readonly limit: number;
  }): Promise<{ items: (MemoryRecord & { rank: number })[]; tookMs: number }> {
    const started = Date.now();
    const terms = input.query
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
      .filter((term) => term.length > 0)
      .slice(0, 8);
    if (terms.length === 0) return { items: [], tookMs: Date.now() - started };
    const match = terms.map((term) => `"${term}"*`).join(" AND ");
    const visibility = this.visibleClause(input.access);
    const clauses = [visibility.sql, "m.deleted_at IS NULL"];
    const params: unknown[] = [match, ...visibility.params];
    if (input.projectId !== null) {
      clauses.push(
        "(m.project_id = ? OR m.memory_scope = 'shared' OR EXISTS (SELECT 1 FROM memory_permissions mp WHERE mp.memory_id = m.memory_id AND mp.actor_kind = ? AND mp.actor_id = ? AND mp.access = 'read'))",
      );
      params.push(input.projectId, input.access.subject.kind === "owner" ? "owner" : "agent", input.access.subject.id);
    }
    const rows = await allRows<{
      memory_id: string;
      memory_scope: MemoryScope;
      scope_id: string;
      project_id: string | null;
      memory_kind: MemoryKind;
      body_text: string;
      trust_state: TrustState;
      revision: number;
      created_at: string;
      updated_at: string;
      source_json: string;
      rank: number;
    }>(
      this.db,
      `SELECT m.memory_id, m.memory_scope, m.scope_id, m.project_id, m.memory_kind, m.body_text,
              m.trust_state, m.revision, m.created_at, m.updated_at, m.source_json,
              bm25(memory_fts) AS rank
       FROM memory_fts f
       JOIN memory_records m ON m.memory_id = f.memory_id
       WHERE memory_fts MATCH ? AND ${clauses.join(" AND ")}
       ORDER BY rank ASC
       LIMIT ?`,
      ...params,
      input.limit,
    );
    return {
      items: rows.map((row) => ({
        memory_id: row.memory_id,
        memory_scope: row.memory_scope,
        scope_id: row.scope_id,
        project_id: row.project_id,
        memory_kind: row.memory_kind,
        body_text: row.body_text,
        trust_state: row.trust_state,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        sources: JSON.parse(row.source_json) as MemorySource[],
        rank: row.rank,
      })),
      tookMs: Date.now() - started,
    };
  }

  async revise(input: {
    readonly memoryId: string;
    readonly access: MemoryAccessContext;
    readonly expectedRevision: number;
    readonly body?: string;
    readonly trust?: TrustState;
    readonly requestId: string;
  }): Promise<void> {
    const row = await firstRow<{ memory_scope: MemoryScope; scope_id: string; project_id: string | null; revision: number; deleted_at: string | null }>(
      this.db,
      "SELECT memory_scope, scope_id, project_id, revision, deleted_at FROM memory_records WHERE memory_id = ?",
      input.memoryId,
    );
    if (row === null || row.deleted_at !== null) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
    }
    assertScopeAllowed({
      subject: input.access.subject,
      scope: row.memory_scope,
      scopeId: row.scope_id,
      projectId: row.project_id,
      access: input.access,
      requestId: input.requestId,
      write: true,
    });
    if (row.revision !== input.expectedRevision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: input.requestId, details: { current_revision: row.revision } });
    }
    await this.db
      .prepare("UPDATE memory_records SET body_text = COALESCE(?, body_text), trust_state = COALESCE(?, trust_state), revision = revision + 1, updated_at = ? WHERE memory_id = ?")
      .bind(input.body ?? null, input.trust ?? null, nowIso(), input.memoryId)
      .run();
  }

  async delete(input: {
    readonly memoryId: string;
    readonly access: MemoryAccessContext;
    readonly requestId: string;
  }): Promise<{ memory_id: string; tombstoned: true }> {
    const row = await firstRow<{ memory_scope: MemoryScope; scope_id: string; project_id: string | null; deleted_at: string | null }>(
      this.db,
      "SELECT memory_scope, scope_id, project_id, deleted_at FROM memory_records WHERE memory_id = ?",
      input.memoryId,
    );
    if (row === null || row.deleted_at !== null) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
    }
    assertScopeAllowed({
      subject: input.access.subject,
      scope: row.memory_scope,
      scopeId: row.scope_id,
      projectId: row.project_id,
      access: input.access,
      requestId: input.requestId,
      write: true,
    });
    const now = nowIso();
    await this.db.prepare("UPDATE memory_records SET deleted_at = ? WHERE memory_id = ?").bind(now, input.memoryId).run();
    // Derived references stop resolving the moment the source is gone (S36/S38).
    await this.db
      .prepare("DELETE FROM memory_permissions WHERE memory_id = ? AND access = 'read'")
      .bind(input.memoryId)
      .run();
    return { memory_id: input.memoryId, tombstoned: true };
  }

  /** Cross-project share: a pinned reference, not a copy (spec 11.3). */
  async shareToProject(input: {
    readonly memoryId: string;
    readonly sourceProjectId: string | null;
    readonly targetProjectId: string;
    readonly access: MemoryAccessContext;
    readonly requestId: string;
    readonly note?: string;
  }): Promise<{ share_id: string; memory_id: string; target_project_id: string; pinned_revision: number }> {
    const row = await firstRow<{ revision: number; deleted_at: string | null; memory_scope: MemoryScope; scope_id: string; project_id: string | null }>(
      this.db,
      "SELECT revision, deleted_at, memory_scope, scope_id, project_id FROM memory_records WHERE memory_id = ?",
      input.memoryId,
    );
    if (row === null || row.deleted_at !== null) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
    }
    assertScopeAllowed({
      subject: input.access.subject,
      scope: row.memory_scope,
      scopeId: row.scope_id,
      projectId: row.project_id,
      access: input.access,
      requestId: input.requestId,
      write: false,
    });
    if (input.access.subject.kind !== "owner" && !input.access.projectIds.includes(input.targetProjectId)) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: input.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
    }
    const shareId = mintId("event");
    const now = nowIso();
    const members = await allRows<{ actor_kind: "owner" | "agent"; actor_id: string }>(
      this.db,
      "SELECT actor_kind, actor_id FROM project_acl WHERE project_id = ? AND revoked_at IS NULL",
      input.targetProjectId,
    );
    for (const member of members) {
      await this.db
        .prepare("INSERT OR IGNORE INTO memory_permissions (memory_id, actor_kind, actor_id, access, granted_at) VALUES (?,?,?,'read',?)")
        .bind(input.memoryId, member.actor_kind, member.actor_id, now)
        .run();
    }
    await this.db
      .prepare(
        `INSERT INTO project_events
          (event_id, project_id, event_type, aggregate_type, aggregate_id, sequence, actor_kind, actor_id, payload_json, occurred_at)
         SELECT ?, ?, 'memory.shared', 'memory', ?, COALESCE(MAX(sequence),0)+1, ?, ?, ?, ?
         FROM project_events WHERE project_id = ?`,
      )
      .bind(
        shareId,
        input.targetProjectId,
        input.memoryId,
        input.access.subject.kind,
        input.access.subject.id,
        JSON.stringify({
          memory_id: input.memoryId,
          source_project_id: input.sourceProjectId,
          target_project_id: input.targetProjectId,
          pinned_revision: row.revision,
          note: input.note ?? "",
          authority: "source_project",
        }),
        now,
        input.targetProjectId,
      )
      .run();
    return { share_id: shareId, memory_id: input.memoryId, target_project_id: input.targetProjectId, pinned_revision: row.revision };
  }

  async countVisible(access: MemoryAccessContext): Promise<number> {
    const visibility = this.visibleClause(access);
    return count(this.db, `SELECT COUNT(*) AS n FROM memory_records m WHERE ${visibility.sql} AND m.deleted_at IS NULL`, ...visibility.params);
  }
}

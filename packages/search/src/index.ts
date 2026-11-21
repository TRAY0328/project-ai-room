/**
 * Search — spec 11.1, 19.2 (`POST /v1/search`), S17, S18, S37.
 *
 * Implementation choices that matter:
 *  - D1 FTS5 is the keyword engine. No embedding model is active, so no
 *    semantic claim is made; the response says `semantic: "not_active"`.
 *  - The ACL filter is applied in the same SQL statement as the match, so a
 *    project the caller cannot see can never appear in a page or a count.
 *  - Deleted rows are excluded twice: FTS triggers drop them, and the join also
 *    checks `deleted_at`/tombstones. A stale index cannot leak a deleted message.
 *  - The query is tokenised and quoted; operators, quotes and wildcards from the
 *    client never reach FTS raw (no FTS syntax injection, bound input length).
 */
import type { SqlDb } from "@ai-room/auth";
import { allRows, count } from "@ai-room/auth";

export type SearchResultKind = "message" | "memory" | "task" | "document" | "project";

export interface SearchResult {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly room_id: string | null;
  readonly project_id: string | null;
  readonly created_at: string;
  readonly score: number;
  readonly source_ref: string;
}

export interface SearchAccess {
  readonly kind: "owner" | "agent";
  readonly actor_id: string;
  readonly room_ids: readonly string[];
  readonly project_ids: readonly string[];
}

export interface SearchRequest {
  readonly query: string;
  readonly projectId?: string | null;
  readonly roomId?: string | null;
  readonly kinds?: readonly SearchResultKind[];
  readonly limit?: number;
  readonly author?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

export const MAX_QUERY_LENGTH = 200;
export const MAX_TERMS = 8;

export function tokenizeQuery(query: string): string[] {
  if (query.length > MAX_QUERY_LENGTH) throw new RangeError("query too long");
  return query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((term) => term.length >= 1 && term.length <= 40)
    .slice(0, MAX_TERMS);
}

function ftsMatch(terms: readonly string[]): string {
  return terms.map((term) => `"${term}"*`).join(" AND ");
}

function likePattern(term: string): string {
  // Escape LIKE metacharacters so a query cannot widen into a wildcard scan.
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class SearchService {
  private readonly db: SqlDb;

  constructor(db: SqlDb) {
    this.db = db;
  }

  async search(access: SearchAccess, request: SearchRequest): Promise<{
    items: SearchResult[];
    total: number;
    took_ms: number;
    semantic: "not_active";
    filters: Record<string, unknown>;
    deleted_items_excluded: true;
  }> {
    const started = Date.now();
    const terms = tokenizeQuery(request.query);
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 50);
    if (terms.length === 0) {
      return {
        items: [],
        total: 0,
        took_ms: Date.now() - started,
        semantic: "not_active",
        filters: { kinds: request.kinds ?? ["message", "memory", "task", "document", "project"] },
        deleted_items_excluded: true,
      };
    }
    const kinds = new Set<SearchResultKind>(request.kinds ?? ["message", "memory", "task", "document", "project"]);
    const results: SearchResult[] = [];

    if (kinds.has("message")) results.push(...(await this.searchMessages(access, request, terms, limit)));
    if (kinds.has("memory")) results.push(...(await this.searchMemories(access, request, terms, limit)));
    if (kinds.has("task")) results.push(...(await this.searchTasks(access, request, terms, limit)));
    if (kinds.has("document")) results.push(...(await this.searchDocuments(access, request, terms, limit)));
    if (kinds.has("project")) results.push(...(await this.searchProjects(access, terms, limit)));

    results.sort((a, b) => b.score - a.score);
    return {
      items: results.slice(0, limit),
      total: results.length,
      took_ms: Date.now() - started,
      semantic: "not_active",
      filters: {
        kinds: [...kinds],
        project_id: request.projectId ?? null,
        room_id: request.roomId ?? null,
        author: request.author ?? null,
        from: request.from ?? null,
        to: request.to ?? null,
      },
      deleted_items_excluded: true,
    };
  }

  private async searchMessages(access: SearchAccess, request: SearchRequest, terms: readonly string[], limit: number): Promise<SearchResult[]> {
    if (access.kind === "agent" && access.room_ids.length === 0) return [];
    const clauses = ["m.deleted_at IS NULL", "t.message_id IS NULL"];
    const params: unknown[] = [ftsMatch(terms)];
    if (access.kind === "agent") {
      clauses.push(`m.room_id IN (${access.room_ids.map(() => "?").join(",")})`);
      params.push(...access.room_ids);
    }
    if (request.roomId !== undefined && request.roomId !== null) {
      clauses.push("m.room_id = ?");
      params.push(request.roomId);
    }
    if (request.projectId !== undefined && request.projectId !== null) {
      clauses.push("m.room_id IN (SELECT room_id FROM project_room_links WHERE project_id = ?)");
      params.push(request.projectId);
    }
    if (request.author !== undefined && request.author !== null) {
      clauses.push("m.author_id = ?");
      params.push(request.author);
    }
    if (request.from !== undefined && request.from !== null) {
      clauses.push("m.created_at >= ?");
      params.push(request.from);
    }
    if (request.to !== undefined && request.to !== null) {
      clauses.push("m.created_at <= ?");
      params.push(request.to);
    }
    const rows = await allRows<{ message_id: string; room_id: string; body_text: string; created_at: string; author_id: string; rank: number; project_id: string | null; snippet: string }>(
      this.db,
      `SELECT m.message_id, m.room_id, v.body_plain_text AS body_text, m.created_at, m.author_id,
              bm25(message_fts) AS rank,
              (SELECT pl.project_id FROM project_room_links pl WHERE pl.room_id = m.room_id LIMIT 1) AS project_id,
              snippet(message_fts, 2, '[', ']', ' … ', 12) AS snippet
       FROM message_fts
       JOIN messages m ON m.message_id = message_fts.message_id
       JOIN message_versions v ON v.message_id = m.message_id AND v.revision = m.current_revision
       LEFT JOIN message_tombstones t ON t.message_id = m.message_id
       WHERE message_fts MATCH ? AND ${clauses.join(" AND ")}
       ORDER BY rank ASC
       LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({
      kind: "message" as const,
      id: row.message_id,
      title: `#${row.room_id}`,
      snippet: row.snippet,
      room_id: row.room_id,
      project_id: row.project_id,
      created_at: row.created_at,
      score: -row.rank,
      source_ref: `message:${row.message_id}`,
    }));
  }

  private async searchMemories(access: SearchAccess, request: SearchRequest, terms: readonly string[], limit: number): Promise<SearchResult[]> {
    const clauses = ["r.deleted_at IS NULL"];
    const params: unknown[] = [ftsMatch(terms)];
    if (access.kind === "agent") {
      const visible: string[] = ["r.memory_scope = 'shared'", "(r.memory_scope = 'agent_private' AND r.scope_id = ?)"];
      params.push(access.actor_id);
      if (access.room_ids.length > 0) {
        visible.push(`(r.memory_scope = 'room' AND r.scope_id IN (${access.room_ids.map(() => "?").join(",")}))`);
        params.push(...access.room_ids);
      }
      if (access.project_ids.length > 0) {
        visible.push(`(r.memory_scope = 'project' AND r.scope_id IN (${access.project_ids.map(() => "?").join(",")}))`);
        params.push(...access.project_ids);
      }
      clauses.push(`(${visible.join(" OR ")})`);
    }
    if (request.projectId !== undefined && request.projectId !== null) {
      clauses.push("(r.project_id = ? OR r.memory_scope = 'shared')");
      params.push(request.projectId);
    }
    const rows = await allRows<{ memory_id: string; body_text: string; created_at: string; project_id: string | null; rank: number; memory_scope: string }>(
      this.db,
      `SELECT r.memory_id, r.body_text, r.created_at, r.project_id, r.memory_scope, bm25(memory_fts) AS rank
       FROM memory_fts
       JOIN memory_records r ON r.memory_id = memory_fts.memory_id
       WHERE memory_fts MATCH ? AND ${clauses.join(" AND ")}
       ORDER BY rank ASC
       LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({
      kind: "memory" as const,
      id: row.memory_id,
      title: `memory:${row.memory_scope}`,
      snippet: row.body_text.slice(0, 240),
      room_id: null,
      project_id: row.project_id,
      created_at: row.created_at,
      score: -row.rank,
      source_ref: `memory:${row.memory_id}`,
    }));
  }

  private async searchTasks(access: SearchAccess, request: SearchRequest, terms: readonly string[], limit: number): Promise<SearchResult[]> {
    const clauses = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];
    const patterns = terms.map(likePattern);
    clauses.push(`(${patterns.map(() => "(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')").join(" OR ")})`);
    for (const pattern of patterns) params.push(pattern, pattern);
    if (access.kind === "agent") {
      if (access.project_ids.length === 0) return [];
      clauses.push(`t.project_id IN (${access.project_ids.map(() => "?").join(",")})`);
      params.push(...access.project_ids);
    }
    if (request.projectId !== undefined && request.projectId !== null) {
      clauses.push("t.project_id = ?");
      params.push(request.projectId);
    }
    const rows = await allRows<{ task_id: string; title: string; description: string; state: string; project_id: string; created_at: string }>(
      this.db,
      `SELECT t.task_id, t.title, t.description, t.state, t.project_id, t.created_at
       FROM tasks t WHERE ${clauses.join(" AND ")} ORDER BY t.created_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({
      kind: "task" as const,
      id: row.task_id,
      title: row.title,
      snippet: row.description.slice(0, 200),
      room_id: null,
      project_id: row.project_id,
      created_at: row.created_at,
      score: 0.5,
      source_ref: `task:${row.task_id}`,
    }));
  }

  private async searchDocuments(access: SearchAccess, request: SearchRequest, terms: readonly string[], limit: number): Promise<SearchResult[]> {
    if (access.kind === "agent" && access.project_ids.length === 0) return [];
    const clauses = ["d.deleted_at IS NULL"];
    const params: unknown[] = [];
    clauses.push(`d.path LIKE ? ESCAPE '\\'`);
    params.push(likePattern(terms[0] ?? ""));
    if (access.kind === "agent") {
      clauses.push(`d.project_id IN (${access.project_ids.map(() => "?").join(",")})`);
      params.push(...access.project_ids);
    }
    if (request.projectId !== undefined && request.projectId !== null) {
      clauses.push("d.project_id = ?");
      params.push(request.projectId);
    }
    const rows = await allRows<{ document_id: string; path: string; project_id: string; created_at: string }>(
      this.db,
      `SELECT d.document_id, d.path, d.project_id, d.created_at FROM documents d
       WHERE ${clauses.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({
      kind: "document" as const,
      id: row.document_id,
      title: row.path,
      snippet: row.path,
      room_id: null,
      project_id: row.project_id,
      created_at: row.created_at,
      score: 0.4,
      source_ref: `document:${row.document_id}`,
    }));
  }

  private async searchProjects(access: SearchAccess, terms: readonly string[], limit: number): Promise<SearchResult[]> {
    const clauses = ["p.deleted_at IS NULL", "p.status <> 'deleted'"];
    const params: unknown[] = [likePattern(terms[0] ?? "")];
    if (access.kind === "agent") {
      if (access.project_ids.length === 0) return [];
      clauses.push(`p.project_id IN (${access.project_ids.map(() => "?").join(",")})`);
      params.push(...access.project_ids);
    }
    const rows = await allRows<{ project_id: string; name: string; description: string; created_at: string }>(
      this.db,
      `SELECT p.project_id, p.name, p.description, p.created_at FROM projects p
       WHERE ${clauses.join(" AND ")} AND (p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')
       ORDER BY p.updated_at DESC LIMIT ?`,
      ...params,
      params[0],
      limit,
    );
    return rows.map((row) => ({
      kind: "project" as const,
      id: row.project_id,
      title: row.name,
      snippet: row.description.slice(0, 160),
      room_id: null,
      project_id: row.project_id,
      created_at: row.created_at,
      score: 0.6,
      source_ref: `project:${row.project_id}`,
    }));
  }

  /** Purge propagation check: a deleted target must never be counted again. */
  async isTombstoned(kind: SearchResultKind, id: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        "SELECT COUNT(*) AS n FROM search_tombstones WHERE target_kind = ? AND target_id = ?",
        kind,
        id,
      )) > 0
    );
  }
}

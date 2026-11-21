/**
 * Identity service — spec 06, 33.1, S01/S02/S03/S05/S06/S49.
 *
 * What is guaranteed here:
 *  1. Exactly one human owner; bootstrapping is one-shot behind a deployment
 *     secret, and a second attempt is refused.
 *  2. The owner password verifier is never stored in D1. `bootstrapOwner`
 *     returns the PBKDF2 verifier once for the operator to set as the
 *     `OWNER_PASSWORD_VERIFIER` Worker secret (spec 06.2 #3/#7). D1 keeps only
 *     session rows whose refresh tokens are SHA-256 verifiers.
 *  3. AI registration needs a private invite secret (env master secret or a
 *     one-time DB invite), is rate limited, and never grants admin.
 *  4. An AI key is shown once. Only its SHA-256 verifier is stored, and the
 *     key hash is what a login lookup uses — a DB leak cannot be replayed.
 *  5. Rotation/revocation/suspension revoke live sessions immediately, so a
 *     stolen key stops working at the next request instead of at expiry.
 */
import {
  ApiError,
  isIdOfKind,
  mintId,
  toUtcIso,
  type SessionAssurance,
  type Subject,
} from "@ai-room/contracts";
import {
  allRows,
  count,
  firstRow,
  isValidId,
  nowIso,
  type SqlDb,
} from "./db.js";
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  randomToken,
  sha256Hex,
  timingSafeEqualString,
  verifyPassword,
} from "./crypto.js";
import {
  DEFAULT_SESSION_TTL_MS,
  OWNER_SESSION_TTL_MS,
  WS_TICKET_TTL_MS,
  signSessionToken,
  signWsTicket,
  verifySessionToken,
  verifyWsTicket,
  type SessionTokenClaims,
  type TokenAssurance,
  type WsTicket,
} from "./tokens.js";
import { consumeRateLimit, enforceFailureBudget, enforceRateLimit, recordFailure } from "./rate-limit.js";

export interface AuthEnv {
  readonly SESSION_SIGNING_KEY?: string;
  readonly WS_TICKET_SIGNING_KEY?: string;
  readonly AGENT_INVITE_SECRET?: string;
  readonly OWNER_BOOTSTRAP_SECRET?: string;
  readonly OWNER_PASSWORD_VERIFIER?: string;
}

export interface SessionBundle {
  readonly session_id: string;
  readonly subject_kind: "owner" | "agent";
  readonly subject_id: string;
  readonly assurance: TokenAssurance;
  readonly access_token: string;
  readonly access_expires_at: string;
  readonly refresh_token: string;
  readonly refresh_expires_at: string;
}

export interface AgentKeyBundle {
  readonly agent_id: string;
  readonly credential_id: string;
  /** Plaintext key. Returned exactly once; never stored or logged. */
  readonly agent_key: string;
  readonly key_prefix: string;
}

const REFRESH_TOKEN_PREFIX = "rt_";
const AGENT_KEY_PREFIX = "airo_sk_";

function requireSigningKey(value: string | undefined): string {
  if (value === undefined || value.length < 16) {
    throw new ApiError({
      code: "INTERNAL_ERROR",
      requestId: mintId("request"),
      message: "세션 서명 키가 설정되지 않았습니다.",
      details: { config: "SESSION_SIGNING_KEY" },
    });
  }
  return value;
}

export class AuthService {
  private readonly db: SqlDb;
  private readonly env: AuthEnv;

  constructor(db: SqlDb, env: AuthEnv) {
    this.db = db;
    this.env = env;
  }

  // -------------------------------------------------------------------------
  // Owner
  // -------------------------------------------------------------------------

  async ownerExists(): Promise<boolean> {
    return (await count(this.db, "SELECT COUNT(*) AS n FROM owners")) > 0;
  }

  async bootstrapOwner(input: {
    readonly display_name: string;
    readonly email: string;
    readonly password: string;
    readonly bootstrap_secret: string;
    readonly request_id: string;
    readonly client_ip_hash?: string;
  }): Promise<{
    owner_id: string;
    display_name: string;
    password_verifier: string;
    next_step: string;
    invite_secret: string;
    invite_id: string;
  }> {
    const expectedSecret = this.env.OWNER_BOOTSTRAP_SECRET;
    if (expectedSecret === undefined || expectedSecret.length < 16) {
      throw new ApiError({
        code: "AUTH_REQUIRED",
        requestId: input.request_id,
        message: "소유자 부트스트랩 비밀이 설정되지 않았습니다.",
        details: { config: "OWNER_BOOTSTRAP_SECRET" },
      });
    }
    const ipSubject = input.client_ip_hash ?? "unattributed";
    await enforceRateLimit(
      this.db,
      {
        limitKey: `owner_bootstrap:${ipSubject}`,
        limit: 5,
        windowMs: 15 * 60 * 1000,
        providerKey: "local",
        subjectKind: "ip",
        subjectId: ipSubject,
      },
      input.request_id,
    );
    if (!timingSafeEqualString(input.bootstrap_secret, expectedSecret)) {
      await this.recordSecurityEvent("invite_abuse", "high", "system", "bootstrap", "owner", "owner", "bad bootstrap secret");
      throw new ApiError({ code: "INVITE_INVALID", requestId: input.request_id });
    }
    if (await this.ownerExists()) {
      // One owner, one onboarding. A second row is refused by the DB trigger too.
      throw new ApiError({
        code: "PERMISSION_DENIED",
        requestId: input.request_id,
        message: "소유자 계정은 이미 생성되었습니다.",
        details: { reason_code: "OWNER_ALREADY_BOOTSTRAPPED" },
      });
    }

    const passwordVerifier = await hashPassword(input.password, PBKDF2_ITERATIONS);
    const ownerId = mintId("owner");
    const now = nowIso();
    await this.db
      .prepare(
        "INSERT INTO owners (owner_id, display_name, email, created_at, updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(ownerId, input.display_name, input.email, now, now)
      .run();

    const invite = await this.createInvite({ owner_id: ownerId, ttl_ms: 24 * 60 * 60 * 1000 });
    await this.audit("identity.owner.bootstrapped", "owner", ownerId, "owner", ownerId, "allow", input.request_id, {
      email_domain: input.email.split("@")[1] ?? "unknown",
    });
    return {
      owner_id: ownerId,
      display_name: input.display_name,
      password_verifier: passwordVerifier,
      next_step:
        "이 값을 Worker 비밀(OWNER_PASSWORD_VERIFIER)로 설정하세요. 서버는 이 값을 다시 보여주지 않으며 D1에는 저장하지 않습니다.",
      invite_secret: invite.secret,
      invite_id: invite.invite_id,
    };
  }

  async loginOwner(input: {
    readonly email: string;
    readonly password: string;
    readonly request_id: string;
    readonly client_ip_hash?: string;
  }): Promise<SessionBundle> {
    const ipSubject = input.client_ip_hash ?? "unattributed";
    await enforceRateLimit(
      this.db,
      {
        limitKey: `owner_login:${ipSubject}`,
        limit: 8,
        windowMs: 10 * 60 * 1000,
        providerKey: "local",
        subjectKind: "ip",
        subjectId: ipSubject,
      },
      input.request_id,
    );
    const verifier = this.env.OWNER_PASSWORD_VERIFIER;
    if (verifier === undefined) {
      throw new ApiError({
        code: "AUTH_REQUIRED",
        requestId: input.request_id,
        message: "소유자 비밀번호 검증기가 설정되지 않았습니다.",
        details: { config: "OWNER_PASSWORD_VERIFIER" },
      });
    }
    const owner = await firstRow<{ owner_id: string; display_name: string; email: string | null; disabled_at: string | null }>(
      this.db,
      "SELECT owner_id, display_name, email, disabled_at FROM owners WHERE email = ? LIMIT 1",
      input.email,
    );
    const passwordOk = await verifyPassword(input.password, verifier);
    if (owner === null || !passwordOk || owner.disabled_at !== null) {
      await this.recordSecurityEvent("auth_failure", "medium", "owner", "unknown", "owner", "owner", "owner login failed");
      throw new ApiError({ code: "AUTH_REQUIRED", requestId: input.request_id });
    }
    const session = await this.createSession({
      subjectKind: "owner",
      subjectId: owner.owner_id,
      assurance: "owner_ui",
      ttlMs: OWNER_SESSION_TTL_MS,
      requestId: input.request_id,
    });
    await this.audit("identity.owner.login", "owner", owner.owner_id, "session", session.session_id, "allow", input.request_id, {});
    return session;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async createSession(input: {
    readonly subjectKind: "owner" | "agent";
    readonly subjectId: string;
    readonly assurance: TokenAssurance;
    readonly ttlMs?: number;
    readonly refreshTtlMs?: number;
    readonly requestId: string;
  }): Promise<SessionBundle> {
    const signingKey = requireSigningKey(this.env.SESSION_SIGNING_KEY);
    const nowMs = Date.now();
    const accessTtl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const refreshTtl = input.refreshTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    const sessionId = mintId("session");
    const refreshToken = `${sessionId}.${randomToken(REFRESH_TOKEN_PREFIX, 32)}`;
    const refreshHash = await sha256Hex(refreshToken);
    const issuedAt = toUtcIso(nowMs);
    const accessExpiresAt = toUtcIso(nowMs + accessTtl);
    const refreshExpiresAt = toUtcIso(nowMs + refreshTtl);
    await this.db
      .prepare(
        `INSERT INTO auth_sessions
          (session_id, subject_kind, subject_id, refresh_token_hash, session_assurance, issued_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(sessionId, input.subjectKind, input.subjectId, refreshHash, input.assurance, issuedAt, refreshExpiresAt)
      .run();
    const claims: SessionTokenClaims = {
      v: "v1",
      sub_kind: input.subjectKind,
      sub_id: input.subjectId,
      session_id: sessionId,
      assurance: input.assurance,
      iat: issuedAt,
      exp: accessExpiresAt,
      jti: randomToken("jti_", 12),
    };
    const accessToken = await signSessionToken(claims, signingKey);
    return {
      session_id: sessionId,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId,
      assurance: input.assurance,
      access_token: accessToken,
      access_expires_at: accessExpiresAt,
      refresh_token: refreshToken,
      refresh_expires_at: refreshExpiresAt,
    };
  }

  async refresh(refreshToken: string, requestId: string): Promise<SessionBundle> {
    const signingKey = requireSigningKey(this.env.SESSION_SIGNING_KEY);
    const [sessionId] = refreshToken.split(".");
    if (sessionId === undefined || !isIdOfKind(sessionId, "session")) {
      throw new ApiError({ code: "AUTH_REVOKED", requestId });
    }
    const row = await firstRow<{
      session_id: string;
      subject_kind: "owner" | "agent";
      subject_id: string;
      refresh_token_hash: string;
      session_assurance: TokenAssurance;
      expires_at: string;
      revoked_at: string | null;
    }>(this.db, "SELECT * FROM auth_sessions WHERE session_id = ?", sessionId);
    if (row === null || row.revoked_at !== null) throw new ApiError({ code: "AUTH_REVOKED", requestId });
    if (Date.parse(row.expires_at) <= Date.now()) throw new ApiError({ code: "AUTH_EXPIRED", requestId });
    const presentedHash = await sha256Hex(refreshToken);
    if (!timingSafeEqualString(presentedHash, row.refresh_token_hash)) {
      // Replay of a rotated refresh token: revoke the whole session family.
      await this.revokeSession(sessionId, "refresh_reuse_detected");
      await this.recordSecurityEvent("auth_failure", "high", row.subject_kind, row.subject_id, "session", sessionId, "refresh token reuse");
      throw new ApiError({ code: "AUTH_REVOKED", requestId });
    }
    if (row.subject_kind === "agent") {
      const agent = await firstRow<{ disabled_at: string | null }>(this.db, "SELECT disabled_at FROM agents WHERE agent_id = ?", row.subject_id);
      if (agent === null || agent.disabled_at !== null) {
        await this.revokeSession(sessionId, "agent_disabled");
        throw new ApiError({ code: "AUTH_REVOKED", requestId });
      }
    }
    const nowMs = Date.now();
    const accessTtl = row.session_assurance === "owner_ui" ? OWNER_SESSION_TTL_MS : DEFAULT_SESSION_TTL_MS;
    const rotated = `${sessionId}.${randomToken(REFRESH_TOKEN_PREFIX, 32)}`;
    const rotatedHash = await sha256Hex(rotated);
    await this.db
      .prepare("UPDATE auth_sessions SET refresh_token_hash = ?, last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL")
      .bind(rotatedHash, nowIso(), sessionId)
      .run();
    const issuedAt = toUtcIso(nowMs);
    const accessExpiresAt = toUtcIso(nowMs + accessTtl);
    const accessToken = await signSessionToken(
      {
        v: "v1",
        sub_kind: row.subject_kind,
        sub_id: row.subject_id,
        session_id: sessionId,
        assurance: row.session_assurance,
        iat: issuedAt,
        exp: accessExpiresAt,
        jti: randomToken("jti_", 12),
      },
      signingKey,
    );
    return {
      session_id: sessionId,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      assurance: row.session_assurance,
      access_token: accessToken,
      access_expires_at: accessExpiresAt,
      refresh_token: rotated,
      refresh_expires_at: row.expires_at,
    };
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ?, last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL")
      .bind(nowIso(), nowIso(), sessionId)
      .run();
    await this.audit("identity.session.revoked", "system", "system", "session", sessionId, "deny", undefined, { reason });
  }

  async logout(bearer: string | undefined, refreshToken: string | undefined, requestId: string): Promise<{ revoked_sessions: number }> {
    const signingKey = requireSigningKey(this.env.SESSION_SIGNING_KEY);
    let sessionId: string | null = null;
    if (bearer !== undefined) {
      const verification = await verifySessionToken(bearer, signingKey);
      if (verification.ok) sessionId = verification.claims.session_id;
    }
    if (sessionId === null && refreshToken !== undefined) {
      const [candidate] = refreshToken.split(".");
      if (candidate !== undefined && isIdOfKind(candidate, "session")) {
        const row = await firstRow<{ refresh_token_hash: string }>(
          this.db,
          "SELECT refresh_token_hash FROM auth_sessions WHERE session_id = ?",
          candidate,
        );
        if (row !== null && timingSafeEqualString(await sha256Hex(refreshToken), row.refresh_token_hash)) {
          sessionId = candidate;
        }
      }
    }
    if (sessionId === null) throw new ApiError({ code: "AUTH_REVOKED", requestId });
    await this.revokeSession(sessionId, "logout");
    return { revoked_sessions: 1 };
  }

  /** Resolves a bearer token to a Subject, checking the DB for revocation. */
  async authenticate(bearer: string, requestId: string): Promise<{ subject: Subject; assurance: SessionAssurance; session_id: string }> {
    const signingKey = requireSigningKey(this.env.SESSION_SIGNING_KEY);
    const verification = await verifySessionToken(bearer, signingKey);
    if (!verification.ok) {
      throw new ApiError({ code: verification.reason === "expired" ? "AUTH_EXPIRED" : "AUTH_REVOKED", requestId });
    }
    const claims = verification.claims;
    const session = await firstRow<{ revoked_at: string | null; expires_at: string; session_assurance: TokenAssurance; subject_id: string; subject_kind: "owner" | "agent" }>(
      this.db,
      "SELECT revoked_at, expires_at, session_assurance, subject_id, subject_kind FROM auth_sessions WHERE session_id = ?",
      claims.session_id,
    );
    if (session === null || session.revoked_at !== null) throw new ApiError({ code: "AUTH_REVOKED", requestId });
    if (Date.parse(session.expires_at) <= Date.now()) throw new ApiError({ code: "AUTH_EXPIRED", requestId });
    if (session.subject_id !== claims.sub_id || session.subject_kind !== claims.sub_kind) {
      throw new ApiError({ code: "AUTH_REVOKED", requestId });
    }
    await this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE session_id = ?")
      .bind(nowIso(), claims.session_id)
      .run();
    if (claims.sub_kind === "owner") {
      const owner = await firstRow<{ owner_id: string; disabled_at: string | null }>(
        this.db,
        "SELECT owner_id, disabled_at FROM owners WHERE owner_id = ?",
        claims.sub_id,
      );
      if (owner === null || owner.disabled_at !== null) throw new ApiError({ code: "AUTH_REVOKED", requestId });
      return {
        subject: {
          kind: "owner",
          id: owner.owner_id,
          platformAdmin: true,
          ownerId: owner.owner_id as NonNullable<Subject["ownerId"]>,
        },
        assurance: "owner_ui",
        session_id: claims.session_id,
      };
    }
    const agent = await firstRow<{
      agent_id: string;
      disabled_at: string | null;
      verification_state: "self_declared" | "discovery_verified" | "provider_verified";
      platform_admin: number;
    }>(this.db, "SELECT agent_id, disabled_at, verification_state, platform_admin FROM agents WHERE agent_id = ?", claims.sub_id);
    if (agent === null || agent.disabled_at !== null) throw new ApiError({ code: "AUTH_REVOKED", requestId });
    return {
      subject: {
        kind: "agent",
        id: agent.agent_id,
        platformAdmin: agent.platform_admin === 1,
        agentId: agent.agent_id as NonNullable<Subject["agentId"]>,
        verificationState: agent.verification_state,
      },
      assurance: "agent_key",
      session_id: claims.session_id,
    };
  }

  // -------------------------------------------------------------------------
  // Invites and agents
  // -------------------------------------------------------------------------

  async createInvite(input: { owner_id: string; ttl_ms?: number; invite_id?: string }): Promise<{ invite_id: string; secret: string; expires_at: string }> {
    const secret = randomToken("inv_", 32);
    const inviteId = input.invite_id ?? mintId("installation");
    const nowMs = Date.now();
    const expiresAt = toUtcIso(nowMs + (input.ttl_ms ?? 24 * 60 * 60 * 1000));
    await this.db
      .prepare(
        "INSERT INTO agent_invites (invite_id, secret_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?)",
      )
      .bind(inviteId, await sha256Hex(secret), input.owner_id, toUtcIso(nowMs), expiresAt)
      .run();
    await this.audit("identity.invite.created", "owner", input.owner_id, "invite", inviteId, "allow", undefined, {
      expires_at: expiresAt,
    });
    return { invite_id: inviteId, secret, expires_at: expiresAt };
  }

  /**
   * Validates an invite secret against (a) the deployment master secret and
   * (b) unused, unexpired DB invites. Constant-time; wrong guesses cost budget.
   */
  async verifyInvite(input: {
    readonly secret: string;
    readonly request_id: string;
    readonly client_ip_hash?: string;
  }): Promise<{ invite_id: string | null; max_uses: number }> {
    const ipSubject = input.client_ip_hash ?? "unattributed";
    const policy = {
      limitKey: `agent_register:${ipSubject}`,
      limit: 6,
      windowMs: 10 * 60 * 1000,
      providerKey: "local",
      subjectKind: "invite" as const,
      subjectId: ipSubject,
    };
    // Only failures spend the budget: a wrong guess is the abuse signal.
    await enforceFailureBudget(this.db, policy, input.request_id);
    const master = this.env.AGENT_INVITE_SECRET;
    if (master !== undefined && master.length >= 16 && timingSafeEqualString(input.secret, master)) {
      return { invite_id: null, max_uses: Number.POSITIVE_INFINITY };
    }
    const hash = await sha256Hex(input.secret);
    const invite = await firstRow<{ invite_id: string; used_at: string | null; revoked_at: string | null; expires_at: string }>(
      this.db,
      "SELECT invite_id, used_at, revoked_at, expires_at FROM agent_invites WHERE secret_hash = ?",
      hash,
    );
    if (invite === null || invite.used_at !== null || invite.revoked_at !== null) {
      await recordFailure(this.db, policy);
      await this.recordSecurityEvent("invite_abuse", "medium", "system", "anonymous", "invite", "unknown", "invalid invite secret");
      throw new ApiError({ code: "INVITE_INVALID", requestId: input.request_id });
    }
    if (Date.parse(invite.expires_at) <= Date.now()) {
      throw new ApiError({ code: "INVITE_INVALID", requestId: input.request_id, details: { reason: "expired" } });
    }
    return { invite_id: invite.invite_id, max_uses: 1 };
  }

  async registerAgent(input: {
    readonly display_name: string;
    readonly avatar_asset_id: string;
    readonly claimed_provider?: string | null;
    readonly description?: string;
    readonly model_name?: string | null;
    readonly invite_secret: string;
    readonly request_id: string;
    readonly client_ip_hash?: string;
    readonly idempotency_key?: string;
  }): Promise<{
    agent: Record<string, unknown>;
    credential: AgentKeyBundle;
    session: SessionBundle;
    identity: { verification_state: "self_declared"; provider_verified: false; note: string };
  }> {
    if (!isValidId(input.avatar_asset_id, "art") && !isValidId(input.avatar_asset_id, "file")) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: input.request_id,
        message: "아바타는 업로드된 asset id(art_/file_)여야 합니다.",
        details: { field: "avatar_asset_id" },
      });
    }
    const invite = await this.verifyInvite({
      secret: input.invite_secret,
      request_id: input.request_id,
      ...(input.client_ip_hash === undefined ? {} : { client_ip_hash: input.client_ip_hash }),
    });

    if (input.idempotency_key !== undefined) {
      const existing = await firstRow<{ agent_id: string }>(
        this.db,
        `SELECT a.agent_id FROM agents a
         WHERE a.display_name = ? AND a.claimed_provider IS ? AND a.created_at >= ?`,
        input.display_name,
        input.claimed_provider ?? null,
        new Date(Date.parse(nowIso()) - 24 * 60 * 60 * 1000).toISOString(),
      );
      if (existing !== null) {
        throw new ApiError({
          code: "IDEMPOTENCY_CONFLICT",
          requestId: input.request_id,
          details: { note: "동일 이름·제공자로 이미 등록된 AI가 있습니다.", agent_id: existing.agent_id },
        });
      }
    }

    const agentId = mintId("agent");
    const now = nowIso();
    await this.db
      .prepare(
        `INSERT INTO agents (agent_id, display_name, avatar_asset_id, claimed_provider, verification_state, created_at, updated_at)
         VALUES (?,?,?,?,'self_declared',?,?)`,
      )
      .bind(agentId, input.display_name, input.avatar_asset_id, input.claimed_provider ?? null, now, now)
      .run();
    await this.db
      .prepare("INSERT INTO agent_profiles (agent_id, description, model_name, updated_at) VALUES (?,?,?,?)")
      .bind(agentId, input.description ?? "", input.model_name ?? null, now)
      .run();

    if (invite.invite_id !== null) {
      await this.db
        .prepare("UPDATE agent_invites SET used_at = ?, used_by_agent_id = ? WHERE invite_id = ? AND used_at IS NULL")
        .bind(now, agentId, invite.invite_id)
        .run();
    }

    const credential = await this.issueAgentKey(agentId);
    // Every registered AI may speak in the one default room; nothing else is implied.
    const mainRoom = await firstRow<{ room_id: string }>(this.db, "SELECT room_id FROM rooms WHERE room_type = 'main' AND deleted_at IS NULL LIMIT 1");
    if (mainRoom !== null) {
      await this.db
        .prepare("INSERT OR IGNORE INTO room_members (room_id, actor_kind, actor_id, joined_at, invited_by) VALUES (?,?,?,?,?)")
        .bind(mainRoom.room_id, "agent", agentId, now, "owner")
        .run();
      await this.db
        .prepare("INSERT OR IGNORE INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,?,?,?)")
        .bind(mainRoom.room_id, "agent", agentId, "contributor", "owner", now)
        .run();
    }
    const session = await this.createSession({
      subjectKind: "agent",
      subjectId: agentId,
      assurance: "agent_key",
      requestId: input.request_id,
    });
    await this.audit("identity.agent.registered", "agent", agentId, "agent", agentId, "allow", input.request_id, {
      claimed_provider: input.claimed_provider ?? null,
      invite_id: invite.invite_id,
    });
    return {
      agent: {
        agent_id: agentId,
        display_name: input.display_name,
        avatar_asset_id: input.avatar_asset_id,
        claimed_provider: input.claimed_provider ?? null,
        verification_state: "self_declared",
        profile_revision: 1,
        created_at: now,
      },
      credential,
      session,
      identity: {
        verification_state: "self_declared",
        provider_verified: false,
        note: "이름은 자기신고입니다. 제공자 공식 인증 전에는 검증 배지를 표시하지 않습니다.",
      },
    };
  }

  private async issueAgentKey(agentId: string): Promise<AgentKeyBundle> {
    const agentKey = `${AGENT_KEY_PREFIX}${randomToken("", 32)}`;
    const credentialId = mintId("credential");
    await this.db
      .prepare("INSERT INTO agent_credentials (credential_id, agent_id, verifier_hash, status, created_at) VALUES (?,?,?,'active',?)")
      .bind(credentialId, agentId, await sha256Hex(agentKey), nowIso())
      .run();
    return {
      agent_id: agentId,
      credential_id: credentialId,
      agent_key: agentKey,
      key_prefix: agentKey.slice(0, 12),
    };
  }

  async loginAgent(input: { agent_key: string; request_id: string; client_ip_hash?: string }): Promise<SessionBundle & { agent_id: string }> {
    const ipSubject = input.client_ip_hash ?? "unattributed";
    await consumeRateLimit(this.db, {
      limitKey: `agent_login:${ipSubject}`,
      limit: 30,
      windowMs: 10 * 60 * 1000,
      providerKey: "local",
      subjectKind: "ip",
      subjectId: ipSubject,
    });
    const hash = await sha256Hex(input.agent_key);
    const credential = await firstRow<{
      credential_id: string;
      agent_id: string;
      status: "active" | "rotated" | "revoked" | "suspended";
      agent_disabled: string | null;
    }>(
      this.db,
      `SELECT c.credential_id, c.agent_id, c.status, a.disabled_at AS agent_disabled
       FROM agent_credentials c JOIN agents a ON a.agent_id = c.agent_id
       WHERE c.verifier_hash = ? LIMIT 1`,
      hash,
    );
    if (credential === null) {
      await this.recordSecurityEvent("auth_failure", "medium", "agent", "unknown", "credential", "unknown", "unknown agent key");
      throw new ApiError({ code: "AUTH_REVOKED", requestId: input.request_id });
    }
    if (credential.status !== "active" || credential.agent_disabled !== null) {
      await this.recordSecurityEvent("auth_failure", "high", "agent", credential.agent_id, "credential", credential.credential_id, `credential ${credential.status}`);
      throw new ApiError({ code: "AUTH_REVOKED", requestId: input.request_id, details: { credential_status: credential.status } });
    }
    await this.db
      .prepare("UPDATE agent_credentials SET last_used_at = ? WHERE credential_id = ?")
      .bind(nowIso(), credential.credential_id)
      .run();
    const session = await this.createSession({
      subjectKind: "agent",
      subjectId: credential.agent_id,
      assurance: "agent_key",
      requestId: input.request_id,
    });
    return { ...session, agent_id: credential.agent_id };
  }

  /** Rotation: new key, old key retired, other sessions of this agent dropped. */
  async rekeyAgent(agentId: string, requestId: string, currentSessionId?: string): Promise<AgentKeyBundle> {
    const credentials = await allRows<{ credential_id: string }>(
      this.db,
      "SELECT credential_id FROM agent_credentials WHERE agent_id = ? AND status = 'active'",
      agentId,
    );
    for (const credential of credentials) {
      await this.db
        .prepare("UPDATE agent_credentials SET status = 'rotated', rotated_at = ? WHERE credential_id = ?")
        .bind(nowIso(), credential.credential_id)
        .run();
    }
    const bundle = await this.issueAgentKey(agentId);
    await this.revokeSessionsFor(agentId, "key_rotated", currentSessionId);
    await this.audit("identity.credential.rotated", "agent", agentId, "agent", agentId, "allow", requestId, {
      credential_id: bundle.credential_id,
    });
    return bundle;
  }

  async revokeSessionsFor(agentId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const rows = await allRows<{ session_id: string }>(
      this.db,
      "SELECT session_id FROM auth_sessions WHERE subject_kind = 'agent' AND subject_id = ? AND revoked_at IS NULL",
      agentId,
    );
    let revoked = 0;
    for (const row of rows) {
      if (exceptSessionId !== undefined && row.session_id === exceptSessionId) continue;
      await this.db
        .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL")
        .bind(nowIso(), row.session_id)
        .run();
      revoked += 1;
    }
    await this.audit("identity.sessions.revoked", "system", "system", "agent", agentId, "deny", undefined, { reason, revoked });
    return revoked;
  }

  async suspendAgent(agentId: string, reason: string): Promise<{ credentials_suspended: number; sessions_revoked: number }> {
    const suspended = await this.db
      .prepare("UPDATE agent_credentials SET status = 'suspended' WHERE agent_id = ? AND status = 'active'")
      .bind(agentId)
      .run();
    const revoked = await this.revokeSessionsFor(agentId, reason);
    await this.audit("identity.agent.suspended", "system", "system", "agent", agentId, "deny", undefined, { reason });
    return {
      credentials_suspended: Number(suspended.meta?.["changes"] ?? 0),
      sessions_revoked: revoked,
    };
  }

  // -------------------------------------------------------------------------
  // WebSocket tickets
  // -------------------------------------------------------------------------

  async issueWsTicket(input: {
    readonly subject: Subject;
    readonly room_id: string;
    readonly project_id: string | null;
    readonly permissions: readonly string[];
    readonly acl_revision: number;
    readonly request_id: string;
  }): Promise<{ ticket: string; expires_at: string; ticket_id: string; room_id: string }> {
    const signingKey = this.env.WS_TICKET_SIGNING_KEY ?? this.env.SESSION_SIGNING_KEY;
    if (signingKey === undefined || signingKey.length < 16) {
      throw new ApiError({
        code: "INTERNAL_ERROR",
        requestId: input.request_id,
        message: "WebSocket 티켓 서명 키가 설정되지 않았습니다.",
        details: { config: "WS_TICKET_SIGNING_KEY" },
      });
    }
    const nowMs = Date.now();
    const ticketId = mintId("event");
    const ticket: WsTicket = {
      v: "v1",
      ticket_id: ticketId,
      subject_kind: input.subject.kind === "owner" ? "owner" : "agent",
      subject_id: input.subject.id,
      room_id: input.room_id,
      project_id: input.project_id,
      permissions: [...input.permissions],
      issued_at: toUtcIso(nowMs),
      expires_at: toUtcIso(nowMs + WS_TICKET_TTL_MS),
      nonce: randomToken("", 16),
      acl_revision: input.acl_revision,
    };
    return {
      ticket: await signWsTicket(ticket, signingKey),
      expires_at: ticket.expires_at,
      ticket_id: ticketId,
      room_id: input.room_id,
    };
  }

  async verifyWsTicket(token: string): Promise<WsTicket> {
    const signingKey = this.env.WS_TICKET_SIGNING_KEY ?? this.env.SESSION_SIGNING_KEY;
    if (signingKey === undefined) throw new ApiError({ code: "AUTH_REVOKED", requestId: mintId("request") });
    const result = await verifyWsTicket(token, signingKey);
    if (!result.ok) {
      throw new ApiError({ code: result.reason === "expired" ? "AUTH_EXPIRED" : "AUTH_REVOKED", requestId: mintId("request") });
    }
    return result.ticket;
  }

  // -------------------------------------------------------------------------
  // Audit helpers
  // -------------------------------------------------------------------------

  async recordSecurityEvent(
    kind: string,
    severity: "low" | "medium" | "high" | "critical",
    actorKind: string,
    actorId: string,
    targetType: string,
    targetId: string,
    detail: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO security_events
          (security_event_id, event_kind, severity, actor_kind, actor_id, target_type, target_id, detail_redacted, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(randomToken("sec_", 12), kind, severity, actorKind, actorId, targetType, targetId, detail, nowIso())
      .run();
  }

  async audit(
    eventType: string,
    actorKind: "owner" | "agent" | "system",
    actorId: string,
    targetType: string,
    targetId: string,
    allowOrDeny: "allow" | "deny",
    requestId: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_events
          (audit_id, event_type, actor_kind, actor_id, target_type, target_id, request_id, allow_or_deny, reason_code, metadata_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        mintId("event"),
        eventType,
        actorKind,
        actorId,
        targetType,
        targetId,
        requestId ?? null,
        allowOrDeny,
        allowOrDeny === "allow" ? "POLICY_ALLOWED" : "PERMISSION_DENIED",
        JSON.stringify(metadata),
        nowIso(),
      )
      .run();
  }
}

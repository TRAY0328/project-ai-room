/**
 * Identity endpoints — catalog group "신원·등록·세션" (15 of 78).
 *
 * Provider connection endpoints are implemented as honest blocked states: no
 * provider in the frozen roster has a verified unattended path today, so
 * `connect` answers 503 with the official document links and the measured state
 * instead of opening a fake consent screen or storing a pretend connection.
 */
import { ApiError, mintId } from "@ai-room/contracts";
import { allRows, firstRow, nowIso } from "@ai-room/auth";
import { filterAgentProfilePatch } from "@ai-room/permissions";
import { explainProviderState, REQUIRED_ROSTER, buildProviderRegistry } from "@ai-room/provider-adapters";
import type { Handler } from "../domain.js";
import { blocked, ensureMainRoom, isEmergencyStopped, notFoundOrHidden, optionalString } from "../domain.js";
import { readCookie, REFRESH_COOKIE, SESSION_COOKIE } from "../http.js";

const registry = buildProviderRegistry();

/**
 * The avatar a registration gets when it sends neither `avatar_url` nor
 * `avatar_asset_id`. The web client ships these files with the Worker, so the
 * default is always reachable on the deployment that minted the identity —
 * nobody has to find an image URL before they can take part.
 */
export const DEFAULT_AVATAR_PATH = "/avatars/default.svg";

function defaultAvatarUrl(requestUrl: URL): string {
  return new URL(DEFAULT_AVATAR_PATH, requestUrl.origin).toString();
}

async function seedRequiredAgents(ctx: Parameters<Handler>[0]): Promise<void> {
  const now = ctx.now;
  for (const agent of REQUIRED_ROSTER) {
    const support = registry.get(agent.provider_key)?.evidence;
    const state =
      support === undefined
        ? "unknown"
        : support.state === "VERIFIED"
          ? "verified"
          : support.state === "CAPABILITY_MISSING" || support.state === "AUTONOMY_UNSUPPORTED" || support.state === "AUTH_UNSUPPORTED"
            ? "unsupported"
            : "blocked";
    await ctx.db
      .prepare(
        `INSERT INTO required_agents (requirement_id, provider_key, target_label, required, verification_state, proof_ref, verified_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_key) DO UPDATE SET target_label = excluded.target_label, updated_at = excluded.updated_at`,
      )
      .bind(
        mintId("event"),
        agent.provider_key,
        support?.display_label ?? agent.display_label,
        agent.required ? 1 : 0,
        state,
        support === undefined ? null : support.evidence_ref,
        null,
        now,
      )
      .run();
  }
}

function providerEntry(providerKey: string, requestId: string) {
  const entry = registry.get(providerKey);
  if (entry === undefined) {
    throw new ApiError({
      code: "CAPABILITY_UNSUPPORTED",
      requestId,
      message: "이 제공자는 필수 AI 목록에 없습니다.",
      details: { provider_key: providerKey.slice(0, 40) },
    });
  }
  return entry;
}

function blockedProvider(providerKey: string, requestId: string, entry: ReturnType<typeof providerEntry>): ApiError {
  return blocked(requestId, "PROVIDER_NOT_VERIFIED", {
    provider_key: providerKey,
    provider_state: entry.evidence.state,
    explanation: explainProviderState(entry.evidence.state),
    official_doc_urls: entry.evidence.official_doc_urls,
    unattended_operation: entry.evidence.unattended_operation,
    free_entitlement: entry.evidence.free_entitlement,
    last_checked_at: entry.evidence.last_checked_at,
  });
}

export const identityHandlers: Record<string, Handler> = {
  "post-owner-bootstrap": async (ctx) => {
    const result = await ctx.auth.bootstrapOwner({
      display_name: String(ctx.body["display_name"]),
      email: String(ctx.body["email"]),
      password: String(ctx.body["password"]),
      bootstrap_secret: String(ctx.body["bootstrap_secret"]),
      request_id: ctx.requestId,
      client_ip_hash: ctx.clientIpHash,
    });
    const roomId = await ensureMainRoom(ctx.db, result.owner_id);
    await seedRequiredAgents(ctx);
    return {
      status: 201,
      data: {
        owner_id: result.owner_id,
        display_name: result.display_name,
        default_room_id: roomId,
        password_verifier: result.password_verifier,
        next_step: result.next_step,
        invite: { invite_id: result.invite_id, secret: result.invite_secret, note: "1회용. 등록 시 소모됩니다." },
      },
    };
  },

  "post-auth-login": async (ctx) => {
    const session = await ctx.auth.loginOwner({
      email: String(ctx.body["email"]),
      password: String(ctx.body["password"]),
      request_id: ctx.requestId,
      client_ip_hash: ctx.clientIpHash,
    });
    return { status: 200, data: { session, owner: await firstRow(ctx.db, "SELECT owner_id, display_name, email FROM owners LIMIT 1") } };
  },

  "post-auth-logout": async (ctx) => {
    // A browser has no bearer to send: the session lives in the HttpOnly cookie,
    // so logout reads the same cookie a normal request is authenticated with.
    const authorization = ctx.headers.get("authorization") ?? "";
    const bearer = authorization.replace(/^Bearer\s+/i, "").trim() || readCookie(ctx.headers.get("cookie"), SESSION_COOKIE) || undefined;
    const refresh = optionalString(ctx.body, "refresh_token") ?? readCookie(ctx.headers.get("cookie"), REFRESH_COOKIE) ?? undefined;
    const result = await ctx.auth.logout(bearer, refresh, ctx.requestId);
    return { status: 200, data: result };
  },

  "post-auth-refresh": async (ctx) => {
    // A browser never sees the refresh token: it is the HttpOnly `air_refresh`
    // cookie, so a cookie-only request has to renew the same session it kept
    // across reloads. An API client may still present the token in the body.
    const token = optionalString(ctx.body, "refresh_token") ?? readCookie(ctx.headers.get("cookie"), REFRESH_COOKIE);
    if (token === null) {
      throw new ApiError({
        code: "AUTH_REQUIRED",
        requestId: ctx.requestId,
        message: "연장할 세션이 없습니다 — air_refresh 쿠키나 refresh_token이 필요합니다.",
        details: { field: "refresh_token" },
      });
    }
    const session = await ctx.auth.refresh(token, ctx.requestId);
    // The refresh token rotates on every use; the response cookies (set by the
    // pipeline) carry the new pair, so the next renewal uses the new value.
    return { status: 200, data: { session, renewed_at: ctx.now } };
  },

  "post-agents-register": async (ctx) => {
    if (await isEmergencyStopped(ctx.db)) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, message: "긴급 정지 중에는 새 AI를 등록할 수 없습니다.", details: { reason_code: "EMERGENCY_STOP_ENGAGED" } });
    }
    if (ctx.principal.subject.kind === "owner") {
      // Registration is for AI identities; the owner already exists.
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "DEFAULT_DENY" } });
    }
    // A typed provider name is a claim, never a verification: `true` here would
    // be a self-granted badge, so it is refused instead of silently ignored.
    if (ctx.body["provider_verified"] === true) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: ctx.requestId,
        message: "provider_verified는 스스로 설정할 수 없습니다. 공급자 검증은 /v1/providers/{provider}/verify 증거로만 올라갑니다.",
        details: { field: "provider_verified" },
      });
    }
    const avatarAssetId = typeof ctx.body["avatar_asset_id"] === "string" && ctx.body["avatar_asset_id"].length > 0 ? ctx.body["avatar_asset_id"] : undefined;
    const explicitAvatarUrl = typeof ctx.body["avatar_url"] === "string" && ctx.body["avatar_url"].length > 0 ? ctx.body["avatar_url"] : undefined;
    // A registration without either avatar field still gets a usable identity:
    // the deployment serves this file itself, so nobody has to host an image
    // before they can join. An explicit URL or uploaded asset always wins.
    const avatarUrl = explicitAvatarUrl ?? (avatarAssetId === undefined ? defaultAvatarUrl(ctx.url) : undefined);
    const result = await ctx.auth.registerAgent({
      display_name: String(ctx.body["display_name"]),
      ...(avatarAssetId === undefined ? {} : { avatar_asset_id: avatarAssetId }),
      ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }),
      claimed_provider: optionalString(ctx.body, "provider_claim") ?? optionalString(ctx.body, "claimed_provider"),
      description: typeof ctx.body["bio"] === "string" ? ctx.body["bio"] : typeof ctx.body["description"] === "string" ? ctx.body["description"] : "",
      model_name: optionalString(ctx.body, "model_name"),
      invite_secret: String(ctx.body["invite_secret"]),
      request_id: ctx.requestId,
      client_ip_hash: ctx.clientIpHash,
      ...(typeof ctx.body["idempotency_key"] === "string" ? { idempotency_key: ctx.body["idempotency_key"] } : {}),
    });
    return { status: 201, data: result };
  },

  "post-agents-login": async (ctx) => {
    const session = await ctx.auth.loginAgent({
      agent_key: String(ctx.body["agent_key"]),
      request_id: ctx.requestId,
    });
    return { status: 200, data: { session, agent_id: session.agent_id } };
  },

  "post-agents-rekey": async (ctx) => {
    if (ctx.principal.subject.kind !== "agent") {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    const bundle = await ctx.auth.rekeyAgent(ctx.principal.subject.id, ctx.requestId);
    return {
      status: 200,
      data: {
        credential: bundle,
        notice: "이전 키와 다른 세션은 즉시 폐기되었습니다. 새 키는 지금 한 번만 표시됩니다.",
      },
    };
  },

  "get-agents": async (ctx) => {
    const rows = await allRows<{
      agent_id: string;
      display_name: string;
      avatar_asset_id: string;
      avatar_url: string | null;
      claimed_provider: string | null;
      verification_state: string;
      created_at: string;
      disabled_at: string | null;
      model_name: string | null;
      description: string;
    }>(
      ctx.db,
      `SELECT a.agent_id, a.display_name, a.avatar_asset_id, a.avatar_url, a.claimed_provider, a.verification_state,
              a.created_at, a.disabled_at, p.model_name, p.description
       FROM agents a LEFT JOIN agent_profiles p ON p.agent_id = a.agent_id
       ORDER BY a.created_at ASC`,
    );
    return {
      status: 200,
      data: {
        items: rows.map((row) => ({
          agent_id: row.agent_id,
          display_name: row.display_name,
          avatar_asset_id: row.avatar_asset_id,
          avatar_url: row.avatar_url,
          claimed_provider: row.claimed_provider,
          /** Typed name vs. proof are separate fields on purpose (spec 06.3). */
          claimed_provider_state: "self_declared",
          identity_verified: row.verification_state === "provider_verified",
          verification_state: row.verification_state,
          model_name: row.model_name,
          description: row.description,
          disabled: row.disabled_at !== null,
          created_at: row.created_at,
        })),
        identity_note: "provider_verified 이전의 provider 표기는 자기신고이며 검증 배지가 아닙니다.",
      },
    };
  },

  "get-agents-by-agentId": async (ctx) => {
    const agentId = ctx.params["agentId"] ?? "";
    const row = await firstRow<{
      agent_id: string;
      display_name: string;
      avatar_asset_id: string;
      avatar_url: string | null;
      claimed_provider: string | null;
      verification_state: string;
      created_at: string;
      disabled_at: string | null;
      model_name: string | null;
      description: string;
      company: string | null;
      pronouns: string | null;
      profile_revision: number;
    }>(
      ctx.db,
      `SELECT a.agent_id, a.display_name, a.avatar_asset_id, a.avatar_url, a.claimed_provider, a.verification_state,
              a.created_at, a.disabled_at, a.profile_revision, p.model_name, p.description, p.company, p.pronouns
       FROM agents a LEFT JOIN agent_profiles p ON p.agent_id = a.agent_id WHERE a.agent_id = ?`,
      agentId,
    );
    const activeCredential = await firstRow<{ credential_id: string; last_used_at: string | null }>(
      ctx.db,
      "SELECT credential_id, last_used_at FROM agent_credentials WHERE agent_id = ? AND status = 'active'",
      agentId,
    );
    if (row === null) throw notFoundOrHidden(ctx.requestId, "agent", agentId);
    const capabilities = await allRows<{ capability: string; state: string; attestation: string }>(
      ctx.db,
      "SELECT capability, state, attestation FROM capability_proofs p JOIN provider_connections c ON c.connection_id = p.connection_id WHERE c.agent_id = ?",
      agentId,
    );
    return {
      status: 200,
      data: {
        agent_id: row.agent_id,
        display_name: row.display_name,
        avatar_asset_id: row.avatar_asset_id,
        avatar_url: row.avatar_url,
        claimed_provider: row.claimed_provider,
        verification_state: row.verification_state,
        identity_verified: row.verification_state === "provider_verified",
        profile: {
          description: row.description ?? "",
          model_name: row.model_name,
          company: row.company,
          pronouns: row.pronouns,
          revision: row.profile_revision,
        },
        disabled: row.disabled_at !== null,
        created_at: row.created_at,
        credential: {
          status: activeCredential === null ? "none" : "active",
          last_used_at: activeCredential?.last_used_at ?? null,
          note: "키 원문은 서버에 저장되지 않습니다.",
        },
        capabilities: capabilities.map((cap) => ({ capability: cap.capability, state: cap.state, attestation: cap.attestation })),
      },
    };
  },

  "patch-agents-by-agentId": async (ctx) => {
    const agentId = ctx.params["agentId"] ?? "";
    if (ctx.principal.subject.kind !== "agent" || ctx.principal.subject.id !== agentId) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    const raw = ctx.body;
    const expected = typeof raw["expected_profile_revision"] === "number" ? raw["expected_profile_revision"] : null;
    const patch = { ...raw };
    delete patch["expected_profile_revision"];
    const safe = filterAgentProfilePatch(patch, ctx.requestId);
    const current = await firstRow<{ profile_revision: number }>(ctx.db, "SELECT profile_revision FROM agents WHERE agent_id = ?", agentId);
    if (current === null) throw notFoundOrHidden(ctx.requestId, "agent", agentId);
    if (expected !== null && expected !== current.profile_revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: current.profile_revision } });
    }
    const now = ctx.now;
    if (typeof safe["display_name"] === "string") {
      await ctx.db
        .prepare("UPDATE agents SET display_name = ?, profile_revision = profile_revision + 1, updated_at = ? WHERE agent_id = ?")
        .bind(safe["display_name"], now, agentId)
        .run();
    } else {
      await ctx.db.prepare("UPDATE agents SET profile_revision = profile_revision + 1, updated_at = ? WHERE agent_id = ?").bind(now, agentId).run();
    }
    if (typeof safe["avatar_asset_id"] === "string") {
      await ctx.db.prepare("UPDATE agents SET avatar_asset_id = ?, updated_at = ? WHERE agent_id = ?").bind(safe["avatar_asset_id"], now, agentId).run();
    }
    const profileFields = ["description", "model_name", "company", "pronouns"] as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of profileFields) {
      if (field in safe) {
        assignments.push(`${field} = ?`);
        values.push(safe[field] ?? null);
      }
    }
    if (assignments.length > 0) {
      await ctx.db
        .prepare(`UPDATE agent_profiles SET ${assignments.join(", ")}, profile_revision = profile_revision + 1, updated_at = ? WHERE agent_id = ?`)
        .bind(...values, now, agentId)
        .run();
    }
    const updated = await firstRow(ctx.db, "SELECT agent_id, display_name, avatar_asset_id, profile_revision, updated_at FROM agents WHERE agent_id = ?", agentId);
    return { status: 200, data: { agent: updated, changed_fields: Object.keys(safe) } };
  },

  "post-providers-by-provider-connect": async (ctx) => {
    const providerKey = ctx.params["provider"] ?? "";
    const entry = providerEntry(providerKey, ctx.requestId);
    // No provider is VERIFIED today, so beginning an OAuth dance would be theatre.
    throw blockedProvider(providerKey, ctx.requestId, entry);
  },

  "post-providers-by-provider-callback": async (ctx) => {
    const providerKey = ctx.params["provider"] ?? "";
    const entry = providerEntry(providerKey, ctx.requestId);
    const state = optionalString(ctx.body, "state");
    if (state === null || state.length < 16) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "state", note: "state/nonce가 없으면 콜백을 받지 않습니다." } });
    }
    // Without a stored challenge (connect never started) a callback cannot be trusted.
    throw blocked(ctx.requestId, "AUTH_CHALLENGE_NOT_ISSUED", {
      provider_key: providerKey,
      provider_state: entry.evidence.state,
      official_doc_urls: entry.evidence.official_doc_urls,
    });
  },

  "post-providers-by-provider-verify": async (ctx) => {
    const providerKey = ctx.params["provider"] ?? "";
    const entry = providerEntry(providerKey, ctx.requestId);
    const capability = optionalString(ctx.body, "capability") ?? "message.send";
    const proof = await entry.adapter.verifyCapability(capability as Parameters<typeof entry.adapter.verifyCapability>[0]);
    throw blocked(ctx.requestId, "CAPABILITY_NOT_VERIFIED", {
      provider_key: providerKey,
      provider_state: entry.evidence.state,
      capability,
      proof_state: proof.state,
      explanation: explainProviderState(entry.evidence.state),
    });
  },

  "get-providers-connections": async (ctx) => {
    const rows = await allRows<{
      connection_id: string;
      agent_id: string;
      provider_key: string;
      auth_method: string;
      actual_identity_state: string;
      connection_state: string;
      last_success_at: string | null;
      expires_at: string | null;
      updated_at: string;
    }>(ctx.db, "SELECT * FROM provider_connections ORDER BY updated_at DESC");
    return {
      status: 200,
      data: {
        items: rows.map((row) => ({
          connection_id: row.connection_id,
          agent_id: row.agent_id,
          provider_key: row.provider_key,
          auth_method: row.auth_method,
          actual_identity_state: row.actual_identity_state,
          connection_state: row.connection_state,
          last_success_at: row.last_success_at,
          expires_at: row.expires_at,
          evidence_note: "실제 공급자 응답 증거가 있으면 actual_identity_state가 provider_verified로 올라갑니다.",
        })),
        roster_gate: "BLOCKED_EXTERNAL_DEPENDENCY",
        checked_at: ctx.now,
      },
    };
  },

  "post-providers-connections-by-id-revoke": async (ctx) => {
    const connectionId = ctx.params["id"] ?? "";
    const row = await firstRow<{ connection_id: string; agent_id: string }>(ctx.db, "SELECT * FROM provider_connections WHERE connection_id = ?", connectionId);
    if (row === null) throw notFoundOrHidden(ctx.requestId, "provider_connection", connectionId);
    await ctx.db
      .prepare("UPDATE provider_connections SET connection_state = 'REVOKED', credential_secret_ref = NULL, updated_at = ? WHERE connection_id = ?")
      .bind(nowIso(), connectionId)
      .run();
    await ctx.db
      .prepare("UPDATE capability_proofs SET state = 'expired' WHERE connection_id = ? AND state = 'verified'")
      .bind(connectionId)
      .run();
    await ctx.auth.audit("provider.connection.revoked", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "provider_connection", connectionId, "deny", ctx.requestId, {
      reason: optionalString(ctx.body, "reason") ?? "",
    });
    return { status: 200, data: { connection_id: connectionId, state: "REVOKED", pending_jobs: "보류 처리 대상으로 표시했습니다." } };
  },
};

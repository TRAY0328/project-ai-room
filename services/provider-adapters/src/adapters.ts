/**
 * Participation adapters — spec 07.1, 07.5, 33.1, Q003.
 *
 * Two adapters, both honest about their limits:
 *
 *  BrowserSessionAdapter — an AI that a human has signed in somewhere can join a
 *  room through the web portal and answer while it is present. It cannot be
 *  driven unattended from a Worker: there is no official server endpoint, so
 *  `sendMessage`/`invokeTask` stay undefined and the adapter reports
 *  AUTONOMY_UNSUPPORTED instead of faking a reply.
 *
 *  LocalTestAgentAdapter — a *test harness*, never a product provider. It proves
 *  the adapter contract by requiring the server nonce to come back in the
 *  response (so a hard-coded "OK" cannot pass), and it is not part of the frozen
 *  roster, so it cannot influence the Q039 gate.
 */
import {
  ApiError,
  toUtcIso,
  type CapabilityProof,
  type ConnectionHealth,
  type ProviderAdapter,
  type ProviderSupportEvidence,
  type VerifiedCapability,
} from "@ai-room/contracts";

export class BrowserSessionAdapter implements ProviderAdapter {
  readonly providerKey: string;
  private readonly support: ProviderSupportEvidence;
  private readonly verifySession: (sessionToken: string) => Promise<{ subjectId: string; label: string } | null>;
  private readonly lastVerified = new Map<VerifiedCapability, CapabilityProof>();

  constructor(input: {
    readonly providerKey: string;
    readonly support: ProviderSupportEvidence;
    readonly verifySession: (sessionToken: string) => Promise<{ subjectId: string; label: string } | null>;
  }) {
    this.providerKey = input.providerKey;
    this.support = input.support;
    this.verifySession = input.verifySession;
  }

  async discoverSupport(): Promise<ProviderSupportEvidence> {
    return this.support;
  }

  /** A joined browser session is authenticated but not unattended. */
  async authenticate(challenge: { state_nonce: string; provider_key: string }): Promise<never> {
    void challenge;
    throw new ApiError({
      code: "CAPABILITY_UNSUPPORTED",
      requestId: "browser-session-adapter",
      message: "브라우저 세션은 사람이 참여 중일 때만 답할 수 있습니다. 서버 무인 인증은 지원하지 않습니다.",
      details: { provider_key: this.providerKey, autonomy: "AUTONOMY_UNSUPPORTED" },
    });
  }

  /** Verifies that a web session token belongs to the claimed AI. */
  async verifyWebSession(sessionToken: string): Promise<{ subjectId: string; label: string }> {
    const verification = await this.verifySession(sessionToken);
    if (verification === null) {
      throw new ApiError({ code: "AUTH_REVOKED", requestId: "browser-session-adapter", details: { provider_key: this.providerKey } });
    }
    return verification;
  }

  async verifyCapability(capability: VerifiedCapability): Promise<CapabilityProof> {
    const cached = this.lastVerified.get(capability);
    if (cached !== undefined) return cached;
    return {
      proof_id: `browser_session_${this.providerKey}_${capability}`,
      connection_id: "none",
      capability,
      state: "unsupported",
      provider_request_ref: null,
      provider_response_id: null,
      challenge_nonce: null,
      observed_at: toUtcIso(Date.now()),
      expires_at: null,
      evidence_asset_id: null,
      attestation: "self_declared",
    };
  }

  async health(): Promise<ConnectionHealth> {
    return {
      connection_id: "browser-session",
      state: "degraded",
      checked_at: toUtcIso(Date.now()),
      last_success_at: null,
      detail: "사람이 브라우저 세션에 있는 동안만 응답 가능(AUTONOMY_UNSUPPORTED)",
    };
  }

  async revoke(): Promise<void> {
    this.lastVerified.clear();
  }
}

export interface TestAgentTransport {
  /** Must echo the server nonce and return its own response id. */
  respond(input: { nonce: string; prompt: string }): Promise<{ echo: string; responseId: string }>;
}

/** Test-only adapter: proves the contract with a real nonce round trip. */
export class LocalTestAgentAdapter implements ProviderAdapter {
  readonly providerKey = "local-test-agent";
  private readonly transport: TestAgentTransport;
  private connectionId = "none";

  constructor(transport: TestAgentTransport, connectionId = "conn_local_test") {
    this.transport = transport;
    this.connectionId = connectionId;
  }

  async discoverSupport(): Promise<ProviderSupportEvidence> {
    return {
      provider_key: this.providerKey,
      display_label: "Local Test Agent (test harness)",
      official_doc_urls: ["https://example.invalid/test-harness"],
      auth_method: "api_key",
      supported_operations: ["message.receive", "message.send"],
      unattended_operation: true,
      cloud_callable: true,
      free_entitlement: "verified_free",
      free_entitlement_note: "테스트 하네스이며 제품 제공자가 아닙니다.",
      terms_version_checked_at: toUtcIso(Date.now()),
      measured_limits: {},
      state: "NOT_CONFIGURED",
      last_checked_at: toUtcIso(Date.now()),
      evidence_ref: "services/provider-adapters/src/adapters.ts",
    };
  }

  async authenticate(challenge: { state_nonce: string }): Promise<never> {
    void challenge;
    throw new ApiError({ code: "CAPABILITY_UNSUPPORTED", requestId: "local-test-agent", message: "테스트 하네스는 실제 인증을 수행하지 않습니다." });
  }

  async verifyCapability(capability: VerifiedCapability): Promise<CapabilityProof> {
    const nonce = `nonce_${Math.random().toString(36).slice(2, 18)}`;
    const response = await this.transport.respond({ nonce, prompt: `capability:${capability}` });
    const echoed = response.echo === nonce && response.responseId.length > 0;
    return {
      proof_id: `proof_${capability}_${response.responseId}`,
      connection_id: this.connectionId,
      capability,
      state: echoed ? "verified" : "failed",
      provider_request_ref: `req_${capability}`,
      provider_response_id: response.responseId,
      challenge_nonce: echoed ? nonce : null,
      observed_at: toUtcIso(Date.now()),
      expires_at: toUtcIso(Date.now() + 60 * 60 * 1000),
      evidence_asset_id: null,
      // A real round trip is still only discovery-verified until the provider attests.
      attestation: "discovery_verified",
    };
  }

  async health(): Promise<ConnectionHealth> {
    return { connection_id: this.connectionId, state: "healthy", checked_at: toUtcIso(Date.now()), last_success_at: null, detail: "test harness" };
  }

  async revoke(): Promise<void> {
    this.connectionId = "none";
  }
}

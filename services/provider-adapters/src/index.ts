/**
 * Provider adapters — spec 07, 34, Q003/Q037/Q039
 *
 * Every entry below is what today's official documentation actually supports,
 * checked 2026-11-21 (see docs/evidence/provider-capabilities.md). None of them
 * is "connected": the registry deliberately has no adapter that can pretend to
 * receive or send a message on a provider's behalf.
 *
 * A blocked provider is a *product state*, not an error to hide: the UI shows
 * the official reason + the documentation link + what the owner could do next.
 */
import {
  ApiError,
  evaluateRequiredRoster,
  toUtcIso,
  type CapabilityProof,
  type ConnectionHealth,
  type ProviderAdapter,
  type ProviderState,
  type ProviderSupportEvidence,
  type RequiredAgent,
  type VerifiedCapability,
} from "@ai-room/contracts";

export interface ProviderRegistryEntry {
  readonly evidence: ProviderSupportEvidence;
  readonly adapter: ProviderAdapter;
}

const CHECKED_AT = toUtcIso(Date.parse("2026-11-21T03:40:00.000Z"));

function evidence(input: Omit<ProviderSupportEvidence, "last_checked_at" | "measured_limits" | "free_entitlement_note" | "terms_version_checked_at"> & {
  free_entitlement_note?: string;
}): ProviderSupportEvidence {
  return {
    ...input,
    measured_limits: {},
    free_entitlement_note: input.free_entitlement_note ?? "",
    terms_version_checked_at: CHECKED_AT,
    last_checked_at: CHECKED_AT,
  };
}

/**
 * An adapter for a provider that cannot be driven from a Worker without the
 * owner paying for a new API, or that has no official server API at all.
 * `discoverSupport` still answers truthfully; every action refuses.
 */
export class BlockedProviderAdapter implements ProviderAdapter {
  readonly providerKey: string;
  private readonly support: ProviderSupportEvidence;

  constructor(support: ProviderSupportEvidence) {
    this.providerKey = support.provider_key;
    this.support = support;
  }

  async discoverSupport(): Promise<ProviderSupportEvidence> {
    return this.support;
  }

  async authenticate(): Promise<never> {
    throw new ApiError({
      code: "EXTERNAL_DEPENDENCY_BLOCKED",
      requestId: "provider-adapter",
      details: { provider_key: this.providerKey, state: this.support.state },
    });
  }

  async verifyCapability(capability: VerifiedCapability): Promise<CapabilityProof> {
    return {
      proof_id: `blocked_${this.providerKey}_${capability}`,
      connection_id: "none",
      capability,
      state: "unsupported",
      provider_request_ref: null,
      provider_response_id: null,
      challenge_nonce: null,
      observed_at: CHECKED_AT,
      expires_at: null,
      evidence_asset_id: null,
      attestation: "self_declared",
    };
  }

  async health(): Promise<ConnectionHealth> {
    return {
      connection_id: "none",
      state: "blocked",
      checked_at: CHECKED_AT,
      last_success_at: null,
      detail: this.support.state,
    };
  }

  async revoke(): Promise<void> {
    // Nothing is connected, so there is nothing to revoke.
  }
}

const PROVIDERS: readonly ProviderSupportEvidence[] = [
  evidence({
    provider_key: "chatgpt",
    display_label: "ChatGPT",
    official_doc_urls: [
      "https://platform.openai.com/docs/pricing",
      "https://developers.openai.com/api/docs/guides/rate-limits",
    ],
    auth_method: "api_key",
    supported_operations: ["responses", "chat.completions"],
    unattended_operation: true,
    cloud_callable: true,
    free_entitlement: "unknown",
    free_entitlement_note:
      "Pricing page lists per-token prices for every current model; the rate-limit guide has a geography-gated 'Free' usage tier capped at $100/month whose zero-cost meaning is not stated. No account, key, or credit balance exists here, so nothing is verified.",
    state: "NOT_CONFIGURED",
    evidence_ref: "docs/evidence/provider-capabilities.md#chatgpt",
  }),
  evidence({
    provider_key: "claude",
    display_label: "Claude",
    official_doc_urls: [
      "https://platform.claude.com/docs/en/about-claude/pricing",
      "https://platform.claude.com/docs/en/api/overview",
    ],
    auth_method: "api_key",
    supported_operations: ["messages"],
    unattended_operation: true,
    cloud_callable: true,
    free_entitlement: "trial_only",
    free_entitlement_note: "New accounts receive one-off test credits; ongoing Anthropic API use is prepaid credit purchase.",
    state: "PAID_API_REQUIRED",
    evidence_ref: "docs/evidence/provider-capabilities.md#claude",
  }),
  evidence({
    provider_key: "gemini",
    display_label: "Gemini",
    official_doc_urls: [
      "https://ai.google.dev/gemini-api/docs/rate-limits",
      "https://aistudio.google.com/docs/billing",
    ],
    auth_method: "api_key",
    supported_operations: ["generateContent"],
    unattended_operation: true,
    cloud_callable: true,
    free_entitlement: "verified_free",
    free_entitlement_note:
      "Free usage tier with per-model RPM/TPM/RPD limits exists; on the free tier prompts may be used to improve Google products. No API key is configured in this environment.",
    state: "NOT_CONFIGURED",
    evidence_ref: "docs/evidence/provider-capabilities.md#gemini",
  }),
  evidence({
    provider_key: "pickle",
    display_label: "PICKLE",
    official_doc_urls: ["https://docs.meta.ai/"],
    auth_method: "none_documented",
    supported_operations: [],
    unattended_operation: false,
    cloud_callable: false,
    free_entitlement: "unknown",
    free_entitlement_note:
      "No public provider API documented for server-to-server calls from a Worker. Spec 07.5 requires an owner-operated adapter, which does not exist yet.",
    state: "NO_OFFICIAL_EVIDENCE",
    evidence_ref: "docs/evidence/provider-capabilities.md#pickle",
  }),
  evidence({
    provider_key: "keyring",
    display_label: "KeyRing",
    official_doc_urls: ["https://www.keyringlabs.com/docs", "https://www.keyringlabs.com/docs/api-settings"],
    auth_method: "none_documented",
    supported_operations: [],
    unattended_operation: false,
    cloud_callable: false,
    free_entitlement: "paid_only",
    free_entitlement_note:
      "Local-first Windows desktop app that calls providers with the user's own keys, explicitly no hosted relay. A cloud-only server cannot drive it.",
    state: "NO_OFFICIAL_EVIDENCE",
    evidence_ref: "docs/evidence/provider-capabilities.md#keyring",
  }),
  evidence({
    provider_key: "vooy",
    display_label: "vooy",
    official_doc_urls: ["https://vooy.com/en", "https://vooy.com/en/docs/terms/2026-10-30"],
    auth_method: "none_documented",
    supported_operations: [],
    unattended_operation: false,
    cloud_callable: false,
    free_entitlement: "unknown",
    free_entitlement_note:
      "Consumer messenger agent with a free tier for users; no public developer API or server authentication is documented, and the terms forbid automated load.",
    state: "NO_OFFICIAL_EVIDENCE",
    evidence_ref: "docs/evidence/provider-capabilities.md#vooy",
  }),
  evidence({
    provider_key: "muse",
    display_label: "MUSE (Meta Model API)",
    official_doc_urls: ["https://dev.meta.ai/docs/overview", "https://dev.meta.ai/docs/pricing-rate-limits"],
    auth_method: "api_key",
    supported_operations: ["responses", "chat.completions", "messages"],
    unattended_operation: true,
    cloud_callable: true,
    free_entitlement: "paid_only",
    free_entitlement_note: "Pay-as-you-go per token; 'Contributor mode' is discounted, not free.",
    state: "PAID_API_REQUIRED",
    evidence_ref: "docs/evidence/provider-capabilities.md#muse",
  }),
  evidence({
    provider_key: "cue",
    display_label: "CUE (Cue AI)",
    official_doc_urls: ["https://docs.trycue.ai/", "https://docs.trycue.ai/customer-analytics/getting-started"],
    auth_method: "api_key",
    supported_operations: ["analytics.query", "dashboard.embed"],
    unattended_operation: false,
    cloud_callable: true,
    free_entitlement: "unknown",
    free_entitlement_note:
      "Embedded product-analytics service (metrics/dashboards), not an LLM agent: no chat, task, or code-edit surface to connect.",
    state: "CAPABILITY_MISSING",
    evidence_ref: "docs/evidence/provider-capabilities.md#cue",
  }),
];

export function buildProviderRegistry(): Map<string, ProviderRegistryEntry> {
  const registry = new Map<string, ProviderRegistryEntry>();
  for (const support of PROVIDERS) {
    registry.set(support.provider_key, { evidence: support, adapter: new BlockedProviderAdapter(support) });
  }
  return registry;
}

/** The roster frozen by the owner's Q003 list; every entry is required. */
export const REQUIRED_ROSTER: readonly RequiredAgent[] = [
  "chatgpt",
  "claude",
  "gemini",
  "pickle",
  "keyring",
  "vooy",
  "muse",
  "cue",
].map((providerKey) => ({
  provider_key: providerKey,
  display_label: providerKey,
  required: true,
  verification_state: "blocked" as const,
  proof: null,
}));

export function q039Gate(): {
  gate: "PASS" | "BLOCKED_EXTERNAL_DEPENDENCY";
  blockers: ReadonlyArray<{ providerKey: string; state: ProviderState | "unknown" }>;
} {
  const evaluation = evaluateRequiredRoster(REQUIRED_ROSTER, PROVIDERS);
  return { gate: evaluation.gate, blockers: evaluation.blockers };
}

/** Human-facing explanation for a blocked provider; used by the UI and reports. */
export function explainProviderState(state: ProviderState): string {
  switch (state) {
    case "VERIFIED":
      return "공식 문서와 실제 호출 증거로 검증되었습니다.";
    case "PAID_API_REQUIRED":
      return "공식 API가 유료 추론 과금을 전제로 합니다. 추가 유료 API 금지 조건에 따라 연결하지 않았습니다.";
    case "NO_OFFICIAL_EVIDENCE":
      return "서버가 무인으로 호출할 수 있는 공식 API 문서가 없습니다.";
    case "CAPABILITY_MISSING":
      return "공식 API는 있으나 채팅·작업·코드 변경 기능이 없습니다.";
    case "NOT_CONFIGURED":
      return "공식 연동 경로는 있으나 이 환경에 계정·키가 설정되지 않았습니다.";
    case "NO_FREE_CAPACITY":
      return "무료 한도가 남아 있지 않습니다.";
    case "AUTONOMY_UNSUPPORTED":
      return "공식 방식으로 무인 자동 실행이 불가능합니다.";
    case "AUTH_UNSUPPORTED":
      return "공식 인증 방식으로 서버 인증이 불가능합니다.";
    case "TERMS_UNVERIFIED":
      return "이용약관상 자동 호출 허용 여부가 확인되지 않았습니다.";
    case "TOKEN_EXPIRED":
      return "자격 증명이 만료되어 재인증이 필요합니다.";
    case "TEMPORARY_ERROR":
      return "공급자 일시 오류입니다. 재시도 가능합니다.";
    default:
      return "검증 전 상태입니다.";
  }
}

// Autonomy guards (FAST/NATURAL/ECO), continuity engine and the participation
// adapters live in separate modules and are re-exported here so services import
// one package.
export * from "./autonomy.js";
export * from "./continuity.js";
export * from "./adapters.js";

/**
 * Provider adapter contract — spec 07.1, 07.3, 34.2, 34.6
 *
 * The rule this file encodes: an adapter may only declare what the provider
 * officially lets it do. Anything else is `UNSUPPORTED`, and a provider without
 * a documented free unattended path is `BLOCKED_EXTERNAL_DEPENDENCY` — never a
 * mocked success, never a fabricated message.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "./time.js";

export const VERIFIED_CAPABILITIES = [
  "message.receive",
  "message.send",
  "task.claim",
  "task.execute",
  "code.patch",
  "git.pr.create",
  "git.review",
  "artifact.read",
  "checkpoint.resume",
] as const;
export type VerifiedCapability = (typeof VERIFIED_CAPABILITIES)[number];
export const zVerifiedCapability = z.enum(VERIFIED_CAPABILITIES);

/** Capability lifecycle (spec 07.3). `expired` keeps the last proof, not a pass. */
export const CAPABILITY_STATES = ["unknown", "testing", "verified", "unsupported", "failed", "expired"] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];
export const zCapabilityState = z.enum(CAPABILITY_STATES);

/** Provider failure states (spec 34.6) — the vocabulary used in evidence docs. */
export const PROVIDER_STATES = [
  "NOT_CONFIGURED",
  "NO_OFFICIAL_EVIDENCE",
  "TERMS_UNVERIFIED",
  "AUTH_UNSUPPORTED",
  "AUTONOMY_UNSUPPORTED",
  "PAID_API_REQUIRED",
  "NO_FREE_CAPACITY",
  "CAPABILITY_MISSING",
  "TOKEN_EXPIRED",
  "TEMPORARY_ERROR",
  "VERIFIED",
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];
export const zProviderState = z.enum(PROVIDER_STATES);

/** Identity proof levels; a name typed into a profile is not proof. */
export const ATTESTATION_LEVELS = ["self_declared", "discovery_verified", "provider_verified"] as const;
export type AttestationLevel = (typeof ATTESTATION_LEVELS)[number];
export const zAttestationLevel = z.enum(ATTESTATION_LEVELS);

export const zProviderAuthMethod = z.enum([
  "oauth2",
  "api_key",
  "app_installation",
  "signed_webhook",
  "none_documented",
]);

export const zProviderSupportEvidence = z.object({
  provider_key: z.string().min(1),
  display_label: z.string().min(1),
  /** Official documentation the capability claim is based on. */
  official_doc_urls: z.array(z.string().url()).min(1),
  auth_method: zProviderAuthMethod,
  supported_operations: z.array(z.string().min(1)),
  /** Can the provider act without a human clicking in a browser each time? */
  unattended_operation: z.boolean(),
  /** Can it be driven from a Cloudflare Worker (no local desktop bridge)? */
  cloud_callable: z.boolean(),
  /** Verified entitlement text, not an assumption. */
  free_entitlement: z.enum(["verified_free", "paid_only", "trial_only", "unknown"]),
  free_entitlement_note: z.string().default(""),
  terms_version_checked_at: zUtcIsoMillis.nullable(),
  measured_limits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  state: zProviderState,
  last_checked_at: zUtcIsoMillis,
  evidence_ref: z.string().min(1).nullable(),
});

export type ProviderSupportEvidence = z.infer<typeof zProviderSupportEvidence>;

export const zCapabilityProof = z.object({
  proof_id: z.string().min(1),
  connection_id: z.string().min(1),
  capability: zVerifiedCapability,
  state: zCapabilityState,
  provider_request_ref: z.string().min(1).nullable(),
  provider_response_id: z.string().min(1).nullable(),
  /** Server nonce that the provider actually echoed back in its response. */
  challenge_nonce: z.string().min(1).nullable(),
  observed_at: zUtcIsoMillis,
  expires_at: zUtcIsoMillis.nullable(),
  evidence_asset_id: z.string().min(1).nullable(),
  attestation: zAttestationLevel,
});

export type CapabilityProof = z.infer<typeof zCapabilityProof>;

export const zAuthChallenge = z.object({
  challenge_id: z.string().min(1),
  provider_key: z.string().min(1),
  method: zProviderAuthMethod,
  authorize_url: z.string().url().nullable(),
  state_nonce: z.string().min(16),
  code_verifier_required: z.boolean(),
  expires_at: zUtcIsoMillis,
});

export type AuthChallenge = z.infer<typeof zAuthChallenge>;

export const zAuthResult = z.object({
  connection_id: z.string().min(1),
  provider_key: z.string().min(1),
  /** Opaque handle to the sealed credential; never the secret itself. */
  credential_secret_ref: z.string().min(1),
  granted_scopes: z.array(z.string()),
  actual_identity_state: zAttestationLevel,
  account_label: z.string().min(1).nullable(),
  expires_at: zUtcIsoMillis.nullable(),
});

export type AuthResult = z.infer<typeof zAuthResult>;

export const zInboundEvent = z.object({
  provider_event_id: z.string().min(1),
  provider_timestamp: zUtcIsoMillis.nullable(),
  server_received_at: zUtcIsoMillis,
  cursor: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type InboundEvent = z.infer<typeof zInboundEvent>;

export const zOutboundMessage = z.object({
  delivery_key: z.string().min(1),
  room_id: z.string().min(1),
  message_id: z.string().min(1),
  body_text: z.string(),
  blocks_json: z.string(),
});

export type OutboundMessage = z.infer<typeof zOutboundMessage>;

export const zDeliveryReceipt = z.object({
  delivery_key: z.string().min(1),
  state: z.enum(["QUEUED", "SENT", "DELIVERED", "ACKNOWLEDGED_BY_AGENT", "READ_CONFIRMED", "FAILED", "UNSUPPORTED"]),
  provider_message_ref: z.string().min(1).nullable(),
  sent_at: zUtcIsoMillis,
  /** Never true without a provider-side acknowledgement. */
  acknowledged_by_provider: z.boolean(),
});

export type DeliveryReceipt = z.infer<typeof zDeliveryReceipt>;

export const zAgentTask = z.object({
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  attempt_id: z.string().min(1),
  fencing_generation: z.number().int().positive(),
  instructions: z.string(),
  context_refs: z.array(z.string()),
});

export type AgentTask = z.infer<typeof zAgentTask>;

export const zInvocationReceipt = z.object({
  task_id: z.string().min(1),
  provider_invocation_id: z.string().min(1),
  state: z.enum(["accepted", "running", "succeeded", "failed", "unsupported"]),
  accepted_at: zUtcIsoMillis,
});

export type InvocationReceipt = z.infer<typeof zInvocationReceipt>;

export const zCodeChange = z.object({
  task_id: z.string().min(1),
  base_sha: z.string().min(40).max(64),
  branch: z.string().min(1),
  patch_text: z.string(),
});

export type CodeChange = z.infer<typeof zCodeChange>;

export const zGitEvidence = z.object({
  commit_sha: z.string().min(40).max(64),
  provider_attestation_id: z.string().min(1).nullable(),
  pull_request_url: z.string().url().nullable(),
  created_at: zUtcIsoMillis,
});

export type GitEvidence = z.infer<typeof zGitEvidence>;

export const zConnectionHealth = z.object({
  connection_id: z.string().min(1),
  state: z.enum(["healthy", "degraded", "expired", "revoked", "blocked"]),
  checked_at: zUtcIsoMillis,
  last_success_at: zUtcIsoMillis.nullable(),
  detail: z.string().default(""),
});

export type ConnectionHealth = z.infer<typeof zConnectionHealth>;

/**
 * The adapter every provider integration implements (spec 34.2). Optional
 * members are the honest way to say "this provider cannot do that": leave the
 * member undefined and report the capability as `unsupported`.
 */
export interface ProviderAdapter {
  readonly providerKey: string;
  discoverSupport(): Promise<ProviderSupportEvidence>;
  authenticate(challenge: AuthChallenge): Promise<AuthResult>;
  verifyCapability(capability: VerifiedCapability): Promise<CapabilityProof>;
  deliverMessage?(request: OutboundMessage): Promise<DeliveryReceipt>;
  pollResult?(deliveryKey: string): Promise<DeliveryReceipt>;
  cancel?(taskId: string, reason: string): Promise<{ taskId: string; cancelled: boolean }>;
  health(): Promise<ConnectionHealth>;
  revoke(): Promise<void>;
}

/** A provider entry in the frozen required roster (Q039 gate). */
export const zRequiredAgent = z.object({
  provider_key: z.string().min(1),
  display_label: z.string().min(1),
  required: z.boolean(),
  verification_state: z.enum(["unknown", "testing", "verified", "unsupported", "blocked", "expired"]),
  proof: z.string().min(1).nullable(),
});

export type RequiredAgent = z.infer<typeof zRequiredAgent>;

export interface RequiredRosterEvaluation {
  readonly gate: "PASS" | "BLOCKED_EXTERNAL_DEPENDENCY";
  readonly requiredCount: number;
  readonly verifiedCount: number;
  readonly blockers: readonly { providerKey: string; state: ProviderState | "unknown" }[];
}

/**
 * Q039 gate: the release is only open when every `required` provider has a
 * provider-verified capability proof. Missing proof blocks; it never warns.
 */
export function evaluateRequiredRoster(
  roster: readonly RequiredAgent[],
  evidence: readonly ProviderSupportEvidence[],
): RequiredRosterEvaluation {
  const byProvider = new Map(evidence.map((item) => [item.provider_key, item]));
  const required = roster.filter((entry) => entry.required);
  const blockers: { providerKey: string; state: ProviderState | "unknown" }[] = [];
  let verifiedCount = 0;
  for (const entry of required) {
    const found = byProvider.get(entry.provider_key);
    if (found === undefined) {
      blockers.push({ providerKey: entry.provider_key, state: "unknown" });
      continue;
    }
    if (found.state === "VERIFIED" && entry.verification_state === "verified") {
      verifiedCount += 1;
    } else {
      blockers.push({ providerKey: entry.provider_key, state: found.state });
    }
  }
  return {
    gate: required.length > 0 && verifiedCount === required.length ? "PASS" : "BLOCKED_EXTERNAL_DEPENDENCY",
    requiredCount: required.length,
    verifiedCount,
    blockers,
  };
}

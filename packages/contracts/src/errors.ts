/**
 * Error contract — spec 19.1, 19.4, 40.4
 *
 * Every failure leaves the API as the same envelope, carrying a stable machine
 * code, a human message in the user's language, `retryable`, and the
 * `request_id` that ties it to logs. Internal messages, stack traces, SQL and
 * secret values never reach the client.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "./time.js";

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "INVITE_INVALID",
  "PROVIDER_UNVERIFIED",
  "CAPABILITY_UNSUPPORTED",
  "PERMISSION_DENIED",
  "PROJECT_NOT_FOUND",
  "ROOM_ACCESS_DENIED",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CONTENT_TOO_LARGE",
  "MIME_REJECTED",
  "FILE_SCAN_PENDING",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "CI_UNAVAILABLE",
  "CI_FAILED",
  "TEST_NOT_RUN",
  "APPROVAL_REQUIRED",
  "APPROVAL_STALE",
  "ARTIFACT_NOT_VERIFIED",
  "RETRY_LATER",
  "EXTERNAL_DEPENDENCY_BLOCKED",
  "INTERNAL_ERROR",
  /** Extension: request body / query failed schema validation (HTTP 400). */
  "VALIDATION_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const zErrorCode = z.enum(ERROR_CODES);

/** Retryable means: the same request may succeed later without changing it. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "CI_UNAVAILABLE",
  "FILE_SCAN_PENDING",
  "RETRY_LATER",
  "EXTERNAL_DEPENDENCY_BLOCKED",
  "INTERNAL_ERROR",
]);

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  AUTH_REVOKED: 401,
  INVITE_INVALID: 403,
  PROVIDER_UNVERIFIED: 412,
  CAPABILITY_UNSUPPORTED: 422,
  PERMISSION_DENIED: 403,
  PROJECT_NOT_FOUND: 404,
  ROOM_ACCESS_DENIED: 403,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONTENT_TOO_LARGE: 413,
  MIME_REJECTED: 415,
  FILE_SCAN_PENDING: 409,
  RATE_LIMITED: 429,
  QUOTA_EXHAUSTED: 429,
  CI_UNAVAILABLE: 503,
  CI_FAILED: 422,
  TEST_NOT_RUN: 412,
  APPROVAL_REQUIRED: 428,
  APPROVAL_STALE: 412,
  ARTIFACT_NOT_VERIFIED: 412,
  RETRY_LATER: 503,
  EXTERNAL_DEPENDENCY_BLOCKED: 503,
  INTERNAL_ERROR: 500,
  VALIDATION_FAILED: 400,
};

const DEFAULT_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: "인증이 필요합니다.",
  AUTH_EXPIRED: "세션이 만료되었습니다. 다시 인증해 주세요.",
  AUTH_REVOKED: "폐기된 자격 증명입니다.",
  INVITE_INVALID: "유효하지 않거나 이미 사용된 초대입니다.",
  PROVIDER_UNVERIFIED: "공급자 신원 검증이 완료되지 않았습니다.",
  CAPABILITY_UNSUPPORTED: "이 공급자는 요청한 기능을 공식적으로 지원하지 않습니다.",
  PERMISSION_DENIED: "이 작업을 수행할 권한이 없습니다.",
  PROJECT_NOT_FOUND: "프로젝트를 찾을 수 없습니다.",
  ROOM_ACCESS_DENIED: "이 방에 접근할 수 없습니다.",
  REVISION_CONFLICT: "다른 변경이 먼저 저장되었습니다. 최신 내용을 확인해 주세요.",
  IDEMPOTENCY_CONFLICT: "같은 멱등성 키로 다른 요청이 이미 처리되었습니다.",
  CONTENT_TOO_LARGE: "허용된 크기를 초과했습니다.",
  MIME_REJECTED: "허용되지 않는 파일 형식입니다.",
  FILE_SCAN_PENDING: "파일 검사가 끝나지 않았습니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  QUOTA_EXHAUSTED: "이번 기간의 무료 한도를 모두 사용했습니다.",
  CI_UNAVAILABLE: "CI 실행기를 사용할 수 없습니다.",
  CI_FAILED: "CI가 실패했습니다.",
  TEST_NOT_RUN: "필수 테스트가 실행되지 않았습니다.",
  APPROVAL_REQUIRED: "사람 소유자의 승인이 필요합니다.",
  APPROVAL_STALE: "승인 이후 대상이 변경되어 승인이 무효화되었습니다.",
  ARTIFACT_NOT_VERIFIED: "산출물 검증이 완료되지 않았습니다.",
  RETRY_LATER: "잠시 후 다시 시도해 주세요.",
  EXTERNAL_DEPENDENCY_BLOCKED: "외부 의존성 때문에 완료할 수 없습니다.",
  INTERNAL_ERROR: "내부 오류가 발생했습니다.",
  VALIDATION_FAILED: "요청 형식이 올바르지 않습니다.",
};

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export function defaultMessageFor(code: ErrorCode): string {
  return DEFAULT_MESSAGE[code];
}

/**
 * Backoff advice handed to clients so a retry storm does not form.
 * Full jitter: delay = random(0, min(max, base * multiplier^attempt)).
 */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly multiplier: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 60_000, multiplier: 2 };

export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError("attempt must be a non-negative integer");
  const ceiling = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.multiplier, attempt));
  return Math.round(random() * ceiling);
}

/** Error body exactly as spec 19.1 shows it. `details` is always an object. */
export const zApiErrorBody = z.object({
  code: zErrorCode,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const zApiErrorResponse = z.object({
  ok: z.literal(false),
  error: zApiErrorBody,
  request_id: z.string().min(1),
});

export type ApiErrorBody = z.infer<typeof zApiErrorBody>;
export type ApiErrorResponse = z.infer<typeof zApiErrorResponse>;

/** Success envelope. `data` is the endpoint-specific payload. */
export const zApiSuccessResponse = <T extends z.ZodType>(data: T) =>
  z.object({
    ok: z.literal(true),
    data,
    request_id: z.string().min(1),
    server_time: zUtcIsoMillis,
  });

export interface ApiFailureInput {
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/** Thrown inside services; serialized once at the edge by `toApiErrorResponse`. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(input: ApiFailureInput) {
    super(input.message ?? defaultMessageFor(input.code));
    this.name = "ApiError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.details = input.details ?? {};
    this.retryable = isRetryable(input.code);
    this.httpStatus = httpStatusFor(input.code);
  }

  toResponse(): ApiErrorResponse {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        details: this.details,
      },
      request_id: this.requestId,
    };
  }
}

export function toApiErrorResponse(error: unknown, requestId: string): ApiErrorResponse {
  if (error instanceof ApiError) return error.toResponse();
  // Never leak an unexpected error's message to the client; keep it in logs only.
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: defaultMessageFor("INTERNAL_ERROR"),
      retryable: true,
      details: {},
    },
    request_id: requestId,
  };
}

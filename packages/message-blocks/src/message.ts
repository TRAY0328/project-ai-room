/**
 * Message envelope rendering (spec 10.1, 10.4).
 *
 * Delivery and edit state are evidence, not decoration:
 *  - "server_stored" only when the server acknowledged the write;
 *  - "delivered"/"read" only when an ACK/read event exists (the UI passes it);
 *  - a deleted message renders a tombstone that says who deleted it and when;
 *  - versions form a chain where each revision hashes its predecessor.
 */
import { el, txt, type MessageBlock, type MessageEnvelope, type MessageVersionRef, type RenderOptions, type VNode } from "./types.js";
import { renderBlock } from "./blocks.js";
import { formatRelative, formatUtc } from "./text.js";

export interface DeliveryEvidence {
  state: MessageEnvelope["delivery"];
  /** Server ack id / read event id — shown on hover, never invented. */
  evidence?: string;
}

const DELIVERY_TEXT: Record<NonNullable<MessageEnvelope["delivery"]>, { label: string; tone: "neutral" | "ok" | "warn" | "danger" }> = {
  queued: { label: "전송 대기", tone: "warn" },
  server_stored: { label: "서버 저장됨", tone: "ok" },
  delivered: { label: "전달 확인", tone: "ok" },
  read: { label: "읽음 확인", tone: "ok" },
  failed: { label: "전송 실패", tone: "danger" },
};

export function deliveryBadge(delivery: MessageEnvelope["delivery"]): VNode {
  if (!delivery) return el("span", { class: "mb-muted mb-small" }, txt("전달 상태 미확인"));
  const info = DELIVERY_TEXT[delivery];
  return el("span", { class: `mb-delivery mb-badge mb-badge-${info.tone}` }, txt(info.label));
}

export interface VersionChainResult {
  ok: boolean;
  problems: string[];
  /** Newest first. */
  ordered: MessageVersionRef[];
}

/** Checks that revisions are contiguous and hashes are well formed. */
export function validateVersionChain(versions: readonly MessageVersionRef[]): VersionChainResult {
  const problems: string[] = [];
  const ordered = [...versions].sort((a, b) => b.revision - a.revision);
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i]!;
    if (!/^[0-9a-f]{64}$/i.test(current.body_sha256)) problems.push(`revision ${current.revision}: body_sha256 형식 오류`);
    const next = ordered[i + 1];
    if (next && current.revision - next.revision !== 1) problems.push(`revision ${current.revision} → ${next.revision} 건너뜀`);
  }
  return { ok: problems.length === 0, problems, ordered };
}

export function versionHistoryBlock(versions: readonly MessageVersionRef[]): VNode {
  const chain = validateVersionChain(versions);
  return el(
    "div",
    { class: "mb-versions" },
    el("div", { class: "mb-ref-title" }, txt("편집 기록")),
    chain.ok ? null : el("div", { class: "mb-badge mb-badge-warn" }, txt("버전 체인 불완전 — 신뢰할 수 없는 기록")),
    el(
      "ul",
      { class: "mb-timeline" },
      ...chain.ordered.map((v) =>
        el(
          "li",
          null,
          el("span", { class: "air-mono mb-small" }, txt(`r${v.revision}`)),
          el("span", { class: "air-mono mb-small" }, txt(` ${v.body_sha256.slice(0, 10)}…`)),
          el("span", { class: "mb-muted mb-small" }, txt(` ${formatUtc(v.created_at)}${v.editor_actor_id ? ` · ${v.editor_actor_id}` : ""}`)),
        ),
      ),
    ),
  );
}

function tombstone(message: MessageEnvelope): VNode {
  const when = message.deleted_at ? formatUtc(message.deleted_at) : "시각 미기록";
  return el(
    "div",
    { class: "mb-tombstone", role: "note" },
    el("span", { class: "mb-badge mb-badge-neutral" }, txt("삭제됨")),
    el("span", { class: "mb-muted mb-small" }, txt(`이 메시지는 삭제되었습니다 (${when}). 저장소 정리 정책에 따라 원문·파생 기억·색인·백업에 삭제가 전파됩니다.`)),
  );
}

export interface RenderedMessage {
  node: VNode;
  /** Feature ids demonstrably exercised by this message. */
  features: string[];
  /** Warnings the UI should surface (e.g. unknown block type, broken version chain). */
  warnings: string[];
}

export function renderMessage(message: MessageEnvelope, options: RenderOptions = {}): RenderedMessage {
  const features = new Set<string>();
  const warnings: string[] = [];
  const blocks: VNode[] = [];

  for (const block of message.blocks ?? []) {
    blocks.push(renderBlock(block, options));
    if (!isKnownBlock(block)) warnings.push(`알 수 없는 블록 타입: ${block.type}`);
  }

  const edited = Boolean(message.edited_at);
  if (edited) features.add("F-088");
  features.add("F-079");
  features.add("F-093");

  const meta: Array<VNode | null> = [
    el("span", { class: "mb-author" }, txt(message.author?.display_name ?? "알 수 없는 발신자")),
    el(
      "time",
      { class: "mb-time", datetime: message.created_at, title: formatUtc(message.created_at) },
      txt(formatRelative(message.created_at, options.now)),
    ),
    deliveryBadge(message.delivery),
    message.room_seq !== null && message.room_seq !== undefined
      ? el("span", { class: "air-mono mb-small mb-muted" }, txt(`seq ${message.room_seq}`))
      : null,
    message.author?.attestation === "provider_verified"
      ? el("span", { class: "mb-badge mb-badge-ok" }, txt("공급자 검증"))
      : message.author?.attestation === "self_declared"
        ? el("span", { class: "mb-badge mb-badge-warn mb-badge-dashed" }, txt("자체 신고"))
        : null,
  ];

  const body = message.deleted_at
    ? tombstone(message)
    : el(
        "div",
        { class: "mb-blocks" },
        ...blocks,
        edited
          ? el(
              "div",
              { class: "mb-edited" },
              el("span", { class: "mb-badge mb-badge-neutral mb-badge-dashed" }, txt("수정됨")),
              message.versions?.length ? versionHistoryBlock(message.versions) : el("span", { class: "mb-muted mb-small" }, txt(" 편집 기록 미제공")),
            )
          : null,
      );
  if (message.deleted_at) features.add("F-089");

  const node = el(
    "article",
    {
      class: "mb-message",
      "data-message-id": message.id,
      "data-deleted": message.deleted_at ? "true" : "false",
      "aria-label": `${message.author?.display_name ?? "발신자"} 메시지`,
    },
    el("header", { class: "mb-head" }, ...meta),
    body,
    message.reply_count && message.reply_count > 0
      ? el("div", { class: "mb-thread-count" }, txt(`스레드 답글 ${message.reply_count}개`))
      : null,
    message.project_id ? el("div", { class: "mb-project-link" }, el("span", { class: "mb-muted mb-small" }, txt(`프로젝트 ${message.project_id}`))) : null,
  );

  return { node, features: [...features], warnings };
}

function isKnownBlock(block: MessageBlock): boolean {
  return [
    "text", "markdown", "code", "diff", "terminal_log", "test_result", "file_ref", "image_ref", "video_ref",
    "audio_ref", "json", "table", "chart", "task_ref", "project_ref", "commit_ref", "pr_ref", "approval_ref",
    "poll", "status", "link_preview", "callout", "quote", "memory_ref", "artifact_ref",
  ].includes(block.type);
}

/** Groups consecutive image blocks so a multi-image message reads as one gallery. */
export function groupImageBlocks(blocks: readonly MessageBlock[]): MessageBlock[][] {
  const groups: MessageBlock[][] = [];
  let current: MessageBlock[] = [];
  for (const block of blocks) {
    if (block.type === "image_ref") {
      current.push(block);
      continue;
    }
    if (current.length) {
      groups.push(current);
      current = [];
    }
    groups.push([block]);
  }
  if (current.length) groups.push(current);
  return groups;
}

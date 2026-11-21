import { useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Field, SectionHeader, TextArea, Icon, RunStateBadge } from "@ai-room/design-system";
import { DiffViewer, type DiffAnchor } from "./DiffViewer.js";

export interface ReviewComment {
  id: string;
  path: string;
  side: "new" | "old";
  line: number;
  head_sha: string;
  author: string;
  body: string;
  created_at: string;
  resolved?: boolean;
}

export interface ReviewApproval {
  reviewer: string;
  sha: string;
  decision: "approved" | "changes_requested";
  at: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  evidence?: string;
}

export interface ReviewState {
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  state: "open" | "draft" | "merged" | "closed";
  /** Result of the required checks as reported by GitHub, never assumed. */
  checks: "success" | "failure" | "pending" | "none";
  risk: "low" | "medium" | "high";
  comments: ReviewComment[];
  approvals: ReviewApproval[];
  checklist: ChecklistItem[];
}

export interface ReviewPanelProps {
  review: ReviewState;
  diff: string;
  onAddComment?: (anchor: DiffAnchor, body: string) => void;
  onApprove?: (sha: string) => void;
  onRequestChanges?: (sha: string) => void;
  onMerge?: (sha: string) => void;
}

/**
 * PR review (spec 13.4): diff, line comments anchored to a SHA, a real
 * checklist, and merge rules that refuse instead of pretending.
 *
 * Approval invalidation is the core rule: an approval made for SHA A does not
 * carry over to SHA B. The panel shows the stale ones instead of dropping them.
 */
export function ReviewPanel({ review, diff, onAddComment, onApprove, onRequestChanges, onMerge }: ReviewPanelProps) {
  const [anchor, setAnchor] = useState<DiffAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingComment, setPendingComment] = useState<DiffAnchor | null>(null);

  const validApprovals = useMemo(() => review.approvals.filter((a) => a.sha === review.headSha && a.decision === "approved"), [review.approvals, review.headSha]);
  const staleApprovals = useMemo(() => review.approvals.filter((a) => a.sha !== review.headSha), [review.approvals, review.headSha]);
  const requiredChecksOk = review.checks === "success";
  const checklistDone = review.checklist.every((item) => item.done);

  const mergeBlockers: string[] = [];
  if (review.state === "merged") mergeBlockers.push("이미 병합됨");
  if (review.state === "closed") mergeBlockers.push("닫힌 PR — 다시 열어야 합니다");
  if (!requiredChecksOk) mergeBlockers.push(review.checks === "none" ? "필수 CI가 아직 실행되지 않음" : `필수 CI 상태: ${review.checks}`);
  if (validApprovals.length === 0) mergeBlockers.push("현재 SHA에 대한 유효 승인 없음");
  if (review.risk === "high") mergeBlockers.push("위험 변경(인증·권한·결제·삭제·비밀) — 소유자 승인 필요");
  if (!checklistDone) mergeBlockers.push("리뷰 체크리스트 미완료");

  const submitComment = () => {
    if (!pendingComment || !draft.trim() || !onAddComment) return;
    onAddComment(pendingComment, draft.trim());
    setDraft("");
    setPendingComment(null);
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card>
        <SectionHeader
          title={`#${review.number} ${review.title}`}
          sub={
            <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone={review.state === "open" ? "info" : review.state === "merged" ? "ok" : review.state === "draft" ? "neutral" : "danger"}>{review.state.toUpperCase()}</Badge>
              <span className="air-mono">{review.headSha.slice(0, 10)}</span>
              <span>base {review.baseSha.slice(0, 10)}</span>
              <RunStateBadge state={review.checks === "success" ? "SUCCEEDED" : review.checks === "failure" ? "FAILED" : review.checks === "pending" ? "RUNNING" : "QUEUED"} />
            </span>
          }
          actions={
            <>
              <Button size="sm" icon="check" variant="primary" disabled={mergeBlockers.length > 0 || !onMerge} onClick={() => onMerge?.(review.headSha)} title={mergeBlockers[0] ?? "병합"}>
                병합
              </Button>
              <Button size="sm" icon="x" disabled={!onRequestChanges} onClick={() => onRequestChanges?.(review.headSha)}>
                변경 요청
              </Button>
            </>
          }
        />
        <div style={{ padding: 12, display: "grid", gap: 8 }}>
          {mergeBlockers.length > 0 ? (
            <Banner tone="warn" icon="lock">
              <strong>병합 차단</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {mergeBlockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </Banner>
          ) : (
            <Banner tone="info" icon="check">모든 필수 조건 충족 — 병합 가능 후보입니다.</Banner>
          )}
          {staleApprovals.length > 0 ? (
            <Banner tone="danger" icon="refresh">
              SHA 변경으로 무효화된 승인 {staleApprovals.length}건: {staleApprovals.map((a) => `${a.reviewer}@${a.sha.slice(0, 7)}`).join(", ")} — 재승인이 필요합니다.
            </Banner>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone={validApprovals.length ? "ok" : "warn"}>유효 승인 {validApprovals.length}</Badge>
            <Badge tone="neutral">코멘트 {review.comments.length}</Badge>
            <Badge tone={review.risk === "high" ? "danger" : review.risk === "medium" ? "warn" : "neutral"}>위험 {review.risk}</Badge>
          </div>
          {onApprove ? (
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" icon="approval" onClick={() => onApprove(review.headSha)}>현재 SHA 승인</Button>
              <span className="air-hint" style={{ alignSelf: "center" }}>승인은 {review.headSha.slice(0, 7)} 커밋에만 유효합니다.</span>
            </div>
          ) : null}
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
        <DiffViewer diff={diff} anchor={anchor} onComment={(a) => setPendingComment(a)} />

        {pendingComment ? (
          <Card data-pad="md">
            <Field label={`줄 코멘트 · ${pendingComment.path}:${pendingComment.line} (${pendingComment.side === "new" ? "신규" : "기존"} 코드)`} htmlFor="review-comment">
              <TextArea
                id="review-comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="이 줄에 대한 리뷰 코멘트"
                autoFocus
              />
            </Field>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <Button size="sm" variant="primary" icon="check" onClick={submitComment} disabled={!draft.trim()}>코멘트 추가</Button>
              <Button size="sm" variant="ghost" onClick={() => { setPendingComment(null); setDraft(""); }}>취소</Button>
            </div>
          </Card>
        ) : null}

        <Card>
          <SectionHeader title="리뷰 코멘트" sub="줄 위치와 기준 SHA에 고정됩니다" />
          <div className="air-scroll" style={{ maxHeight: 260, padding: 10, display: "grid", gap: 8 }}>
            {review.comments.length === 0 ? <span className="air-hint">코멘트가 없습니다.</span> : null}
            {review.comments.map((comment) => {
              const stale = comment.head_sha !== review.headSha;
              return (
                <div key={comment.id} className="air-card" data-pad="sm" style={{ borderColor: stale ? "color-mix(in srgb, var(--air-danger) 40%, var(--air-line))" : undefined }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Icon name="review" size={12} />
                    <span className="air-mono" style={{ fontSize: 11.5 }}>{comment.path}:{comment.line}</span>
                    <Badge tone="neutral">{comment.side === "new" ? "신규" : "기존"}</Badge>
                    {stale ? <Badge tone="danger" shape="dashed">SHA 변경됨</Badge> : null}
                    <span style={{ flex: 1 }} />
                    <span className="air-hint">{comment.author} · {comment.created_at.slice(0, 16).replace("T", " ")}</span>
                  </div>
                  <div style={{ marginTop: 4, whiteSpace: "pre-wrap", fontSize: 12.5 }}>{comment.body}</div>
                  <div style={{ marginTop: 6 }}>
                    <Button size="sm" variant="ghost" onClick={() => setAnchor({ path: comment.path, side: comment.side, line: comment.line })}>diff에서 보기</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <SectionHeader title="리뷰 체크리스트" sub="증거 없는 항목은 체크할 수 없습니다" />
          <ul style={{ listStyle: "none", margin: 0, padding: 12, display: "grid", gap: 6 }}>
            {review.checklist.map((item) => (
              <li key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5 }}>
                <span aria-hidden="true" style={{ color: item.done ? "var(--air-ok)" : "var(--air-text-muted)" }}>{item.done ? "☑" : "☐"}</span>
                <span>
                  {item.label}
                  {item.evidence ? <span className="air-hint" style={{ display: "block" }}>증거: {item.evidence}</span> : <span className="air-hint" style={{ display: "block" }}>증거 없음 — 미완료로 집계</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

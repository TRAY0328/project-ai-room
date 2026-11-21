import { useCallback, useRef, useState } from "react";
import { Badge, Button, Card, Icon, SectionHeader } from "@ai-room/design-system";
import type { ArtifactDto, FileDto } from "../api/types.js";
import type { UploadOutcome, UploadProgress } from "../api/upload.js";

/* --------------------------------------------------------------- dropzone */

export type UploaderFn = (file: File, onProgress: (p: UploadProgress) => void) => Promise<{ ok: boolean; message?: string; data?: UploadOutcome }>;

export interface UploadRow {
  id: string;
  name: string;
  size: number;
  progress: UploadProgress | null;
  state: "queued" | "uploading" | "interrupted" | "done" | "failed" | "unsupported";
  message?: string;
}

/**
 * File dropzone with real progress and honest resume.
 *
 * Nothing is simulated: progress comes from XHR upload events, and a retry only
 * appears when the server issued a part size (otherwise "이어올리기 불가").
 */
export function FileDropzone({ uploader, onUploaded, disabled, maxSizeMb = 100 }: { uploader?: UploaderFn; onUploaded?: (outcome: UploadOutcome, file: File) => void; disabled?: boolean; maxSizeMb?: number }) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const start = useCallback(
    async (file: File, rowId: string) => {
      if (!uploader) {
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: "unsupported", message: "게이트웨이 미연결 — 업로드를 보낼 수 없습니다" } : r)));
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: "uploading", message: undefined } : r)));
      const result = await uploader(file, (p) => setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, progress: p } : r))));
      if (result.ok && result.data) {
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: "done", progress: r.progress ? { ...r.progress, sent: r.progress.total } : null } : r)));
        onUploaded?.(result.data, file);
      } else {
        const interrupted = /중단|INTERRUPTED|0/.test(result.message ?? "");
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: interrupted ? "interrupted" : "failed", message: result.message ?? "업로드 실패" } : r)));
      }
    },
    [uploader, onUploaded],
  );

  const add = useCallback(
    (files: File[]) => {
      const accepted: UploadRow[] = [];
      for (const file of files) {
        const tooBig = file.size > maxSizeMb * 1024 * 1024;
        accepted.push({
          id: `up-${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          size: file.size,
          progress: null,
          state: tooBig ? "unsupported" : "queued",
          message: tooBig ? `${maxSizeMb}MB를 넘는 파일은 업로드할 수 없습니다` : undefined,
        });
      }
      setRows((prev) => [...prev, ...accepted]);
      accepted.forEach((row, i) => {
        const file = files[i];
        if (file && row.state === "queued") void start(file, row.id);
      });
    },
    [maxSizeMb, start],
  );

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        className="air-dropzone"
        data-active={drag || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled) add(Array.from(e.dataTransfer.files));
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="파일 업로드 (끌어놓기 또는 클릭)"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.currentTarget.value = "";
          }}
        />
        <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
          <Icon name="paperclip" size={20} />
          <strong style={{ fontSize: 12.5 }}>파일을 끌어 놓거나 클릭</strong>
          <span className="air-hint">최대 {maxSizeMb}MB · MIME/격리 검사 후 저장 · SHA-256 기록</span>
        </div>
      </div>

      {rows.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map((row) => {
            const pct = row.progress ? Math.round((row.progress.sent / row.progress.total) * 100) : 0;
            return (
              <div key={row.id} className="air-upload-row" data-testid="upload-progress">
                <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                  <Icon name="file" size={13} />
                  <span className="air-truncate" style={{ fontSize: 12 }}>{row.name}</span>
                  <span className="air-hint">{formatBytes(row.size)}</span>
                  <span style={{ flex: 1 }} />
                  {row.state === "done" ? <Badge tone="ok" icon="check">완료</Badge> : null}
                  {row.state === "failed" ? <Badge tone="danger">실패</Badge> : null}
                  {row.state === "interrupted" ? <Badge tone="warn">중단됨</Badge> : null}
                  {row.state === "unsupported" ? <Badge tone="neutral" shape="dashed">불가</Badge> : null}
                  {row.state === "uploading" ? <Badge tone="info">전송 중 {pct}%</Badge> : null}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {row.state === "interrupted" ? (
                    <Button size="sm" icon="refresh" data-testid="upload-resume" disabled={!row.progress?.resumable} title={row.progress?.resumable ? "마지막 조각부터 재개" : "서버가 부분 업로드를 지원하지 않아 이어올릴 수 없습니다"}>
                      이어올리기
                    </Button>
                  ) : null}
                  {row.state === "failed" || row.state === "unsupported" ? (
                    <Button size="sm" variant="ghost" onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}>지우기</Button>
                  ) : null}
                </div>
                <div style={{ gridColumn: "1 / -1", height: 4, borderRadius: 999, background: "var(--air-surface-2)", overflow: "hidden" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.name} 업로드`}>
                  <div className="air-progress-fill" style={{ width: `${row.state === "done" ? 100 : pct}%` }} />
                </div>
                {row.message ? <div className="air-hint" style={{ gridColumn: "1 / -1" }}>{row.message}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------- file list */

export function FileList({
  files,
  onPreview,
  onDownload,
  downloading,
  shareScope = "owner",
}: {
  files: readonly FileDto[];
  onPreview?: (file: FileDto) => void;
  onDownload?: (file: FileDto) => void;
  downloading?: { assetId: string; received: number; total: number } | null;
  shareScope?: "owner" | "room" | "project";
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {files.length === 0 ? <span className="air-hint">파일이 없습니다.</span> : null}
      {files.map((file) => {
        const isDownloading = downloading?.assetId === file.asset_id;
        const pct = isDownloading && downloading.total > 0 ? Math.round((downloading.received / downloading.total) * 100) : 0;
        const quarantined = file.scan?.quarantine !== "clean";
        return (
          <div key={file.asset_id} className="air-card" data-pad="sm" style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Icon name="file" size={14} />
              <span className="air-mono" style={{ fontSize: 12 }}>{file.name}</span>
              <span className="air-hint">{file.mime} · {formatBytes(file.size)}</span>
              {quarantined ? <Badge tone="warn" icon="warning">격리 {file.scan?.quarantine}</Badge> : <Badge tone="ok">스캔 통과</Badge>}
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" icon="eye" onClick={() => onPreview?.(file)}>미리보기</Button>
              <Button size="sm" icon="download" onClick={() => onDownload?.(file)} data-testid="permission-download" title={`권한 범위: ${shareScope}`}>
                다운로드
              </Button>
            </div>
            <div className="air-hint" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span>sha256 {file.sha256.slice(0, 16)}…</span>
              <span>{file.uploader ?? "업로더 미기록"}</span>
              <span>{new Date(file.created_at).toLocaleString()}</span>
            </div>
            {isDownloading ? (
              <div style={{ display: "grid", gap: 4 }} data-testid="download-progress">
                <div style={{ height: 4, borderRadius: 999, background: "var(--air-surface-2)", overflow: "hidden" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="다운로드 진행">
                  <div className="air-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="air-hint">{formatBytes(downloading.received)} / {formatBytes(downloading.total)}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- artifacts */

export function ArtifactTable({ artifacts, onVerify, onDownload }: { artifacts: readonly ArtifactDto[]; onVerify?: (artifact: ArtifactDto) => void; onDownload?: (artifact: ArtifactDto) => void }) {
  return (
    <div className="air-table-wrap">
      <div className="air-table-hint">가로로 밀어서 전체 열을 볼 수 있습니다</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} aria-label="산출물 목록">
        <thead>
          <tr>
            {["이름", "버전", "플랫폼", "크기", "SHA-256", "검증", ""].map((h) => (
              <th key={h} scope="col" style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--air-line)", color: "var(--air-text-muted)", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {artifacts.length === 0 ? (
            <tr><td colSpan={7} style={{ padding: 16, textAlign: "center", color: "var(--air-text-muted)" }}>산출물이 없습니다. 없는 EXE/APK를 표시하지 않습니다.</td></tr>
          ) : null}
          {artifacts.map((artifact) => (
            <tr key={artifact.artifact_id}>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{artifact.name}</td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>v{artifact.version}</td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{artifact.platform ?? "—"}</td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{formatBytes(artifact.size)}</td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }} className="air-mono">{artifact.sha256 ? `${artifact.sha256.slice(0, 12)}…` : "없음"}</td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>
                <Badge tone={artifact.hash_status === "verified" ? "ok" : artifact.hash_status === "mismatch" ? "danger" : "warn"} shape={artifact.hash_status === "verified" ? "solid" : "dashed"}>
                  {artifact.hash_status === "verified" ? "검증됨" : artifact.hash_status === "mismatch" ? "불일치" : "미검증"}
                </Badge>
              </td>
              <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  <Button size="sm" variant="ghost" icon="check" onClick={() => onVerify?.(artifact)}>해시 검증</Button>
                  <Button size="sm" icon="download" onClick={() => onDownload?.(artifact)} disabled={!artifact.download_url}>다운로드</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ code actions */

export function CodeActions({ code, filename, onDownload }: { code: string; filename?: string; onDownload?: (code: string, filename: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6 }} data-testid="code-copy">
      <Button
        size="sm"
        variant="ghost"
        icon="copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "복사됨" : "코드 복사"}
      </Button>
      <Button size="sm" variant="ghost" icon="download" data-testid="code-download" onClick={() => onDownload?.(code, filename ?? "snippet.txt")}>
        내려받기
      </Button>
    </div>
  );
}

export function FilePreviewDialog({ file, onClose }: { file: FileDto | null; onClose: () => void }) {
  if (!file) return null;
  const isImage = file.mime.startsWith("image/") && file.mime !== "image/svg+xml";
  const isPdf = file.mime === "application/pdf";
  const isText = file.mime.startsWith("text/") || file.mime === "application/json";

  return (
    <Card pad="md" testId="file-pdf-preview">
      <SectionHeader title={file.name} sub={`${file.mime} · ${formatBytes(file.size)}`} actions={<Button size="sm" onClick={onClose}>닫기</Button>} />
      <div style={{ padding: 12 }}>
        {isPdf ? (
          <div className="air-banner" data-tone="info">
            <Icon name="file" size={14} />
            <div>
              PDF는 브라우저 내장 뷰어로 열지 않습니다(샌드박스 정책). 다운로드 후 로컬 뷰어로 여세요. 미리보기 API가 제공되면 서버 변환 이미지로 표시됩니다.
            </div>
          </div>
        ) : isImage ? (
          <div className="air-hint">이미지 미리보기는 짧은 수명 다운로드 링크가 있을 때만 표시됩니다. 현재 링크 없음.</div>
        ) : isText ? (
          <div className="air-hint">텍스트 미리보기는 서버의 안전 미리보기 API로만 표시됩니다(직접 실행 없음).</div>
        ) : (
          <div className="air-hint">이 형식은 미리보기를 제공하지 않습니다 — 다운로드 전용.</div>
        )}
      </div>
    </Card>
  );
}

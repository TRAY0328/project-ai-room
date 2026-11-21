import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import { Badge, Banner, Button, Icon, LiveIndicator, Spinner, useTheme } from "@ai-room/design-system";
import { monaco, setupMonacoEnvironment, defineEditorThemes, applyEditorTheme, languageForPath } from "./monacoSetup.js";
import { CollabProvider, listPeers, type CollabStatus, type PeerPresence } from "./collab.js";

export interface MonacoYjsEditorProps {
  /** Stable identity of the collaborative document (project + file). */
  docKey: string;
  path: string;
  initialValue?: string;
  collabUrl?: string;
  token?: string;
  readOnly?: boolean;
  height?: number | string;
  /** Called when the user asks to commit; the buffer is Yjs state, not a server save. */
  onSaveRequest?: (value: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Monaco + Yjs editor (spec 13.2).
 *
 * Honesty rules implemented here:
 *  - remote cursors exist only while a real peer is in the awareness map;
 *  - "서버 동기화됨" is shown only after the sync step 2 arrives;
 *  - without a collab URL the banner says local-only instead of pretending.
 */
export function MonacoYjsEditor({
  docKey,
  path,
  initialValue = "",
  collabUrl,
  token,
  readOnly = false,
  height = 420,
  onSaveRequest,
  onDirtyChange,
}: MonacoYjsEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const providerRef = useRef<CollabProvider | null>(null);
  const [status, setStatus] = useState<CollabStatus>(collabUrl ? "connecting" : "idle");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const { theme } = useTheme();

  const language = useMemo(() => languageForPath(path), [path]);

  useEffect(() => {
    setupMonacoEnvironment();
    defineEditorThemes();
  }, []);

  useEffect(() => {
    applyEditorTheme(theme);
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    if (ytext.length === 0 && initialValue) {
      ydoc.transact(() => ytext.insert(0, initialValue));
    }

    const uri = monaco.Uri.parse(`inmemory://ai-room/${encodeURIComponent(docKey)}/${encodeURIComponent(path)}`);
    const model = monaco.editor.createModel("", language, uri);
    const editor = monaco.editor.create(host, {
      model,
      theme: theme === "dark" ? "air-dark" : "air-light",
      automaticLayout: true,
      readOnly,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "line",
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      tabSize: 2,
      wordWrap: "off",
      accessibilitySupport: "auto",
      ariaLabel: `${path} 코드 편집기`,
      stickyScroll: { enabled: true },
    });
    editorRef.current = editor;
    setEditorReady(true);

    const provider = collabUrl ? new CollabProvider({
      url: collabUrl,
      room: `doc:${docKey}:${path}`,
      doc: ydoc,
      token,
      onStatus: (next, why) => {
        setStatus(next);
        setDetail(why);
      },
    }) : null;
    providerRef.current = provider;

    const binding = new MonacoBinding(ytext, model, new Set([editor]), provider?.awareness);
    bindingRef.current = binding;

    if (provider) {
      const awareness = provider.awareness;
      awareness.setLocalStateField("user", {
        name: "나 (owner)",
        color: getComputedStyle(document.documentElement).getPropertyValue("--air-accent").trim() || "#0f8a6a",
      });
      const onAwareness = () => setPeers(listPeers(awareness, ydoc.clientID));
      awareness.on("change", onAwareness);
      onAwareness();
      provider.connect();
      setStatus("connecting");

      return () => {
        awareness.off("change", onAwareness);
        binding.destroy();
        provider.destroy();
        editor.dispose();
        model.dispose();
        ydoc.destroy();
        editorRef.current = null;
        bindingRef.current = null;
        providerRef.current = null;
      };
    }

    setStatus("idle");
    setPeers([]);
    const onModelChange = () => {
      setDirty(true);
      onDirtyChange?.(true);
    };
    const changeSub = model.onDidChangeContent(onModelChange);

    return () => {
      changeSub.dispose();
      binding.destroy();
      editor.dispose();
      model.dispose();
      ydoc.destroy();
      editorRef.current = null;
      bindingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, path, collabUrl, token, readOnly, language]);

  const statusText: Record<CollabStatus, string> = {
    idle: "로컬 전용",
    connecting: "동기화 연결 중",
    synced: "서버 동기화됨",
    disconnected: "연결 끊김(로컬 편집 유지)",
    error: "동기화 오류",
  };
  const liveState: "online" | "offline" | "connecting" | "error" = status === "synced" ? "online" : status === "connecting" ? "connecting" : status === "error" ? "error" : "offline";

  return (
    <section style={{ display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0, border: "1px solid var(--air-line)", borderRadius: 12, overflow: "hidden", background: "var(--air-bg)" }} aria-label="코드 편집기">
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--air-line)", background: "var(--air-surface)", flexWrap: "wrap" }}>
        <Icon name="code" size={14} />
        <span className="air-mono" style={{ fontSize: 12 }}>{path}</span>
        <Badge tone="neutral">{language}</Badge>
        <span style={{ flex: 1 }} />
        <LiveIndicator state={liveState} label={statusText[status]} />
        {peers.filter((p) => !p.isSelf).length > 0 ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            {peers.filter((p) => !p.isSelf).map((peer) => (
              <span key={peer.clientId} className="air-badge" title={`실시간 접속: ${peer.name}`} style={{ borderColor: peer.color }}>
                <span className="air-badge-dot" style={{ background: peer.color }} />
                {peer.name}
              </span>
            ))}
          </span>
        ) : (
          <span className="air-hint">{status === "synced" ? "다른 편집자 없음" : "실시간 상대 없음"}</span>
        )}
        {onSaveRequest ? (
          <Button size="sm" variant="primary" icon="check" onClick={() => {
            const value = editorRef.current?.getValue() ?? "";
            onSaveRequest(value);
            setDirty(false);
            onDirtyChange?.(false);
          }}>
            커밋 요청
          </Button>
        ) : null}
      </header>

      {!collabUrl ? (
        <div style={{ padding: "6px 10px" }}>
          <Banner tone="info" icon="info">
            동시 편집 서버 미연결 — 이 브라우저 안에서만 편집됩니다. 서버 저장으로 표시하지 않습니다.
          </Banner>
        </div>
      ) : null}
      {status === "error" && detail ? (
        <div style={{ padding: "6px 10px" }}>
          <Banner tone="danger" icon="warning">{detail}</Banner>
        </div>
      ) : null}

      <div ref={hostRef} style={{ height: typeof height === "number" ? height : height, minHeight: 220, position: "relative" }}>
        {!editorReady ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", gap: 8 }}>
            <Spinner label="편집기 준비 중" />
          </div>
        ) : null}
      </div>

      <footer style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 10px", borderTop: "1px solid var(--air-line)", fontSize: 11.5, color: "var(--air-text-muted)", flexWrap: "wrap" }}>
        <span>{dirty ? "버퍼 변경됨" : "변경 없음"}</span>
        <span>·</span>
        <span>{status === "synced" ? "CRDT 병합본이 서버와 동기화됨" : "로컬 CRDT 상태(서버 미확인)"}</span>
        <span style={{ flex: 1 }} />
        <span className="air-mono">Yjs {Y.Doc ? "13.x" : ""}</span>
      </footer>
    </section>
  );
}

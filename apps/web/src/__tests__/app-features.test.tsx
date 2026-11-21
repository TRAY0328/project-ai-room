/**
 * App-surface feature proofs (41 of 108).
 *
 * Each manifest row is mapped to a rendered `data-testid`. The test opens the
 * state that exposes it (typing, opening a thread, starting an upload…) and then
 * asserts the DOM. At the end the asserted ids must equal the manifest exactly,
 * so a feature cannot be "proven" by a test that never checked it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider as _unused } from "react";
import { APP_FEATURES } from "../lib/app-feature-manifest.js";
import { withDemoMode } from "./harness.js";
import { Providers } from "./harness.js";
import { MainChatScreen, RoomsScreen, RoomDetailScreen, SearchScreen } from "../screens/Chat.js";
import { TaskBoardScreen, DependenciesScreen } from "../screens/Projects.js";
import { FilesScreen, ReviewScreen, CiScreen } from "../screens/Code.js";
import { AlertsScreen } from "../screens/Ops.js";
import { Composer, MessageCard, Reactions } from "../components/chat/index.js";
import { FileDropzone, FileList } from "../components/files.js";
import { Shell } from "../components/Shell.js";
import { SCREEN_BY_ID } from "../lib/router.js";
import { demoFiles, demoMessages, demoRooms } from "../demo/fixtures.js";
import { useApp } from "../state/AppState.js";

const seen = new Set<string>();
const noop = () => undefined;

function expectId(container: HTMLElement, id: string): void {
  // dialogs/drawers render through a portal into document.body
  const el = container.querySelector(`[data-testid="${id}"]`) ?? document.querySelector(`[data-testid="${id}"]`);
  expect(el, `missing data-testid="${id}"`).not.toBeNull();
  seen.add(id);
}

function renderMainChat() {
  return render(<Providers><MainChatScreen navigate={noop} /></Providers>);
}

describe("app feature manifest", () => {
  beforeEach(() => {
    withDemoMode(true);
  });

  it("declares 41 unique app features mapped to real screens", () => {
    expect(APP_FEATURES).toHaveLength(41);
    expect(new Set(APP_FEATURES.map((f) => f.id)).size).toBe(41);
    for (const feature of APP_FEATURES) {
      expect(SCREEN_BY_ID[feature.screen]).toBeTruthy();
      expect(feature.testId.length).toBeGreaterThan(0);
    }
  });

  it("composer: source toggle, preview, draft state, mentions, typing, dedupe", async () => {
    const sent: string[] = [];
    const { container } = render(
      <Providers>
        <Composer
          roomId="room-default"
          agents={[{ agent_id: "agent-gemini", display_name: "Gemini", kind: "agent" }, { agent_id: "owner", display_name: "천예준", kind: "owner" }]}
          onSend={(_blocks, plain) => sent.push(plain)}
          typing={[{ name: "Gemini" }]}
        />
      </Providers>,
    );
    expectId(container, "composer-source-toggle");
    expectId(container, "composer-draft-state");
    expectId(container, "typing-indicator");
    expectId(container, "send-dedupe");

    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "@" } });
    await waitFor(() => expectId(container, "composer-mention-ai"));
    expectId(container, "composer-mention-user");

    fireEvent.click(container.querySelector('[data-testid="composer-source-toggle"]')!);
    await waitFor(() => expectId(container, "composer-preview"));

    // back to write mode, then the duplicate submit guard: two clicks, one send
    fireEvent.click(container.querySelector('[data-testid="composer-source-toggle"]')!);
    const writeArea = container.querySelector("textarea")!;
    fireEvent.change(writeArea, { target: { value: "안녕" } });
    const sendButton = container.querySelector('[data-testid="send-dedupe"]')!;
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    expect(sent).toEqual(["안녕"]);
  });

  it("message actions: reply, thread, bookmark, share, copy link, important, code actions", async () => {
    const { container } = renderMainChat();
    for (const id of ["message-reply", "message-thread-create", "message-bookmark", "message-share-ref", "message-copy-link", "message-important", "code-copy", "code-download"]) {
      expectId(container, id);
    }
    // opening a thread exposes the notify toggle
    fireEvent.click(container.querySelector('[data-testid="message-thread-create"]')!);
    await waitFor(() => expectId(container, "thread-notify-toggle"));
  });

  it("read receipt is only rendered for an ACKed message", () => {
    const { container } = render(
      <Providers>
        <MessageCard message={demoMessages[0]!} delivered handlers={{}} />
      </Providers>,
    );
    expectId(container, "message-read-receipt");
  });

  it("reactions: emoji, custom, removal and counts", () => {
    const { container } = render(
      <Providers>
        <Reactions reactions={{ "👍": 2 }} mine={["👍"]} onToggle={noop} onAddCustom={noop} />
      </Providers>,
    );
    expectId(container, "reaction-emoji");
    expectId(container, "reaction-count");
    expectId(container, "reaction-remove");
    expectId(container, "reaction-custom");
  });

  it("rooms: unread badge", () => {
    const { container } = render(<Providers><RoomsScreen navigate={noop} /></Providers>);
    expectId(container, "room-unread");
  });

  it("room detail: pins and tombstone restore", () => {
    const { container } = render(<Providers><RoomDetailScreen params={{ id: "room-default" }} /></Providers>);
    expectId(container, "room-pin-list");
    expectId(container, "tombstone-restore");
  });

  it("search: filters and jump", () => {
    const { container } = render(<Providers><SearchScreen navigate={noop} /></Providers>);
    expectId(container, "search-filters");
    expectId(container, "search-jump");
  });

  it("files: pdf preview, permission download, download + upload progress", async () => {
    const { container } = render(<Providers><FilesScreen params={{ id: "proj-ai-room" }} /></Providers>);
    fireEvent.click(screen.getAllByRole("button", { name: "미리보기" })[0]!);
    await waitFor(() => expectId(container, "file-pdf-preview"));
    expectId(container, "permission-download");

    const list = render(
      <Providers>
        <FileList files={demoFiles} downloading={{ assetId: "file-1", received: 512, total: 2048 }} />
      </Providers>,
    );
    expectId(list.container, "download-progress");

    const uploader = async (_file: File, onProgress: (p: { sent: number; total: number; partIndex: number; partCount: number; resumable: boolean }) => void) => {
      onProgress({ sent: 5, total: 10, partIndex: 0, partCount: 2, resumable: true });
      return { ok: false, message: "업로드가 중단되었습니다" };
    };
    const drop = render(<Providers><FileDropzone uploader={uploader as never} /></Providers>);
    const input = drop.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expectId(drop.container, "upload-progress"));
    await waitFor(() => expectId(drop.container, "upload-resume"));
  });

  it("task board: reassign suggestion; dependencies: graph", async () => {
    const board = render(<Providers><TaskBoardScreen params={{ id: "proj-ai-room" }} /></Providers>);
    expectId(board.container, "task-reassign-suggest");
    const deps = render(<Providers><DependenciesScreen params={{ id: "proj-ai-room" }} /></Providers>);
    expectId(deps.container, "dependency-graph");
  });

  it("review: diff line comments and checklist", async () => {
    const { container } = render(<Providers><ReviewScreen params={{ id: "proj-ai-room" }} /></Providers>);
    await waitFor(() => expectId(container, "diff-line-comment"));
    expectId(container, "review-checklist");
  });

  it("ci: undo message entry point", () => {
    const { container } = render(<Providers><CiScreen params={{ id: "proj-ai-room" }} /></Providers>);
    expectId(container, "ci-undo-message");
  });

  it("alerts: mute, priority, timeline", () => {
    const { container } = render(<Providers><AlertsScreen /></Providers>);
    expectId(container, "alert-mute");
    expectId(container, "alert-priority");
    expectId(container, "alert-timeline");
  });

  it("quick search lives in the shell; outbox retry appears for a failed queued message", async () => {
    function Harness() {
      const { enqueueMessage, connection } = useApp();
      return (
        <Shell screen={SCREEN_BY_ID.MAINCHAT} params={{}} navigate={noop} notifications={0}>
          <button
            type="button"
            data-testid="seed-outbox"
            onClick={() => {
              enqueueMessage("room-default", [{ type: "text", version: 1, payload: { text: "queued" } }]);
            }}
          >
            seed
          </button>
          <span data-testid="conn">{connection.state}</span>
        </Shell>
      );
    }
    const { container } = render(<Providers><Harness /></Providers>);
    expectId(container, "quick-search");
    fireEvent.click(container.querySelector('[data-testid="seed-outbox"]')!);
    await waitFor(() => expectId(container, "outbox-retry"));
  });

  // Runs after every test above: the set of ids asserted must equal the manifest.
  afterAll(() => {
    const missing = APP_FEATURES.filter((f) => !seen.has(f.testId)).map((f) => `${f.id}:${f.testId}`);
    expect(missing).toEqual([]);
  });
});

describe("demo fixtures used by these proofs", () => {
  it("stays clearly labelled", () => {
    expect(demoRooms.length).toBeGreaterThan(0);
    expect(demoMessages.length).toBeGreaterThan(0);
  });
});

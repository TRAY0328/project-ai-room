// AI ROOM 데스크톱 셸 — 설정 화면 로직.
// 이 문서는 로컬 앱 자산이다(tauri.localhost). 원격 작업 공간 창은 이 문서가 아니며 IPC 권한도 없다.

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;

const el = {
  version: document.getElementById("version-chip"),
  pill: document.getElementById("status-pill"),
  detail: document.getElementById("status-detail"),
  target: document.getElementById("status-target"),
  latency: document.getElementById("status-latency"),
  checked: document.getElementById("status-checked"),
  note: document.getElementById("load-note"),
  url: document.getElementById("server-url"),
  save: document.getElementById("save-button"),
  test: document.getElementById("test-button"),
  testResult: document.getElementById("test-result"),
  openOnStart: document.getElementById("open-on-start"),
  theme: document.getElementById("theme"),
  open: document.getElementById("open-button"),
  clear: document.getElementById("clear-button"),
  diagnostics: document.getElementById("diagnostics"),
  configPath: document.getElementById("config-path"),
};

const STATUS_LABEL = {
  unconfigured: { text: "설정 필요", state: "idle" },
  unknown: { text: "확인 전", state: "idle" },
  online: { text: "연결됨", state: "online" },
  auth_required: { text: "연결됨 · 로그인 필요", state: "auth" },
  server_error: { text: "서버 오류", state: "bad" },
  offline: { text: "오프라인", state: "bad" },
  invalid_url: { text: "주소 오류", state: "bad" },
};

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function formatCheckedAt(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderStatus(status) {
  if (!status) return;
  const label = STATUS_LABEL[status.reachability] ?? { text: "알 수 없음", state: "idle" };
  el.pill.textContent = label.text;
  el.pill.dataset.state = label.state;
  el.detail.textContent = status.detail || "";
  el.target.textContent = status.target || "—";
  el.latency.textContent = status.latencyMs == null ? "—" : `${status.latencyMs} ms`;
  el.checked.textContent = formatCheckedAt(status.checkedAt);
}

function renderView(view) {
  if (!view) return;
  el.version.textContent = `v${view.appVersion}`;
  if (document.activeElement !== el.url) {
    el.url.value = view.serverUrl ?? "";
  }
  el.openOnStart.checked = Boolean(view.openWorkspaceOnStart);
  el.theme.value = view.theme ?? "system";
  applyTheme(view.theme);
  renderStatus(view.status);
  el.configPath.textContent = `설정 파일: ${view.configPath}`;
  if (view.loadNote) {
    el.note.hidden = false;
    el.note.textContent = view.loadNote;
  } else {
    el.note.hidden = true;
    el.note.textContent = "";
  }
  const configured = Boolean((view.serverUrl ?? "").trim());
  el.open.disabled = !configured;
}

function showError(context, error) {
  const message = typeof error === "string" ? error : error?.message ?? "알 수 없는 오류";
  const code = error?.code ? ` (${error.code})` : "";
  el.testResult.hidden = false;
  el.testResult.textContent = `${context}: ${message}${code}`;
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
    button.disabled = false;
  }
}

async function refreshView() {
  const view = await invoke("get_client_view");
  renderView(view);
  return view;
}

async function loadDiagnostics() {
  try {
    const diag = await invoke("get_diagnostics");
    el.diagnostics.textContent = JSON.stringify(diag, null, 2);
  } catch (error) {
    el.diagnostics.textContent = `진단 정보를 불러오지 못했습니다: ${error?.message ?? error}`;
  }
}

async function onSave() {
  setBusy(el.save, true, "저장 중…");
  try {
    const view = await invoke("save_settings", {
      payload: {
        serverUrl: el.url.value,
        openWorkspaceOnStart: el.openOnStart.checked,
        theme: el.theme.value,
      },
    });
    renderView(view);
    el.testResult.hidden = false;
    el.testResult.textContent = "저장했습니다. 위 상태가 방금 확인한 결과입니다.";
  } catch (error) {
    showError("저장 실패", error);
  } finally {
    setBusy(el.save, false);
  }
}

async function onTest() {
  const url = el.url.value.trim();
  if (!url) {
    showError("시험 실패", { message: "서버 주소를 입력하세요." });
    return;
  }
  setBusy(el.test, true, "확인 중…");
  try {
    const result = await invoke("test_server_url", { url });
    renderStatus(result);
    el.testResult.hidden = false;
    el.testResult.textContent = `저장하지 않고 확인한 결과: ${result.detail}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}`;
  } catch (error) {
    showError("시험 실패", error);
  } finally {
    setBusy(el.test, false);
  }
}

async function onOpen() {
  setBusy(el.open, true, "여는 중…");
  try {
    const view = await invoke("open_workspace");
    renderView(view);
  } catch (error) {
    showError("작업 공간 열기 실패", error);
  } finally {
    setBusy(el.open, false);
  }
}

async function onClear() {
  const ok = window.confirm(
    "이 기기의 웹뷰 데이터(쿠키·저장소)를 지우고 작업 공간 창을 닫습니다. 계속할까요?\n\n서버의 세션 폐기는 웹 화면의 로그아웃으로도 할 수 있습니다."
  );
  if (!ok) return;
  setBusy(el.clear, true, "지우는 중…");
  try {
    const view = await invoke("clear_session");
    renderView(view);
    el.testResult.hidden = false;
    el.testResult.textContent = "이 기기의 세션 데이터를 지웠습니다.";
  } catch (error) {
    showError("세션 지우기 실패", error);
  } finally {
    setBusy(el.clear, false);
  }
}

async function onThemeChange() {
  applyTheme(el.theme.value);
  try {
    const view = await invoke("save_settings", {
      payload: {
        serverUrl: el.url.value,
        openWorkspaceOnStart: el.openOnStart.checked,
        theme: el.theme.value,
      },
    });
    renderView(view);
  } catch (error) {
    // 서버 주소가 아직 유효하지 않으면 테마만 이번 실행에 적용된다. 저장 실패를 숨기지 않고 알린다.
    el.testResult.hidden = false;
    el.testResult.textContent =
      "테마는 이번 실행에만 적용되었습니다. 저장하려면 서버 주소를 먼저 고치세요: " +
      (typeof error === "string" ? error : error?.message ?? "알 수 없는 오류");
  }
}

function wire() {
  el.save.addEventListener("click", onSave);
  el.test.addEventListener("click", onTest);
  el.open.addEventListener("click", onOpen);
  el.clear.addEventListener("click", onClear);
  el.theme.addEventListener("change", onThemeChange);
  el.url.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSave();
    }
  });
}

async function main() {
  if (!invoke) {
    el.detail.textContent = "Tauri 런타임을 찾지 못했습니다. 이 화면은 앱 창에서 열어야 합니다.";
    el.pill.textContent = "런타임 없음";
    el.pill.dataset.state = "bad";
    return;
  }
  wire();
  if (listen) {
    await listen("client://status", (event) => renderStatus(event.payload));
  }
  try {
    await refreshView();
  } catch (error) {
    showError("설정을 불러오지 못했습니다", error);
  }
  loadDiagnostics();
}

main();

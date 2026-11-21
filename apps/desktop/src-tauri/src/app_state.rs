//! 앱 공용 상태와 창 관리.
//!
//! 창은 두 개다.
//!   - `settings` : 로컬 셸(설정·상태). IPC 권한은 여기에만 준다(capabilities/default.json).
//!   - `workspace`: 클라우드 웹 앱을 HTTPS로 여는 창. IPC 권한 없음.
//! 이 분리가 "원격 페이지는 셸 명령을 호출할 수 없다"는 경계를 코드가 아니라 권한 구성으로 만든다.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::probe::{self, ProbeResult, Reachability};
use crate::settings::{self, ClientSettings};
use crate::url_policy;

pub const SETTINGS_LABEL: &str = "settings";
pub const WORKSPACE_LABEL: &str = "workspace";
pub const TRAY_ID: &str = "airoom-tray";
pub const EVENT_STATUS: &str = "client://status";
pub const POLL_INTERVAL_SECS: u64 = 30;

pub struct AppState {
    pub config_dir: PathBuf,
    pub settings: Arc<Mutex<ClientSettings>>,
    pub status: Arc<Mutex<ProbeResult>>,
    pub load_note: Mutex<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub fn current_settings(app: &AppHandle) -> ClientSettings {
    let state = app.state::<AppState>();
    let guard = match state.settings.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.clone()
}

pub fn current_status(app: &AppHandle) -> ProbeResult {
    let state = app.state::<AppState>();
    let guard = match state.status.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.clone()
}

pub fn read_load_note(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    match state.load_note.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// 설정을 메모리와 디스크에 함께 반영한다. 디스크 실패는 사용자에게 알린다.
pub fn persist_settings(app: &AppHandle, next: &ClientSettings) -> Result<(), CommandError> {
    let state = app.state::<AppState>();
    settings::save(&state.config_dir, next).map_err(|err| {
        CommandError::new(
            "SETTINGS_WRITE_FAILED",
            format!("설정을 저장하지 못했습니다: {err}"),
        )
    })?;
    let mut guard = match state.settings.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = next.clone();
    Ok(())
}

/// 저장된 주소로 지금 한 번 확인하고, 결과를 상태·이벤트·트레이에 반영한다.
pub async fn probe_current(app: &AppHandle) -> ProbeResult {
    let settings = current_settings(app);
    let result = match settings.server_url.as_deref() {
        None => ProbeResult::unconfigured(),
        Some(raw) if raw.trim().is_empty() => ProbeResult::unconfigured(),
        Some(raw) => match url_policy::normalize_server_url(raw) {
            Ok(url) => probe::probe(&url).await,
            Err(err) => ProbeResult::invalid(&err.message()),
        },
    };

    let state = app.state::<AppState>();
    {
        let mut guard = match state.status.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = result.clone();
    }

    let _ = app.emit(EVENT_STATUS, &result);
    update_tray_tooltip(app, &result);
    result
}

pub fn update_tray_tooltip(app: &AppHandle, result: &ProbeResult) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let label = match result.reachability {
            Reachability::Unconfigured => "설정 필요",
            Reachability::Unknown => "확인 전",
            Reachability::Online => "연결됨",
            Reachability::AuthRequired => "연결됨(로그인 필요)",
            Reachability::ServerError => "서버 오류",
            Reachability::Offline => "오프라인 — 재연결 대기",
            Reachability::InvalidUrl => "주소 오류",
        };
        let _ = tray.set_tooltip(Some(format!("AI ROOM — {label}")));
    }
}

/// 작업 공간 창을 열거나, 이미 있으면 그 창을 앞으로 가져온다.
pub fn open_or_focus_workspace(app: &AppHandle, url: &Url) -> Result<(), CommandError> {
    if let Some(existing) = app.get_webview_window(WORKSPACE_LABEL) {
        let already_there = existing
            .url()
            .map(|current| current == *url)
            .unwrap_or(false);
        if !already_there {
            existing.navigate(url.clone()).map_err(|_| {
                CommandError::new(
                    "WORKSPACE_NAVIGATE_FAILED",
                    "작업 공간 주소를 열지 못했습니다.",
                )
            })?;
        }
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, WORKSPACE_LABEL, WebviewUrl::External(url.clone()))
        .title("AI ROOM")
        .inner_size(1280.0, 840.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .zoom_hotkeys_enabled(true)
        .build()
        .map(|window| {
            let _ = window.set_focus();
        })
        .map_err(|err| {
            eprintln!("workspace window error: {err}");
            CommandError::new("WORKSPACE_WINDOW_FAILED", "작업 공간 창을 열지 못했습니다.")
        })
}

pub fn show_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 로그아웃: 이 기기의 웹뷰 데이터(쿠키·스토리지)를 지우고 작업 공간 창을 닫는다.
/// 서버 세션 자체의 폐기는 웹 앱의 로그아웃 API가 담당한다(클라이언트는 토큰을 읽지 않는다).
pub fn clear_local_session(app: &AppHandle) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window(WORKSPACE_LABEL) {
        window.clear_all_browsing_data().map_err(|err| {
            eprintln!("clear browsing data error: {err}");
            CommandError::new(
                "SESSION_CLEAR_FAILED",
                "이 기기의 웹뷰 데이터를 지우지 못했습니다.",
            )
        })?;
        let _ = window.close();
    }
    show_settings_window(app);
    Ok(())
}

/// 설정 창(로컬 셸)에서 온 호출인지 확인한다. IPC 권한 구성과 별개의 2차 방어선.
pub fn ensure_shell_caller(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() != SETTINGS_LABEL {
        return Err(CommandError::new(
            "FORBIDDEN_CALLER",
            "이 창에서는 설정 명령을 호출할 수 없습니다.",
        ));
    }
    let url = window
        .url()
        .map_err(|_| CommandError::new("FORBIDDEN_CALLER", "창 주소를 확인하지 못했습니다."))?;
    if !url_policy::is_local_app_origin(&url) {
        return Err(CommandError::new(
            "FORBIDDEN_CALLER",
            "로컬 앱 문서가 아니므로 설정 명령을 거부했습니다.",
        ));
    }
    Ok(())
}

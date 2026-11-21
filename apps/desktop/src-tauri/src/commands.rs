//! 프런트엔드(`ui/app.js`)가 호출하는 명령들.
//!
//! 모든 상태 변경 명령은 `window: WebviewWindow`를 받아 로컬 셸 창인지 확인한다
//! (`app_state::ensure_shell_caller`). 창을 만드는 명령은 async다 — Windows에서 동기 명령
//! 안에서 창을 만들면 교착되는 WebView2 문제를 피한다.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::app_state::{self, CommandError};
use crate::probe::ProbeResult;
use crate::settings::{ClientSettings, ThemePreference};
use crate::url_policy;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub server_url: String,
    pub open_workspace_on_start: bool,
    pub theme: ThemePreference,
    pub status: ProbeResult,
    pub load_note: Option<String>,
    pub config_path: String,
    pub app_version: String,
    pub platform: String,
    pub workspace_open: bool,
    pub settings_schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub server_url: String,
    #[serde(default = "default_open_workspace")]
    pub open_workspace_on_start: bool,
    #[serde(default)]
    pub theme: ThemePreference,
}

fn default_open_workspace() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub platform: String,
    pub config_path: String,
    pub settings_schema_version: u32,
    pub api_base_path: String,
    pub probe_timeout_secs: u64,
    pub poll_interval_secs: u64,
    pub shell_origin_only: bool,
    pub secrets_stored_in_client: bool,
}

fn build_view(app: &AppHandle) -> ClientView {
    let settings = app_state::current_settings(app);
    let state = app.state::<app_state::AppState>();
    let config_path = state.config_dir.join(crate::settings::SETTINGS_FILE);
    let server_url = settings.server_url.clone().unwrap_or_default();
    ClientView {
        server_url,
        open_workspace_on_start: settings.open_workspace_on_start,
        theme: settings.theme,
        status: app_state::current_status(app),
        load_note: app_state::read_load_note(app),
        config_path: config_path.display().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        workspace_open: app.get_webview_window(app_state::WORKSPACE_LABEL).is_some(),
        settings_schema_version: crate::settings::SETTINGS_SCHEMA_VERSION,
    }
}

#[tauri::command]
pub fn get_client_view(app: AppHandle) -> ClientView {
    build_view(&app)
}

#[tauri::command]
pub fn get_diagnostics(app: AppHandle) -> Diagnostics {
    let state = app.state::<app_state::AppState>();
    Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        config_path: state
            .config_dir
            .join(crate::settings::SETTINGS_FILE)
            .display()
            .to_string(),
        settings_schema_version: crate::settings::SETTINGS_SCHEMA_VERSION,
        api_base_path: url_policy::API_BASE_PATH.to_string(),
        probe_timeout_secs: crate::probe::PROBE_TIMEOUT.as_secs(),
        poll_interval_secs: app_state::POLL_INTERVAL_SECS,
        shell_origin_only: true,
        secrets_stored_in_client: false,
    }
}

/// 서버 주소를 검증·저장하고 즉시 한 번 확인한다.
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    window: WebviewWindow,
    payload: SettingsUpdate,
) -> Result<ClientView, CommandError> {
    app_state::ensure_shell_caller(&window)?;

    let raw = payload.server_url.trim();
    let normalized = if raw.is_empty() {
        None
    } else {
        Some(
            url_policy::normalize_server_url(raw)
                .map_err(|err| CommandError::new("INVALID_SERVER_URL", err.message()))?,
        )
    };

    let next = ClientSettings {
        schema_version: crate::settings::SETTINGS_SCHEMA_VERSION,
        server_url: normalized.as_ref().map(|url| url.as_str().to_string()),
        open_workspace_on_start: payload.open_workspace_on_start,
        theme: payload.theme,
    };

    app_state::persist_settings(&app, &next)?;
    app_state::probe_current(&app).await;
    Ok(build_view(&app))
}

/// 저장하지 않고 입력한 주소만 시험한다.
#[tauri::command]
pub async fn test_server_url(
    window: WebviewWindow,
    url: String,
) -> Result<ProbeResult, CommandError> {
    app_state::ensure_shell_caller(&window)?;
    let normalized = url_policy::normalize_server_url(&url)
        .map_err(|err| CommandError::new("INVALID_SERVER_URL", err.message()))?;
    Ok(crate::probe::probe(&normalized).await)
}

#[tauri::command]
pub async fn refresh_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ClientView, CommandError> {
    app_state::ensure_shell_caller(&window)?;
    app_state::probe_current(&app).await;
    Ok(build_view(&app))
}

/// 작업 공간 창을 연다. 서버 주소가 없거나 정책에 맞지 않으면 열지 않는다.
#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ClientView, CommandError> {
    app_state::ensure_shell_caller(&window)?;
    let settings = app_state::current_settings(&app);
    let raw = settings
        .server_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::new("SERVER_URL_REQUIRED", "먼저 서버 주소를 저장하세요."))?;
    let url = url_policy::normalize_server_url(raw)
        .map_err(|err| CommandError::new("INVALID_SERVER_URL", err.message()))?;

    app_state::open_or_focus_workspace(&app, &url)?;
    app_state::show_settings_window(&app);
    Ok(build_view(&app))
}

#[tauri::command]
pub async fn show_settings(app: AppHandle, window: WebviewWindow) -> Result<(), CommandError> {
    app_state::ensure_shell_caller(&window)?;
    app_state::show_settings_window(&app);
    Ok(())
}

/// 이 기기의 웹뷰 데이터(쿠키·스토리지)를 지운다.
#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ClientView, CommandError> {
    app_state::ensure_shell_caller(&window)?;
    app_state::clear_local_session(&app)?;
    Ok(build_view(&app))
}

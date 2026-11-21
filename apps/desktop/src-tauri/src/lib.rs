//! PROJECT AI ROOM — 데스크톱 셸 (Tauri v2).
//!
//! 원칙
//!  - 클라우드 전용: 화면은 Cloudflare Workers 웹 앱을 HTTPS로 불러온다. 로컬 셸·빌드 실행기 없음.
//!  - 로컬 임의 명령 실행 기능을 만들지 않는다. 명령은 아래 목록이 전부다.
//!  - AI 제공자 키·Cloudflare 토큰·GitHub 키를 이 앱은 저장하지도, 요청하지도 않는다.
//!  - 원격 문서에는 IPC 권한을 주지 않는다(capabilities/default.json + 창 라벨 검사).

mod app_state;
mod commands;
mod probe;
mod settings;
mod tray;
mod url_policy;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use app_state::AppState;

const STARTUP_WORKSPACE_DELAY_MS: u64 = 300;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

            let outcome = settings::load(&config_dir);

            app.manage(AppState {
                config_dir,
                settings: Arc::new(Mutex::new(outcome.settings)),
                status: Arc::new(Mutex::new(probe::ProbeResult::unconfigured())),
                load_note: Mutex::new(outcome.note),
            });

            if let Err(err) = tray::build(&handle) {
                eprintln!("tray init error: {err}");
                let state = app.state::<AppState>();
                let mut guard = match state.load_note.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *guard = Some(tray::unavailable_note().to_string());
            }

            // 30초마다 연결 상태를 확인하고 트레이·설정 창에 알린다.
            let poll_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = app_state::probe_current(&poll_handle).await;
                    tokio::time::sleep(Duration::from_secs(app_state::POLL_INTERVAL_SECS)).await;
                }
            });

            // 설정에 따라 시작 시 작업 공간 창을 연다(이벤트 루프 진입 뒤에 만들도록 지연).
            let open_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(STARTUP_WORKSPACE_DELAY_MS)).await;
                let settings = app_state::current_settings(&open_handle);
                if !settings.open_workspace_on_start {
                    return;
                }
                let Some(raw) = settings.server_url.as_deref() else {
                    return;
                };
                match url_policy::normalize_server_url(raw) {
                    Ok(url) => {
                        if let Err(err) = app_state::open_or_focus_workspace(&open_handle, &url) {
                            eprintln!("startup workspace failed: {err}");
                        }
                    }
                    Err(err) => {
                        eprintln!("startup url rejected: {}", err.message());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_client_view,
            commands::get_diagnostics,
            commands::save_settings,
            commands::test_server_url,
            commands::refresh_status,
            commands::open_workspace,
            commands::show_settings,
            commands::clear_session,
        ])
        .run(tauri::generate_context!())
        .expect("AI ROOM 데스크톱 셸을 시작하지 못했습니다");
}

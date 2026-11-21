//! 트레이 아이콘과 메뉴.
//!
//! 메뉴 동작은 앱이 창을 닫힌 뒤에도 남는 유일한 조작면이다.
//! 창 생성은 여기서 직접 하지 않고 async 런타임으로 넘긴다(Windows WebView2 교착 회피).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

use crate::app_state::{self, TRAY_ID};
use crate::url_policy;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open-workspace", "AI ROOM 열기", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "show-settings", "서버 설정", true, None::<&str>)?;
    let clear = MenuItem::with_id(
        app,
        "clear-session",
        "로그아웃 (이 기기 세션 지우기)",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let sep_top = PredefinedMenuItem::separator(app)?;
    let sep_bottom = PredefinedMenuItem::separator(app)?;

    let menu = Menu::new(app)?;
    menu.append(&open)?;
    menu.append(&settings_item)?;
    menu.append(&sep_top)?;
    menu.append(&clear)?;
    menu.append(&sep_bottom)?;
    menu.append(&quit)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("AI ROOM — 상태 확인 중");

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-workspace" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let settings = app_state::current_settings(&handle);
                    let raw = settings
                        .server_url
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    match raw {
                        Some(raw) => match url_policy::normalize_server_url(raw) {
                            Ok(url) => {
                                if let Err(err) = app_state::open_or_focus_workspace(&handle, &url)
                                {
                                    eprintln!("tray open failed: {err}");
                                    app_state::show_settings_window(&handle);
                                }
                            }
                            Err(err) => {
                                eprintln!("tray open rejected: {}", err.message());
                                app_state::show_settings_window(&handle);
                            }
                        },
                        None => app_state::show_settings_window(&handle),
                    }
                });
            }
            "show-settings" => app_state::show_settings_window(app),
            "clear-session" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = app_state::clear_local_session(&handle) {
                        eprintln!("tray clear session failed: {err}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map(|_| ())
}

/// 트레이를 만들 수 없을 때 사용자에게 보여줄 안내 문구.
pub fn unavailable_note() -> &'static str {
    "트레이 아이콘을 만들지 못했습니다. 창으로만 사용할 수 있습니다."
}

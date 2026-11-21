// Windows 릴리스 빌드에서 콘솔 창을 띄우지 않는다. 디버그 빌드는 로그 확인을 위해 콘솔 유지.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_room_desktop_lib::run();
}

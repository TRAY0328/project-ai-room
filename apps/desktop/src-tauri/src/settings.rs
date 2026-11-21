//! 클라이언트 설정 저장.
//!
//! 저장하는 것은 **비밀이 아닌 값뿐**이다: 서버 URL, 시작 동작, 테마.
//! 다음은 절대 이 파일(또는 앱 번들)에 넣지 않는다.
//!   - AI 제공자 API 키, Cloudflare 토큰, GitHub 앱 키: 서버(Cloudflare secret)에만 존재
//!   - 세션 쿠키/토큰: WebView2 사용자 프로필이 관리하며 앱 코드가 읽지 않는다
//!
//! 쓰기는 임시 파일 + rename으로 원자적으로 한다(중간에 꺼져도 반쯤 쓰인 JSON이 남지 않게).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "client-settings.json";
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientSettings {
    pub schema_version: u32,
    /// 사용자가 정한 Cloudflare Workers 주소. 미설정이면 None(기본값을 지어내지 않는다).
    pub server_url: Option<String>,
    /// 앱을 열 때 작업 공간 창을 바로 띄울지.
    pub open_workspace_on_start: bool,
    pub theme: ThemePreference,
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            server_url: None,
            open_workspace_on_start: true,
            theme: ThemePreference::default(),
        }
    }
}

pub struct LoadOutcome {
    pub settings: ClientSettings,
    /// 파일이 깨졌거나 스키마가 달랐을 때 사용자에게 보여줄 안내. 없으면 None.
    pub note: Option<String>,
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

pub fn load(config_dir: &Path) -> LoadOutcome {
    let path = settings_path(config_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return LoadOutcome {
                settings: ClientSettings::default(),
                note: None,
            }
        }
        Err(err) => {
            return LoadOutcome {
                settings: ClientSettings::default(),
                note: Some(format!(
                    "설정 파일을 읽지 못했습니다({err}). 기본값으로 시작합니다."
                )),
            }
        }
    };

    match serde_json::from_str::<ClientSettings>(&raw) {
        Ok(mut settings) => {
            if settings.schema_version != SETTINGS_SCHEMA_VERSION {
                let note = format!(
                    "설정 파일 버전({})이 이 앱({})과 달라 기본값으로 다시 시작합니다.",
                    settings.schema_version, SETTINGS_SCHEMA_VERSION
                );
                settings = ClientSettings::default();
                return LoadOutcome {
                    settings,
                    note: Some(note),
                };
            }
            LoadOutcome {
                settings,
                note: None,
            }
        }
        Err(_) => LoadOutcome {
            // 깨진 JSON을 조용히 덮어쓰지 않는다. 다음 저장 때 새 파일로 교체된다.
            settings: ClientSettings::default(),
            note: Some("설정 파일이 손상되어 기본값으로 시작합니다.".to_string()),
        },
    }
}

pub fn save(config_dir: &Path, settings: &ClientSettings) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = settings_path(config_dir);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(settings)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("airoom-settings-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_loads_defaults_without_note() {
        let dir = temp_dir("missing");
        let outcome = load(&dir);
        assert_eq!(outcome.settings, ClientSettings::default());
        assert!(outcome.note.is_none());
        assert!(outcome.settings.server_url.is_none());
    }

    #[test]
    fn round_trips_settings() {
        let dir = temp_dir("roundtrip");
        let settings = ClientSettings {
            server_url: Some("https://ai-room.example.workers.dev".to_string()),
            open_workspace_on_start: false,
            theme: ThemePreference::Dark,
            ..ClientSettings::default()
        };
        save(&dir, &settings).expect("save");
        let outcome = load(&dir);
        assert_eq!(outcome.settings, settings);
        assert!(outcome.note.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_reports_note_and_does_not_crash() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(settings_path(&dir), b"{ not json").unwrap();
        let outcome = load(&dir);
        assert_eq!(outcome.settings, ClientSettings::default());
        assert!(outcome.note.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored_for_forward_compatibility() {
        let dir = temp_dir("forward");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            settings_path(&dir),
            br#"{"schemaVersion":1,"serverUrl":null,"openWorkspaceOnStart":true,"theme":"system","futureField":42}"#,
        )
        .unwrap();
        let outcome = load(&dir);
        assert!(outcome.note.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}

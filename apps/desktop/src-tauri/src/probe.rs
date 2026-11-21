//! 서버 연결 확인.
//!
//! 목적은 하나다: "지금 이 기기에서 설정한 Cloudflare Worker에 닿는가"를 사실대로 보여주는 것.
//! 확인하지 못한 것을 '연결됨'으로 표시하지 않는다.
//!
//! 방식: `GET {base}/api/v1` (인증 없음, 리다이렉트 미추적, 8초 제한).
//! 이 경로를 고른 이유는 계약(`packages/contracts/src/api.ts`)의 API_BASE_PATH이기 때문이다.
//! 별도 health 라우트는 아직 계약 카탈로그에 없다 — 404 응답도 "Worker가 살아서 응답했다"는
//! 사실은 증명하므로 그렇게 표시하고, 서버 상태 전체를 뜻하는 '정상'으로 승격하지 않는다.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::url_policy;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reachability {
    /// 서버 주소가 아직 설정되지 않았다.
    Unconfigured,
    /// 한 번도 확인하지 않았다.
    Unknown,
    /// HTTP 응답을 받았다(2xx~4xx). 서버가 살아 있다.
    Online,
    /// 401/403 — 서버는 살아 있고 인증이 필요하다.
    AuthRequired,
    /// 5xx — 서버가 응답했지만 오류 상태다.
    ServerError,
    /// 전송 단계 실패(시간 초과·DNS·TLS). 서버 도달 불가.
    Offline,
    /// 설정된 주소가 정책에 맞지 않는다.
    InvalidUrl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub reachability: Reachability,
    pub http_status: Option<u16>,
    pub latency_ms: Option<u64>,
    /// UTC RFC3339. 표시 형식 변환은 UI가 한다.
    pub checked_at: String,
    /// 비밀을 담지 않는 짧은 설명(한국어).
    pub detail: String,
    /// 확인한 대상의 origin(경로 제외). 사용자에게 무엇을 확인했는지 보여준다.
    pub target: Option<String>,
}

impl ProbeResult {
    pub fn unconfigured() -> Self {
        Self {
            reachability: Reachability::Unconfigured,
            http_status: None,
            latency_ms: None,
            checked_at: now_rfc3339(),
            detail: "서버 주소가 설정되지 않았습니다.".to_string(),
            target: None,
        }
    }

    pub fn invalid(message: &str) -> Self {
        Self {
            reachability: Reachability::InvalidUrl,
            http_status: None,
            latency_ms: None,
            checked_at: now_rfc3339(),
            detail: message.to_string(),
            target: None,
        }
    }

    pub fn is_usable(&self) -> bool {
        matches!(
            self.reachability,
            Reachability::Online | Reachability::AuthRequired | Reachability::ServerError
        )
    }
}

/// 주어진 서버 base URL로 실제 요청을 보내 결과를 돌려준다.
pub async fn probe(base: &url::Url) -> ProbeResult {
    let target = url_policy::contract_root(base);
    let origin = match base.host_str() {
        Some(host) => match base.port() {
            Some(port) => format!("{}://{}:{}", base.scheme(), host, port),
            None => format!("{}://{}", base.scheme(), host),
        },
        None => String::new(),
    };

    let client = match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("AI-ROOM-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return ProbeResult {
                reachability: Reachability::Offline,
                http_status: None,
                latency_ms: None,
                checked_at: now_rfc3339(),
                detail: "연결 확인 도구를 초기화하지 못했습니다.".to_string(),
                target: Some(origin),
            }
        }
    };

    let started = Instant::now();
    let response = client
        .get(target.as_str())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    match response {
        Ok(resp) => {
            let status = resp.status();
            let code = status.as_u16();
            let (reachability, detail) = if status.is_server_error() {
                (
                    Reachability::ServerError,
                    "서버가 오류 상태로 응답했습니다(5xx). 잠시 뒤 다시 확인하세요.".to_string(),
                )
            } else if code == 401 || code == 403 {
                (
                    Reachability::AuthRequired,
                    "서버는 응답하며 인증이 필요합니다. 작업 공간에서 로그인하세요.".to_string(),
                )
            } else if status.is_success() || status.is_redirection() || status.is_client_error() {
                (
                    Reachability::Online,
                    format!("서버가 응답했습니다(HTTP {code})."),
                )
            } else {
                (
                    Reachability::Offline,
                    format!("예상하지 못한 응답입니다(HTTP {code})."),
                )
            };
            ProbeResult {
                reachability,
                http_status: Some(code),
                latency_ms: Some(latency_ms),
                checked_at: now_rfc3339(),
                detail,
                target: Some(origin),
            }
        }
        Err(err) => {
            let detail = if err.is_timeout() {
                format!("{}초 안에 응답이 없습니다.", PROBE_TIMEOUT.as_secs())
            } else if err.is_connect() {
                "서버에 연결하지 못했습니다(DNS·TLS·네트워크).".to_string()
            } else if err.is_redirect() {
                "서버가 다른 주소로 넘기려 했습니다. 주소를 확인하세요.".to_string()
            } else {
                "요청을 완료하지 못했습니다.".to_string()
            };
            ProbeResult {
                reachability: Reachability::Offline,
                http_status: None,
                latency_ms: Some(latency_ms),
                checked_at: now_rfc3339(),
                detail,
                target: Some(origin),
            }
        }
    }
}

/// 초 단위 Unix 시각을 RFC3339(UTC)로 적는다. chrono를 쓰지 않아 의존성을 줄인다.
pub fn now_rfc3339() -> String {
    let secs = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => 0,
    };
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant의 civil_from_days 알고리즘(1970-01-01 기준).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_is_not_usable() {
        let result = ProbeResult::unconfigured();
        assert_eq!(result.reachability, Reachability::Unconfigured);
        assert!(!result.is_usable());
    }

    #[test]
    fn invalid_url_is_reported_as_such() {
        let result = ProbeResult::invalid("https:// 주소만 허용됩니다.");
        assert_eq!(result.reachability, Reachability::InvalidUrl);
        assert!(!result.is_usable());
    }

    #[test]
    fn rfc3339_has_expected_epoch_format() {
        assert_eq!(now_rfc3339().len(), 20);
        assert!(now_rfc3339().starts_with("20"));
        assert!(now_rfc3339().ends_with('Z'));
    }

    #[test]
    fn civil_dates_match_known_values() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        assert_eq!(civil_from_days(20_690), (2026, 8, 25));
    }
}

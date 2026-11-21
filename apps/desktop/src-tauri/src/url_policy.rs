//! 서버 URL 정책.
//!
//! 이 클라이언트는 **클라우드 전용**이다. 그래서 서버 주소는 다음만 허용한다.
//!   - `https://` (평문 http는 디버그 빌드의 loopback 개발 주소만)
//!   - 자격 증명(user:pass@) 없음, 쿼리·프래그먼트 없음
//!   - loopback/사설/링크로컬/메타데이터 호스트 없음 (릴리스)
//!
//! 사설 주소를 막는 이유: 데스크톱 셸이 임의의 내부 주소로 요청을 보내는 SSRF·DNS rebinding
//! 통로가 되지 않게 하기 위해서다. 명세 20.1(9)의 통제를 클라이언트 쪽에서도 지킨다.

use std::net::IpAddr;

use url::Url;

pub const MAX_URL_LEN: usize = 2048;
pub const API_BASE_PATH: &str = "/api/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlPolicyError {
    Empty,
    TooLong,
    ContainsControlCharacters,
    Invalid(String),
    UnsupportedScheme(String),
    UserInfoNotAllowed,
    QueryOrFragmentNotAllowed,
    MissingHost,
    HostNotAllowed(String),
}

impl UrlPolicyError {
    /// 사용자에게 보여줄 한국어 문구. 내부 정보·원본 오류 문자열을 그대로 노출하지 않는다.
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "서버 주소를 입력하세요.".to_string(),
            Self::TooLong => format!("서버 주소가 너무 깁니다(최대 {MAX_URL_LEN}자)."),
            Self::ContainsControlCharacters => "서버 주소에 허용되지 않는 문자가 있습니다.".to_string(),
            Self::Invalid(_) => "서버 주소 형식이 올바르지 않습니다.".to_string(),
            Self::UnsupportedScheme(scheme) => format!(
                "'{scheme}' 주소는 사용할 수 없습니다. https:// 주소만 허용됩니다."
            ),
            Self::UserInfoNotAllowed => "주소에 사용자 이름·비밀번호를 넣을 수 없습니다.".to_string(),
            Self::QueryOrFragmentNotAllowed => "주소에 ?쿼리 또는 #프래그먼트를 넣을 수 없습니다.".to_string(),
            Self::MissingHost => "주소에 호스트 이름이 없습니다.".to_string(),
            Self::HostNotAllowed(host) => format!(
                "'{host}' 주소는 이 클라이언트에서 허용되지 않습니다. Cloudflare Workers 같은 공용 HTTPS 주소를 입력하세요."
            ),
        }
    }
}

/// 디버그 빌드에서만 사설 주소를 허용한다(릴리스에서는 항상 차단).
pub fn policy_allows_private_hosts() -> bool {
    cfg!(debug_assertions)
}

/// 저장·연결에 쓸 수 있는 서버 URL로 정규화한다.
pub fn normalize_server_url(raw: &str) -> Result<Url, UrlPolicyError> {
    normalize_with(raw, policy_allows_private_hosts())
}

/// 테스트에서 정책 플래그를 고정하기 위한 내부 구현.
pub fn normalize_with(raw: &str, allow_private_hosts: bool) -> Result<Url, UrlPolicyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UrlPolicyError::Empty);
    }
    if trimmed.len() > MAX_URL_LEN {
        return Err(UrlPolicyError::TooLong);
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(UrlPolicyError::ContainsControlCharacters);
    }

    let with_scheme = match detected_scheme(trimmed) {
        None => format!("https://{trimmed}"),
        Some(_) if trimmed.contains("://") => trimmed.to_string(),
        Some(scheme) => {
            let lower = scheme.to_ascii_lowercase();
            let rest = &trimmed[scheme.len() + 1..];
            if lower == "http" || lower == "https" {
                format!("https://{trimmed}")
            } else if scheme.contains('.')
                && !rest.is_empty()
                && rest.chars().all(|c| c.is_ascii_digit())
            {
                // `example.com:8080` 처럼 스킴처럼 보이지만 실제로는 호스트:포트인 경우.
                format!("https://{trimmed}")
            } else {
                // `javascript:`, `file:`, `data:` 같은 스킴은 그대로 두고 아래에서 거부한다.
                trimmed.to_string()
            }
        }
    };

    let mut url =
        Url::parse(&with_scheme).map_err(|_| UrlPolicyError::Invalid(with_scheme.clone()))?;

    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlPolicyError::UserInfoNotAllowed);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(UrlPolicyError::QueryOrFragmentNotAllowed);
    }

    let scheme = url.scheme().to_ascii_lowercase();

    match scheme.as_str() {
        // 클라우드 전용: https는 공용 호스트만, 사설·loopback·메타데이터는 릴리스에서 거부.
        "https" => {
            let host = url
                .host_str()
                .map(str::to_string)
                .ok_or(UrlPolicyError::MissingHost)?;
            check_host(&host, allow_private_hosts)?;
        }
        // 평문 http는 디버그 빌드의 loopback 개발 서버에서만.
        "http" => {
            let host = url
                .host_str()
                .map(str::to_string)
                .ok_or(UrlPolicyError::MissingHost)?;
            if !(cfg!(debug_assertions) && is_loopback_host(&host)) {
                return Err(UrlPolicyError::UnsupportedScheme("http".to_string()));
            }
        }
        other => return Err(UrlPolicyError::UnsupportedScheme(other.to_string())),
    }

    // 경로 정규화: 끝의 '/'만 제거하고 접두 경로는 보존한다.
    let base_path = url.path().trim_end_matches('/').to_string();
    let path: &str = if base_path.is_empty() {
        "/"
    } else {
        base_path.as_str()
    };
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// RFC 3986 스킴 접두사(`scheme:`)를 찾는다. 없으면 None.
fn detected_scheme(input: &str) -> Option<&str> {
    let mut end = None;
    for (i, ch) in input.char_indices() {
        if ch == ':' {
            end = Some(i);
            break;
        }
        let allowed = if i == 0 {
            ch.is_ascii_alphabetic()
        } else {
            ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.')
        };
        if !allowed {
            return None;
        }
    }
    let end = end?;
    if end == 0 {
        return None;
    }
    Some(&input[..end])
}

/// 사설·링크로컬·메타데이터 호스트 차단.
fn check_host(host: &str, allow_private_hosts: bool) -> Result<(), UrlPolicyError> {
    let lower = host.trim_end_matches('.').to_ascii_lowercase();

    if lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".localhost")
        || lower.ends_with(".localdomain")
        || lower == "localhost"
        || lower == "metadata"
        || lower == "metadata.google.internal"
    {
        return Err(UrlPolicyError::HostNotAllowed(lower));
    }

    if let Ok(ip) = lower
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        if is_private_ip(&ip) && !allow_private_hosts {
            return Err(UrlPolicyError::HostNotAllowed(lower));
        }
    }

    Ok(())
}

pub fn is_loopback_host(host: &str) -> bool {
    let lower = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    lower == "localhost"
        || lower == "::1"
        || lower.starts_with("127.")
        || lower.ends_with(".localhost")
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]) // CGNAT 100.64/10
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // 링크로컬 fe80::/10
                || v6.to_ipv4_mapped().is_some_and(|v4| is_private_ip(&IpAddr::V4(v4)))
        }
    }
}

/// Tauri 앱의 로컬 셸 문서인지. IPC 권한을 준 창인지 확인하는 2차 방어선으로 쓴다.
///
/// Windows에서는 `http://tauri.localhost`, macOS/Linux에서는 `tauri://localhost`.
pub fn is_local_app_origin(url: &Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && url
            .host_str()
            .is_some_and(|h| h.eq_ignore_ascii_case("tauri.localhost"))
}

/// 연결 확인에 쓰는 계약 루트 URL(서버 base + `/api/v1`).
pub fn contract_root(base: &Url) -> Url {
    let mut out = base.clone();
    let mut path = out.path().trim_end_matches('/').to_string();
    path.push_str(API_BASE_PATH);
    out.set_path(&path);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_workers_https_url() {
        let url = normalize_with("https://ai-room.example.workers.dev", false).expect("valid");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("ai-room.example.workers.dev"));
        assert_eq!(url.path(), "/");
    }

    #[test]
    fn adds_https_when_scheme_is_missing() {
        let url = normalize_with("ai-room.example.workers.dev/", false).expect("valid");
        assert_eq!(url.as_str(), "https://ai-room.example.workers.dev/");
    }

    #[test]
    fn keeps_path_prefix_and_strips_trailing_slash() {
        let url = normalize_with("https://example.com/room/", false).expect("valid");
        assert_eq!(url.path(), "/room");
    }

    #[test]
    fn rejects_non_https_schemes() {
        assert_eq!(
            normalize_with("javascript:alert(1)", false).unwrap_err(),
            UrlPolicyError::UnsupportedScheme("javascript".to_string())
        );
        assert_eq!(
            normalize_with("file:///C:/Windows/System32/calc.exe", false).unwrap_err(),
            UrlPolicyError::UnsupportedScheme("file".to_string())
        );
    }

    #[test]
    fn rejects_plain_http_in_release_policy() {
        let err = normalize_with("http://ai-room.example.workers.dev", false).unwrap_err();
        assert!(matches!(err, UrlPolicyError::UnsupportedScheme(_)));
    }

    #[test]
    fn rejects_userinfo() {
        assert_eq!(
            normalize_with("https://user:pass@example.com", false).unwrap_err(),
            UrlPolicyError::UserInfoNotAllowed
        );
    }

    #[test]
    fn rejects_query_and_fragment() {
        assert_eq!(
            normalize_with("https://example.com/?token=abc", false).unwrap_err(),
            UrlPolicyError::QueryOrFragmentNotAllowed
        );
        assert_eq!(
            normalize_with("https://example.com/#frag", false).unwrap_err(),
            UrlPolicyError::QueryOrFragmentNotAllowed
        );
    }

    #[test]
    fn rejects_private_and_metadata_hosts_in_release_policy() {
        for raw in [
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://192.168.0.10",
            "https://169.254.169.254",
            "https://metadata.google.internal",
            "https://printer.local",
            "https://build.internal",
        ] {
            assert!(
                normalize_with(raw, false).is_err(),
                "{raw} should be rejected by the release policy"
            );
        }
    }

    #[test]
    fn allows_private_hosts_only_when_policy_permits() {
        assert!(normalize_with("https://127.0.0.1:8787", true).is_ok());
        assert!(normalize_with("https://192.168.0.10", true).is_ok());
    }

    #[test]
    fn rejects_empty_and_control_characters() {
        assert_eq!(
            normalize_with("   ", false).unwrap_err(),
            UrlPolicyError::Empty
        );
        assert_eq!(
            normalize_with("https://exa mple.com", false).unwrap_err(),
            UrlPolicyError::ContainsControlCharacters
        );
    }

    #[test]
    fn keeps_host_with_port_when_scheme_is_missing() {
        let url = normalize_with("example.com:8443", false).expect("valid");
        assert_eq!(url.as_str(), "https://example.com:8443/");
    }

    #[test]
    fn rejects_script_and_file_schemes_without_authority() {
        assert_eq!(
            normalize_with("javascript:alert(1)", false).unwrap_err(),
            UrlPolicyError::UnsupportedScheme("javascript".to_string())
        );
    }

    #[test]
    fn identifies_local_shell_origin() {
        assert!(is_local_app_origin(
            &Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(is_local_app_origin(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(!is_local_app_origin(
            &Url::parse("https://ai-room.example.workers.dev").unwrap()
        ));
    }

    #[test]
    fn contract_root_appends_api_base() {
        let base = Url::parse("https://ai-room.example.workers.dev").unwrap();
        assert_eq!(
            contract_root(&base).as_str(),
            "https://ai-room.example.workers.dev/api/v1"
        );
        let prefixed = Url::parse("https://example.com/room").unwrap();
        assert_eq!(
            contract_root(&prefixed).as_str(),
            "https://example.com/room/api/v1"
        );
    }
}

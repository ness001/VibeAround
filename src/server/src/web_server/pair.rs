//! Browser pairing API endpoints.
//!
//! - POST /va/api/pair/start    — generate a 6-digit code + session ID
//! - GET  /va/api/pair/status   — poll for verification + receive auth token
//! - POST /va/api/pair/complete — finish pairing with a valid bearer token
//! - POST /va/api/pair/ticket   — mint a local-owner QR ticket
//! - POST /va/api/pair/redeem   — exchange a QR ticket for owner credentials

use axum::body::{to_bytes, Body};
use axum::{
    extract::{Query, Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use super::auth::{extract_bearer_token, owner_cookie_headers, AuthState};
use super::AppState;

/// POST /va/api/pair/start — generate a pairing code.
///
/// Returns `{ "code": "847291", "sid": "uuid" }`.
/// The code expires in 1 minute.
pub async fn start_handler(State(state): State<AppState>, req: Request) -> Response {
    if !pairing_origin_allowed(&state, &req) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = match common::auth::pair::generate() {
        Ok((sid, code)) => Json(serde_json::json!({
            "code": code,
            "sid": sid,
        }))
        .into_response(),
        Err(common::auth::pair::GenerateError::TooManyPending) => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": "Too many pending pairing requests. Try again shortly."
                })),
            )
                .into_response();
            response.headers_mut().insert(
                header::RETRY_AFTER,
                common::auth::pair::CODE_TTL_SECS
                    .to_string()
                    .parse()
                    .expect("valid retry-after"),
            );
            response
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("valid cache-control header"),
    );
    response
}

#[derive(serde::Deserialize)]
pub struct StatusQuery {
    sid: String,
}

/// GET /va/api/pair/status?sid={sid} — poll for pairing status.
///
/// Returns:
/// - `{ "status": "pending" }` — waiting for `/pair` command
/// - `{ "status": "expired" }` — code has expired, frontend should refresh
/// - `{ "status": "verified" }` — paired! Also sets `va_owner` cookie with auth token
pub async fn status_handler(
    State(state): State<AppState>,
    Query(q): Query<StatusQuery>,
    req: Request,
) -> Response {
    if !pairing_origin_allowed(&state, &req) {
        return StatusCode::FORBIDDEN.into_response();
    }
    status_response(q, req)
}

fn status_response(q: StatusQuery, req: Request) -> Response {
    let mut response = match common::auth::pair::check_status(&q.sid) {
        None => {
            // Unknown or expired session.
            Json(serde_json::json!({ "status": "expired" })).into_response()
        }
        Some(false) => {
            // Still pending.
            Json(serde_json::json!({ "status": "pending" })).into_response()
        }
        Some(true) => {
            let Some(auth) = req.extensions().get::<AuthState>() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            // The verified IM sid remains idempotent until expiry.
            verified_response(&req, auth.owner.as_str())
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("valid cache-control header"),
    );
    response
}

fn verified_response(req: &Request, token: &str) -> Response {
    let [clear_legacy_cookie, owner_cookie] = owner_cookie_headers_for_request(req, token);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::SET_COOKIE, clear_legacy_cookie)
        .header(header::SET_COOKIE, owner_cookie)
        .body(Body::from(
            serde_json::json!({ "status": "verified", "token": token }).to_string(),
        ))
        .expect("valid pairing response")
}

/// Wrap the QR routes, including auth rejections, without changing IM pairing.
pub async fn no_store(req: Request, next: axum::middleware::Next) -> Response {
    let mut response = next.run(req).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("valid cache-control header"),
    );
    response
}

#[derive(serde::Deserialize)]
struct TicketRequest {
    public_url: String,
}

#[derive(serde::Deserialize)]
struct RedeemRequest {
    ticket: String,
}

pub async fn ticket_handler(req: Request) -> Response {
    let Some(auth) = req.extensions().get::<AuthState>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if !extract_bearer_token(req.headers()).is_some_and(|token| auth.owner.matches(&token)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // With an explicit owner bearer this matches require_local_bridge, including
    // Tauri origins, but never the loopback connection made by a tunnel proxy.
    if !super::auth::request_is_loopback(&req) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let body: TicketRequest = match qr_json(req.into_body()).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
    };
    let Some(audience) = public_url_audience(&body.public_url) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match common::auth::qr::generate(&auth.owner, &audience) {
        Ok(ticket) => Json(serde_json::json!({
            "ticket": ticket,
            "expires_in": common::auth::qr::TICKET_TTL_SECS,
        }))
        .into_response(),
        Err(common::auth::qr::GenerateError::TooManyPending) => {
            StatusCode::TOO_MANY_REQUESTS.into_response()
        }
    }
}

pub async fn redeem_handler(State(state): State<AppState>, req: Request) -> Response {
    if !pairing_origin_allowed(&state, &req) {
        return StatusCode::FORBIDDEN.into_response();
    }
    redeem_response(req).await
}

async fn redeem_response(mut req: Request) -> Response {
    let Some(auth) = req.extensions().get::<AuthState>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let body = std::mem::replace(req.body_mut(), Body::empty());
    let body: RedeemRequest = match qr_json(body).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
    };
    let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !common::auth::qr::redeem(&body.ticket, &auth.owner, host) {
        return StatusCode::GONE.into_response();
    }
    verified_response(&req, auth.owner.as_str())
}

async fn qr_json<T: serde::de::DeserializeOwned>(body: Body) -> Result<T, StatusCode> {
    let bytes = to_bytes(body, 1024)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)
}

fn public_url_audience(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    if value != origin && value != format!("{origin}/") && value != format!("{origin}/va/") {
        return None;
    }
    Some(origin.strip_prefix("https://")?.to_string())
}

fn pairing_origin_allowed(state: &AppState, req: &Request) -> bool {
    let tunnel_urls = state.tunnels.public_urls();
    super::auth::headers_have_allowed_dashboard_origin(req.headers(), state.port, &tunnel_urls)
}

/// POST /va/api/pair/complete — finish the Desktop-token fallback flow.
///
/// The protected router validates the bearer token before this handler runs.
/// Requiring the credential in the header keeps query-string tokens from
/// minting an owner cookie.
pub async fn complete_handler(req: Request) -> Response {
    let Some(token) = extract_bearer_token(req.headers()) else {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .expect("valid unauthorized response");
    };
    let [clear_legacy_cookie, owner_cookie] = owner_cookie_headers_for_request(&req, &token);
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::SET_COOKIE, clear_legacy_cookie)
        .header(header::SET_COOKIE, owner_cookie)
        .body(Body::empty())
        .expect("valid pairing response")
}

fn owner_cookie_headers_for_request(req: &Request, token: &str) -> [String; 2] {
    owner_cookie_headers((!super::auth::request_is_loopback(req)).then_some(token))
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, sync::Arc};

    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
        middleware,
        routing::post,
        Router,
    };
    use common::auth::AuthToken;

    use crate::web_server::auth::{owner_cookie_headers, require_auth, AuthState};

    #[test]
    fn qr_public_url_requires_canonical_https_origin_or_dashboard() {
        for (url, audience) in [
            ("https://phone.example", "phone.example"),
            ("https://phone.example/", "phone.example"),
            ("https://phone.example/va/", "phone.example"),
            ("https://phone.example:8443/va/", "phone.example:8443"),
            ("https://[::1]:8443/va/", "[::1]:8443"),
        ] {
            assert_eq!(super::public_url_audience(url).as_deref(), Some(audience));
        }
        for url in [
            "http://phone.example/va/",
            "https://user@phone.example/va/",
            "https://user:pass@phone.example/va/",
            "https://@phone.example/va/",
            "https://phone.example/va/?",
            "https://phone.example/va/#",
            "https://phone.example?token=secret",
            "https://phone.example/#ticket",
            "https://phone.example/other",
            "https://phone.example/va",
            "https://phone.example/a/../va/",
            "https://PHONE.example/va/",
            "https://phone.example:443/va/",
            " https://phone.example/va/",
            "https://phone.example/va/\n",
            "https://phone.example\\va\\",
        ] {
            assert_eq!(super::public_url_audience(url), None, "{url}");
        }
    }

    #[tokio::test]
    async fn qr_mint_and_redeem_enforce_credentials_bindings_and_body_limit() {
        let owner = Arc::new(AuthToken::generate());
        let token = owner.as_str().to_string();
        let mcp = Arc::new(AuthToken::generate());
        let auth = AuthState::new(owner, Arc::clone(&mcp));
        // Origin policy is exercised separately below; this harness isolates
        // credential exchange without constructing the dashboard's managers.
        let app = Router::new()
            .route("/ticket", post(super::ticket_handler))
            .route_layer(middleware::from_fn_with_state(auth.clone(), require_auth))
            .route("/redeem", post(super::redeem_response))
            .layer(axum::Extension(auth))
            .layer(middleware::from_fn(super::no_store));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let mint_url = format!("http://{address}/ticket");
        let redeem_url = format!("http://{address}/redeem");
        let mint = || client.post(&mint_url).bearer_auth(&token);
        let mint_body = r#"{"public_url":"https://phone.example:8443/va/"}"#;
        let check = |response: &reqwest::Response, status: StatusCode| {
            assert_eq!(response.status(), status);
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store"
            );
        };
        for request in [
            client.post(&mint_url),
            client.post(&mint_url).bearer_auth("wrong"),
            client.post(&mint_url).bearer_auth(mcp.as_str()),
            client.post(format!("{mint_url}?token={token}")),
            client
                .post(&mint_url)
                .header(header::COOKIE, format!("va_owner={token}")),
        ] {
            let response = request.body(mint_body).send().await.unwrap();
            check(&response, StatusCode::UNAUTHORIZED);
        }
        for name in [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "tailscale-funnel-request",
        ] {
            let response = mint()
                .header(name, "proxy")
                .body(mint_body)
                .send()
                .await
                .unwrap();
            check(&response, StatusCode::FORBIDDEN);
        }
        let response = mint()
            .header(header::HOST, "phone.example:8443")
            .body(mint_body)
            .send()
            .await
            .unwrap();
        check(&response, StatusCode::FORBIDDEN);
        let response = mint()
            .body(r#"{"public_url":"https://phone.example/va/?"}"#)
            .send()
            .await
            .unwrap();
        check(&response, StatusCode::BAD_REQUEST);
        for (body, status) in [
            ("{".to_string(), StatusCode::BAD_REQUEST),
            ("x".repeat(1025), StatusCode::PAYLOAD_TOO_LARGE),
        ] {
            let response = mint().body(body).send().await.unwrap();
            check(&response, status);
        }
        let issued = mint()
            .header(header::ORIGIN, "tauri://localhost")
            .body(mint_body)
            .send()
            .await
            .unwrap();
        check(&issued, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&issued.text().await.unwrap()).unwrap();
        assert_eq!(json["expires_in"], 60);
        let ticket = json["ticket"].as_str().unwrap();
        assert_eq!(ticket.len(), 64);
        assert_ne!(ticket, token);
        let redeem_body = serde_json::json!({"ticket": ticket}).to_string();
        for (body, status) in [
            ("{".to_string(), StatusCode::BAD_REQUEST),
            ("{}".to_string(), StatusCode::BAD_REQUEST),
            ("x".repeat(1025), StatusCode::PAYLOAD_TOO_LARGE),
            (r#"{"ticket":"bad"}"#.to_string(), StatusCode::GONE),
            (
                serde_json::json!({"ticket": AuthToken::generate().as_str()}).to_string(),
                StatusCode::GONE,
            ),
        ] {
            let response = client
                .post(&redeem_url)
                .header(header::HOST, "phone.example:8443")
                .body(body)
                .send()
                .await
                .unwrap();
            check(&response, status);
        }
        for host in ["other.example:8443", "phone.example"] {
            let response = client
                .post(&redeem_url)
                .header(header::HOST, host)
                .body(redeem_body.clone())
                .send()
                .await
                .unwrap();
            check(&response, StatusCode::GONE);
        }
        let verified = client
            .post(&redeem_url)
            .header(header::HOST, "phone.example:8443")
            .header("x-forwarded-for", "203.0.113.1")
            .body(redeem_body.clone())
            .send()
            .await
            .unwrap();
        check(&verified, StatusCode::OK);
        let cookies = verified
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(cookies, owner_cookie_headers(Some(&token)));
        let json: serde_json::Value =
            serde_json::from_str(&verified.text().await.unwrap()).unwrap();
        assert_eq!(json["status"], "verified");
        assert_eq!(json["token"], token);
        let replay = client
            .post(&redeem_url)
            .header(header::HOST, "phone.example:8443")
            .body(redeem_body)
            .send()
            .await
            .unwrap();
        check(&replay, StatusCode::GONE);
        server.abort();
    }

    #[tokio::test]
    async fn qr_mint_rejects_nonloopback_or_missing_peer() {
        for peer in [
            None,
            Some("203.0.113.1:1234".parse::<SocketAddr>().unwrap()),
        ] {
            let owner = Arc::new(AuthToken::generate());
            let mut req = Request::builder()
                .header(header::HOST, "localhost:12358")
                .header(header::AUTHORIZATION, format!("Bearer {}", owner.as_str()))
                .body(Body::empty())
                .unwrap();
            req.extensions_mut()
                .insert(AuthState::new(Arc::clone(&owner), owner));
            if let Some(peer) = peer {
                req.extensions_mut()
                    .insert(axum::extract::ConnectInfo(peer));
            }
            assert_eq!(
                super::ticket_handler(req).await.status(),
                StatusCode::FORBIDDEN
            );
        }
    }

    #[tokio::test]
    async fn qr_redemption_without_host_does_not_consume_ticket() {
        let owner = Arc::new(AuthToken::generate());
        let ticket = common::auth::qr::generate(&owner, "phone.example").unwrap();
        let mut req = Request::builder()
            .body(Body::from(
                serde_json::json!({"ticket": ticket}).to_string(),
            ))
            .unwrap();
        req.extensions_mut()
            .insert(AuthState::new(Arc::clone(&owner), Arc::clone(&owner)));
        assert_eq!(
            super::redeem_response(req).await.status(),
            StatusCode::FORBIDDEN
        );
        assert!(common::auth::qr::redeem(&ticket, &owner, "phone.example"));
    }

    #[test]
    fn owner_cookie_is_scoped_to_vibearound_routes() {
        assert_eq!(
            owner_cookie_headers(Some("test-token")),
            [
                "va_owner=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax".to_string(),
                "va_owner=test-token; Path=/va/; Secure; HttpOnly; SameSite=Lax".to_string(),
            ]
        );
    }

    #[test]
    fn local_pairing_clears_owner_credentials() {
        assert_eq!(
            owner_cookie_headers(None),
            [
                "va_owner=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax".to_string(),
                "va_owner=; Path=/va/; Max-Age=0; Secure; HttpOnly; SameSite=Lax".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn verified_pairing_status_is_idempotent_and_uses_daemon_token() {
        let auth = Arc::new(AuthToken::generate());
        let expected_token = auth.as_str().to_string();
        let (sid, code) = common::auth::pair::generate().unwrap();
        assert!(common::auth::pair::validate(&code));

        for _ in 0..2 {
            let mut request = Request::builder()
                .header(header::HOST, "preview.example")
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(AuthState::new(Arc::clone(&auth), Arc::clone(&auth)));
            let response = super::status_response(super::StatusQuery { sid: sid.clone() }, request);
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["status"], "verified");
            assert_eq!(json["token"], expected_token);
        }
    }

    #[test]
    fn browser_pairing_accepts_only_dashboard_origins() {
        let allowed = |origin: Option<&str>, tunnel_urls: &[String]| {
            let mut headers = axum::http::HeaderMap::new();
            if let Some(origin) = origin {
                headers.insert(header::ORIGIN, origin.parse().unwrap());
            }
            crate::web_server::auth::headers_have_allowed_dashboard_origin(
                &headers,
                12358,
                tunnel_urls,
            )
        };

        assert!(allowed(Some("http://127.0.0.1:12358"), &[]));
        assert!(allowed(
            Some("https://preview.example"),
            &["https://preview.example".into()]
        ));
        assert!(!allowed(Some("https://evil.example"), &[]));
        assert!(allowed(None, &[]), "native clients do not send Origin");
    }

    #[tokio::test]
    async fn desktop_token_completion_sets_only_valid_owner_credentials() {
        let auth = Arc::new(AuthToken::generate());
        let token = auth.as_str().to_string();
        let app = Router::new()
            .route("/", post(super::complete_handler))
            .route_layer(middleware::from_fn_with_state(
                AuthState::new(Arc::clone(&auth), auth),
                require_auth,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let url = format!("http://{address}/");

        let public = client
            .post(&url)
            .header(header::HOST, "preview.example")
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(public.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(
            public.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let public_cookies = public
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(public_cookies.len(), 2);
        assert_eq!(
            public_cookies[0],
            "va_owner=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
        );
        assert_eq!(
            public_cookies[1],
            format!("va_owner={token}; Path=/va/; Secure; HttpOnly; SameSite=Lax")
        );

        let local = client.post(&url).bearer_auth(&token).send().await.unwrap();
        assert_eq!(local.status(), reqwest::StatusCode::NO_CONTENT);
        let local_cookies = local
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            local_cookies,
            [
                "va_owner=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
                "va_owner=; Path=/va/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
            ]
        );

        for response in [
            client
                .post(&url)
                .header(header::HOST, "preview.example")
                .bearer_auth("wrong-token")
                .send()
                .await
                .unwrap(),
            client
                .post(format!("{url}?token={token}"))
                .header(header::HOST, "preview.example")
                .send()
                .await
                .unwrap(),
        ] {
            assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
            assert!(response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .next()
                .is_none());
        }

        server.abort();
    }
}

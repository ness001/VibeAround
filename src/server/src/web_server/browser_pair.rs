//! Device-scoped pairing approved only by the desktop's local owner.

use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use common::auth::browser::{unix_seconds, PairError, PairStatus};

use super::auth::{extract_bearer_token, request_is_loopback, AuthState, DEVICE_COOKIE};

#[derive(serde::Deserialize)]
struct StartBody {
    remember: bool,
}
#[derive(serde::Deserialize)]
pub struct StatusQuery {
    sid: String,
}
#[derive(serde::Deserialize)]
struct ApproveBody {
    id: String,
    code: String,
}
#[derive(serde::Deserialize)]
struct IdBody {
    id: String,
}

// Credential recovery is deliberately same-origin, not merely one of the
// dashboard's allowed origins. Fetch metadata blocks cross-site navigations
// even when Origin is absent; cookie recovery requires a same-origin signal.
fn same_origin(req: &Request, recovery: bool) -> bool {
    let site = req
        .headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok());
    if site.is_some_and(|site| site != "same-origin" && site != "none") {
        return false;
    }
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if let Some(origin) = origin {
        let Some(host) = req
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
        else {
            return false;
        };
        let Ok(origin) = reqwest::Url::parse(origin) else {
            return false;
        };
        let Ok(target) = reqwest::Url::parse(&format!("{}://{host}", origin.scheme())) else {
            return false;
        };
        if !matches!(origin.scheme(), "https" | "http")
            || origin.origin() != target.origin()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return false;
        }
        // A public cookie is HTTPS-only even when the tunnel speaks HTTP locally.
        if origin.scheme() != "https" && !request_is_loopback(req) {
            return false;
        }
        return true;
    }
    if req.headers().contains_key(header::ORIGIN) {
        return false;
    }
    !recovery || site == Some("same-origin")
}

fn auth(req: &Request) -> Result<AuthState, StatusCode> {
    req.extensions()
        .get::<AuthState>()
        .cloned()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn local_owner(req: &Request) -> Result<AuthState, StatusCode> {
    let auth = auth(req)?;
    if !extract_bearer_token(req.headers()).is_some_and(|token| auth.owner.matches(&token)) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !request_is_loopback(req) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(auth)
}

async fn json<T: serde::de::DeserializeOwned>(body: Body) -> Result<T, StatusCode> {
    let bytes = to_bytes(body, 1024)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)
}

fn error(error: PairError) -> Response {
    match error {
        PairError::Capacity => {
            (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "60")]).into_response()
        }
        PairError::Expired => StatusCode::GONE.into_response(),
        PairError::CodeMismatch => StatusCode::BAD_REQUEST.into_response(),
        PairError::Rejected => StatusCode::CONFLICT.into_response(),
        PairError::Storage(error) => {
            tracing::error!(%error, "browser device persistence failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn start_handler(req: Request) -> Response {
    if !req.headers().contains_key(header::ORIGIN) || !same_origin(&req, false) {
        return StatusCode::FORBIDDEN.into_response();
    }
    start_response(req).await
}

async fn start_response(req: Request) -> Response {
    let auth = match auth(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    let label = browser_label(
        req.headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );
    let body: StartBody = match json(req.into_body()).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
    };
    match auth.browsers.start(body.remember, label) {
        Ok(start) => Json(start).into_response(),
        Err(err) => error(err),
    }
}

fn browser_label(agent: &str) -> String {
    let browser = if agent.contains("Edg/") || agent.contains("EdgA/") {
        "Edge"
    } else if agent.contains("Chrome/") || agent.contains("CriOS/") {
        "Chrome"
    } else if agent.contains("Firefox/") || agent.contains("FxiOS/") {
        "Firefox"
    } else if agent.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let device = if agent.contains("iPhone") {
        "iPhone"
    } else if agent.contains("iPad") {
        "iPad"
    } else if agent.contains("Android") {
        "Android"
    } else {
        "device"
    };
    format!("{browser} on {device}")
}

pub async fn status_handler(Query(query): Query<StatusQuery>, req: Request) -> Response {
    if !same_origin(&req, false) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth = match auth(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    match auth.browsers.status(&query.sid) {
        PairStatus::Pending => Json(serde_json::json!({"status":"pending"})).into_response(),
        PairStatus::Expired => Json(serde_json::json!({"status":"expired"})).into_response(),
        PairStatus::Rejected => Json(serde_json::json!({"status":"rejected"})).into_response(),
        PairStatus::Verified {
            token,
            remember,
            expires_at,
        } => {
            let lifetime = if remember {
                format!("; Max-Age={}", expires_at.saturating_sub(unix_seconds()))
            } else {
                String::new()
            };
            let mut response =
                Json(serde_json::json!({"status":"verified","token":token})).into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                format!(
                "{DEVICE_COOKIE}={token}; Path=/va/; Secure; HttpOnly; SameSite=Strict{lifetime}"
            )
                .parse()
                .expect("valid device cookie"),
            );
            response
        }
    }
}

pub async fn session_handler(req: Request) -> Response {
    if !same_origin(&req, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth = match auth(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    let tokens = req
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter_map(|(name, value)| (name == DEVICE_COOKIE).then_some(value))
        .collect::<Vec<_>>();
    if tokens.len() == 1 && auth.browsers.authenticate(tokens[0]).is_some() {
        return Json(serde_json::json!({"status":"verified","token":tokens[0]})).into_response();
    }
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::SET_COOKIE,
            format!("{DEVICE_COOKIE}=; Path=/va/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"),
        )],
    )
        .into_response()
}

pub async fn requests_handler(req: Request) -> Response {
    match local_owner(&req) {
        Ok(auth) => Json(serde_json::json!({"requests":auth.browsers.requests()})).into_response(),
        Err(status) => status.into_response(),
    }
}

pub async fn approve_handler(req: Request) -> Response {
    let auth = match local_owner(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    let body: ApproveBody = match json(req.into_body()).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
    };
    match auth.browsers.approve(&body.id, &body.code) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => error(err),
    }
}

pub async fn reject_handler(req: Request) -> Response {
    let auth = match local_owner(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    let body: IdBody = match json(req.into_body()).await {
        Ok(body) => body,
        Err(status) => return status.into_response(),
    };
    match auth.browsers.reject(&body.id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => error(err),
    }
}

pub async fn devices_handler(req: Request) -> Response {
    match local_owner(&req) {
        Ok(auth) => Json(serde_json::json!({"devices":auth.browsers.devices()})).into_response(),
        Err(status) => status.into_response(),
    }
}

pub async fn revoke_handler(Path(id): Path<String>, req: Request) -> Response {
    let auth = match local_owner(&req) {
        Ok(auth) => auth,
        Err(status) => return status.into_response(),
    };
    match auth.browsers.revoke(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => error(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::ws::WebSocketUpgrade,
        routing::{delete, get, post},
        Extension, Router,
    };
    use common::auth::{browser::DeviceAccess, AuthToken};
    use futures_util::{SinkExt, StreamExt};
    use std::{net::SocketAddr, sync::Arc, time::Duration};


    async fn test_socket(
        Extension(mut access): Extension<DeviceAccess>,
        ws: WebSocketUpgrade,
    ) -> Response {
        ws.on_upgrade(move |mut socket| async move {
            socket
                .send(axum::extract::ws::Message::Text("connected".into()))
                .await
                .unwrap();
            access.cancelled().await;
            let _ = socket.close().await;
        })
    }

    #[tokio::test]
    async fn approval_device_auth_cookie_recovery_and_socket_revocation() {
        let owner = Arc::new(AuthToken::generate());
        let token = owner.as_str().to_owned();
        let auth = AuthState::new(owner, Arc::new(AuthToken::generate()));
        let app = Router::new()
            .route("/api/sessions", get(|| async { StatusCode::OK }))
            .route("/api/settings", get(|| async { StatusCode::OK }))
            .route(
                "/api/pair/complete",
                post(super::super::pair::complete_handler),
            )
            .route("/ws/chat", get(test_socket))
            .route_layer(axum::middleware::from_fn_with_state(
                auth.clone(),
                super::super::auth::require_auth,
            ))
            .route("/start", post(start_handler))
            .route("/status", get(status_handler))
            .route("/session", get(session_handler))
            .route("/requests", get(requests_handler))
            .route("/approve", post(approve_handler))
            .route("/reject", post(reject_handler))
            .route("/devices", get(devices_handler))
            .route("/devices/{id}", delete(revoke_handler))
            .layer(Extension(auth.clone()))
            .layer(axum::middleware::from_fn(super::super::pair::no_store));
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
        let base = format!("http://{address}");
        let start = client
            .post(format!("{base}/start"))
            .header(header::ORIGIN, &base)
            .header(header::USER_AGENT, "Chrome/123 Android")
            .body(r#"{"remember":true}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(start.headers()[header::CACHE_CONTROL], "no-store");
        let start: serde_json::Value = serde_json::from_str(&start.text().await.unwrap()).unwrap();
        let sid = start["sid"].as_str().unwrap();
        let code = start["code"].as_str().unwrap();
        for request in [
            client.get(format!("{base}/requests")),
            client.get(format!("{base}/requests?token={token}")),
            client
                .get(format!("{base}/requests"))
                .header(header::COOKIE, format!("va_owner={token}")),
            client
                .get(format!("{base}/requests"))
                .bearer_auth(auth.mcp.as_str()),
        ] {
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        for forwarded in [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "tailscale-funnel-request",
        ] {
            assert_eq!(
                client
                    .get(format!("{base}/requests"))
                    .bearer_auth(&token)
                    .header(forwarded, "proxy")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let requests: serde_json::Value = serde_json::from_str(
            &client
                .get(format!("{base}/requests"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
        )
        .unwrap();
        let id = requests["requests"][0]["id"].as_str().unwrap();
        assert_eq!(requests["requests"][0]["code"], code);
        assert_eq!(requests["requests"][0]["label"], "Chrome on Android");
        assert_ne!(id, sid);
        assert_eq!(
            client
                .post(format!("{base}/approve"))
                .bearer_auth(&token)
                .body(serde_json::json!({"id":id,"code":"wrong"}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!("{base}/approve"))
                    .bearer_auth(&token)
                    .body(serde_json::json!({"id":id,"code":code}).to_string())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        let status = client
            .get(format!("{base}/status?sid={sid}"))
            .send()
            .await
            .unwrap();
        let cookie = status.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.contains("Secure; HttpOnly; SameSite=Strict; Max-Age="));
        let status: serde_json::Value =
            serde_json::from_str(&status.text().await.unwrap()).unwrap();
        let device = status["token"].as_str().unwrap();
        assert_eq!(device.len(), 64);
        assert_ne!(device, token);
        let cookie = format!("{DEVICE_COOKIE}={device}");
        assert_eq!(
            client
                .get(format!("{base}/api/sessions"))
                .bearer_auth(device)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for (path, expected) in [("/requests", StatusCode::UNAUTHORIZED), ("/devices", StatusCode::UNAUTHORIZED), ("/api/settings", StatusCode::FORBIDDEN)] {
            assert_eq!(
                client
                    .get(format!("{base}{path}"))
                    .bearer_auth(device)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        let completion = client
            .post(format!("{base}/api/pair/complete"))
            .bearer_auth(device)
            .send()
            .await
            .unwrap();
        assert_eq!(completion.status(), StatusCode::FORBIDDEN);
        assert!(!completion.headers().contains_key(header::SET_COOKIE));
        for site in [None, Some("cross-site"), Some("same-site"), Some("none")] {
            let mut request = client
                .get(format!("{base}/session"))
                .header(header::COOKIE, &cookie);
            if let Some(site) = site {
                request = request.header("sec-fetch-site", site);
            }
            assert_eq!(
                request.send().await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            client
                .get(format!("{base}/session"))
                .header(header::COOKIE, &cookie)
                .header("sec-fetch-site", "same-origin")
                .header(header::ORIGIN, "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let recovered = client
            .get(format!("{base}/session"))
            .header(header::COOKIE, &cookie)
            .header("sec-fetch-site", "same-origin")
            .send()
            .await
            .unwrap();
        assert_eq!(recovered.headers()[header::CACHE_CONTROL], "no-store");
        let recovered: serde_json::Value =
            serde_json::from_str(&recovered.text().await.unwrap()).unwrap();
        assert_eq!(recovered["token"], device);
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws/chat?token={device}"))
                .await
                .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "connected"
        );
        assert_eq!(
            client
                .delete(format!("{base}/devices/{id}"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(
            closed.is_none()
                || matches!(
                    closed,
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | Some(Err(_))
                )
        );
        assert_eq!(
            client
                .get(format!("{base}/api/sessions"))
                .bearer_auth(device)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/session"))
                .header(header::COOKIE, &cookie)
                .header("sec-fetch-site", "same-origin")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        server.abort();
    }

    #[tokio::test]
    async fn start_accepts_unregistered_same_origin_https_gateway_but_never_cross_origin() {
        let owner = Arc::new(AuthToken::generate());
        let auth = AuthState::new(owner.clone(), owner);
        for (origin, site, expected) in [
            (Some("https://external.trycloudflare.com"), "same-origin", StatusCode::OK),
            (Some("https://evil.example"), "same-origin", StatusCode::FORBIDDEN),
            (Some("http://127.0.0.1:12358"), "same-origin", StatusCode::FORBIDDEN),
            (Some("https://external.trycloudflare.com"), "cross-site", StatusCode::FORBIDDEN),
            (None, "same-origin", StatusCode::FORBIDDEN),
        ] {
            let mut builder = Request::builder().header(header::HOST, "external.trycloudflare.com")
                .header("x-forwarded-for", "203.0.113.1").header("sec-fetch-site", site);
            if let Some(origin) = origin { builder = builder.header(header::ORIGIN, origin); }
            let mut req = builder.body(Body::from(r#"{"remember":false}"#)).unwrap();
            req.extensions_mut().insert(auth.clone());
            req.extensions_mut().insert(axum::extract::ConnectInfo("127.0.0.1:4321".parse::<SocketAddr>().unwrap()));
            assert_eq!(start_handler(req).await.status(), expected);
        }
    }

    #[tokio::test]
    async fn owner_guard_requires_real_loopback_and_session_cookie_is_not_persistent() {
        let owner = Arc::new(AuthToken::generate());
        let auth = AuthState::new(owner.clone(), owner.clone());
        for peer in [
            None,
            Some("203.0.113.1:3210".parse::<SocketAddr>().unwrap()),
        ] {
            let mut req = Request::builder()
                .header(header::HOST, "localhost:12358")
                .header(header::AUTHORIZATION, format!("Bearer {}", owner.as_str()))
                .body(Body::empty())
                .unwrap();
            req.extensions_mut().insert(auth.clone());
            if let Some(peer) = peer {
                req.extensions_mut()
                    .insert(axum::extract::ConnectInfo(peer));
            }
            assert_eq!(requests_handler(req).await.status(), StatusCode::FORBIDDEN);
        }
        let start = auth.browsers.start(false, "Phone".into()).unwrap();
        auth.browsers
            .approve(&auth.browsers.requests()[0].id, &start.code)
            .unwrap();
        let mut req = Request::builder().body(Body::empty()).unwrap();
        req.extensions_mut().insert(auth);
        let response = status_handler(Query(StatusQuery { sid: start.sid }), req).await;
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(!cookie.contains("Max-Age"));
        assert!(cookie.contains("Secure; HttpOnly; SameSite=Strict"));
    }
}

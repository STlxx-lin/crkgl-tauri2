//! 80 端口只读站：同一个程序给局域网的其他电脑看账。
//!
//! 边界（这是设计上的硬线，不靠前端隐藏按钮）：
//!   - 只有 `GET`，路由表里没有任何写接口，导入/改行/删除只存在于 Tauri 桌面端；
//!   - 只谈本地内网：按 socket 对端地址判断，私网/回环之外的直接 403，
//!     `X-Forwarded-For` 一律不信任；
//!   - 每 IP 令牌桶限速，导出有行数上限；
//!   - 所有请求记一条访问记录（保留最近 500 条）。

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::Json;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use crate::db::{self, Db};
use crate::ledger::{self, LedgerFilter};
use crate::summary;

pub const DEFAULT_PORT: u16 = 80;
pub const FALLBACK_PORT: u16 = 8080;
const EXPORT_ROW_LIMIT: i64 = 200_000;
const RATE_PER_SECOND: f64 = 30.0;

#[derive(Clone)]
pub struct WebState {
    pub db: Arc<Db>,
    pub dist: Option<PathBuf>,
    pub started_at: Instant,
    rate: Arc<Mutex<Bucket>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStatus {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub requested_port: u16,
    pub error: Option<String>,
    pub urls: Vec<String>,
    pub static_ready: bool,
    pub started_at: Option<String>,
}

pub struct WebHandle {
    pub stop: Arc<AtomicBool>,
    pub status: Arc<Mutex<WebStatus>>,
    pub port: Arc<AtomicUsize>,
}

impl WebHandle {
    pub fn snapshot(&self) -> WebStatus {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| WebStatus {
                enabled: false,
                listening: false,
                port: 0,
                requested_port: 0,
                error: Some("状态不可用".into()),
                urls: Vec::new(),
                static_ready: false,
                started_at: None,
            })
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for WebHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 本机所有私网地址，拼成给同事发的链接。
///
/// 不含回环地址（127.0.0.1 / localhost）：这一栏是发给同事的，
/// 他们那头打开 127.0.0.1 只会访问到自己电脑。本机自查走程序窗口即可。
pub fn local_urls(port: u16) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut has_private = false;
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            let ip = iface.ip();
            if !is_private(ip) {
                continue;
            }
            if ip.is_loopback() || ip.is_unspecified() {
                continue;
            }
            // 给同事发的链接只用 IPv4：Windows 上局域网共享地址基本都是 v4，
            // IPv6 链路本地/临时地址会过期，而且必须加方括号才合法。
            if let IpAddr::V4(v4) = ip {
                urls.push(format!("http://{v4}:{port}/"));
                has_private = true;
            }
        }
    }
    urls.sort();
    urls.dedup();
    // 电脑名地址排在第一个局域网 IP 前面：同事记不住 IP 时用主机名更顺手。
    // 只有真监听在局域网接口时才加，否则这条地址是连不通的。
    if has_private {
        if let Some(host) = computer_name() {
            urls.insert(0, format!("http://{}:{port}/", host.to_ascii_lowercase()));
            urls.dedup();
        }
    }
    urls
}

/// 取本机电脑名（Windows 的 COMPUTERNAME / 类 Unix 的 hostname）。
///
/// 不引第三方 crate：Windows 上直接读环境变量，其它平台调 `hostname` 命令。
/// 拿不到就返回 None，地址列表退化成纯 IP。
pub fn computer_name() -> Option<String> {
    let raw = if cfg!(windows) {
        std::env::var("COMPUTERNAME").ok()
    } else {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
    }?;
    normalize_host(&raw)
}

/// 主机名要能直接塞进 URL：去掉前后空白与结尾的点，只保留域名允许的字符。
fn normalize_host(raw: &str) -> Option<String> {
    let host = raw.trim().trim_end_matches('.').to_string();
    if host.is_empty() || host.len() > 63 {
        return None;
    }
    let ok = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if ok {
        Some(host.to_ascii_lowercase())
    } else {
        None
    }
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 唯一本地地址、fe80::/10 链路本地
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // ::ffff:a.b.c.d 形式的 IPv4 映射
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| v4.is_loopback() || v4.is_private() || v4.is_link_local())
                    .unwrap_or(false)
        }
    }
}

#[derive(Default)]
struct Bucket {
    tokens: HashMap<IpAddr, (f64, Instant)>,
}

impl Bucket {
    /// 令牌桶：容量 RATE_PER_SECOND，按真实经过的时间补充。
    /// 注意不能让“本次补充”影响“本次是否存在令牌”：先补 → 再判 → 再扣。
    fn allow(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let entry = self.tokens.entry(ip).or_insert((RATE_PER_SECOND, now));
        let elapsed = now.duration_since(entry.1).as_secs_f64();
        if elapsed > 0.0 {
            entry.0 = (entry.0 + elapsed * RATE_PER_SECOND).min(RATE_PER_SECOND);
            entry.1 = now;
        }
        if entry.0 >= 1.0 {
            entry.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

fn secure_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        ),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "只允许局域网访问" })),
    )
        .into_response()
}

fn too_many() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": "请求太频繁，稍后再试" })),
    )
        .into_response()
}


fn server_error(message: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": message }))).into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PageQuery {
    from: Option<String>,
    to: Option<String>,
    kind: Option<String>,
    owner: Option<String>,
    partner: Option<String>,
    buyer: Option<String>,
    keyword: Option<String>,
    flagged: bool,
    sort: Option<String>,
    desc: bool,
    page: Option<i64>,
    page_size: Option<i64>,
}

impl PageQuery {
    fn filter(&self) -> LedgerFilter {
        LedgerFilter {
            from: self.from.clone(),
            to: self.to.clone(),
            kind: self.kind.clone(),
            owner: self.owner.clone(),
            partner: self.partner.clone(),
            buyer: self.buyer.clone(),
            keyword: self.keyword.clone(),
            flagged: self.flagged,
            sort: self.sort.clone(),
            desc: self.desc,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SummaryQuery {
    from: Option<String>,
    to: Option<String>,
    kind: Option<String>,
    owner: Option<String>,
    partner: Option<String>,
    buyer: Option<String>,
    keyword: Option<String>,
    flagged: bool,
    group_by: Option<String>,
    kind_of_top: Option<String>,
    limit: Option<i64>,
}

impl SummaryQuery {
    fn filter(&self) -> LedgerFilter {
        LedgerFilter {
            from: self.from.clone(),
            to: self.to.clone(),
            kind: self.kind.clone(),
            owner: self.owner.clone(),
            partner: self.partner.clone(),
            buyer: self.buyer.clone(),
            keyword: self.keyword.clone(),
            flagged: self.flagged,
            sort: None,
            desc: false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct IdQuery {
    id: i64,
}

pub fn router(state: WebState) -> Router {
    let state_mw = state.clone();

    Router::new()
        .route("/api/health", get(health))
        .route("/api/ledger/page", get(page))
        .route("/api/ledger/facets", get(facets))
        .route("/api/ledger/detail", get(detail))
        .route("/api/ledger/export.csv", get(export_csv))
        .route("/api/summary", get(summary_handler))
        .route("/api/summary/monthly", get(monthly))
        .route("/api/summary/top", get(top_items))
        .route("/api/summary/compare", get(compare))
        .route("/api/stock", get(stock_handler))
        .route("/api/stock/count", get(stock_count_handler))
        .route("/api/stock/check", get(stock_check_handler))
        // 未注册的 /api 路径：明确 404，绝不回落成页面
        .route("/api/{*rest}", any(api_not_found))
        // 未知路径回落到单页入口（前端没有路由，但保留 deep-link 能力）
        .route("/", get(index_fallback))
        .route("/{*path}", get(index_fallback))
        .layer(axum::middleware::from_fn(move |req, next| {
            let state = state_mw.clone();
            async move { guard_request(state, req, next).await }
        }))
        .with_state(state)
}

/// 所有请求先过这一道：私网判定 → 令牌桶 → 记访问日志 → 补安全头。
#[allow(clippy::type_complexity)]
async fn guard_request(
    state: WebState,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let connect = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0)
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 0)));
    let path = req.uri().path().to_string();
    let ip_text = connect.ip().to_string();

    if !is_private(connect.ip()) {
        db::record_access(&state.db, &ip_text, &path, 403);
        return secure_headers(forbidden());
    }
    let allowed = state
        .rate
        .lock()
        .map(|mut bucket| bucket.allow(connect.ip()))
        .unwrap_or(true);
    if !allowed {
        db::record_access(&state.db, &ip_text, &path, 429);
        return secure_headers(too_many());
    }
    let method = req.method().clone();
    let response = next.run(req).await;
    let status = response.status().as_u16();
    // 静态资源不逐个记账，免得把访问日志刷满
    if path.starts_with("/api/") {
        db::record_access(
            &state.db,
            &ip_text,
            &format!("{} {}", method.as_str(), path),
            status,
        );
    }
    secure_headers(response)
}

async fn api_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "接口不存在（只读站不提供写入接口）" })),
    )
        .into_response()
}

async fn index_fallback(State(state): State<WebState>, uri: axum::http::Uri) -> Response {
    let Some(dir) = state.dist.as_ref() else {
        return (StatusCode::NOT_FOUND, "只读页面没有打包").into_response();
    };
    let relative = uri.path().trim_start_matches('/');
    // 只允许 dist 目录里的文件：拒绝 `..` 和绝对路径
    if relative.contains("..") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let target = if relative.is_empty() || relative.ends_with('/') {
        dir.join("index.html")
    } else {
        dir.join(relative)
    };
    if target.is_file() {
        return serve_file(&target);
    }
    let last = relative.rsplit('/').next().unwrap_or_default();
    if last.contains('.') && last != "html" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    serve_file(&dir.join("index.html"))
}

fn serve_file(path: &std::path::Path) -> Response {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let content_type = mime_guess::from_path(path)
        .first_or_octet_stream()
        .as_ref()
        .to_string();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| server_error("读取文件失败".into()))
}

async fn health(State(state): State<WebState>) -> Response {
    Json(json!({
        "ok": true,
        "schemaVersion": db::schema_version(&state.db),
        "uptimeSeconds": state.started_at.elapsed().as_secs(),
    }))
    .into_response()
}

async fn page(State(state): State<WebState>, Query(query): Query<PageQuery>) -> Response {
    match ledger::page_from(
        &state.db,
        &query.filter(),
        query.page.unwrap_or(1),
        query.page_size.unwrap_or(100),
    ) {
        Ok(page) => Json(page).into_response(),
        Err(err) => server_error(err),
    }
}

async fn facets(State(state): State<WebState>) -> Response {
    match ledger::facets_from(&state.db) {
        Ok(facets) => Json(facets).into_response(),
        Err(err) => server_error(err),
    }
}

async fn detail(State(state): State<WebState>, Query(query): Query<IdQuery>) -> Response {
    match ledger::detail_from(&state.db, query.id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "不存在" }))).into_response(),
        Err(err) => server_error(err),
    }
}

async fn export_csv(State(state): State<WebState>, Query(query): Query<PageQuery>) -> Response {
    match ledger::export_csv_from(&state.db, &query.filter(), EXPORT_ROW_LIMIT) {
        Ok((csv, _rows)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
            .header(
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"ledger.csv\"",
            )
            .body(Body::from(csv))
            .unwrap_or_else(|_| server_error("导出失败".into())),
        Err(err) => server_error(err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StockQuery {
    #[serde(default)]
    keyword: Option<String>,
    #[serde(default)]
    only_negative: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

async fn stock_handler(State(state): State<WebState>, Query(query): Query<StockQuery>) -> Response {
    match state.db.with(|c| {
        crate::stock::stock_report(
            c,
            query.keyword.as_deref(),
            query.only_negative.unwrap_or(false),
            query.limit.unwrap_or(500),
            query.offset.unwrap_or(0),
        )
        .map_err(crate::db::DbError::from)
    }) {
        Ok(rows) => Json(rows).into_response(),
        Err(err) => server_error(err),
    }
}

async fn stock_count_handler(State(state): State<WebState>, Query(query): Query<StockQuery>) -> Response {
    match state.db.with(|c| {
        crate::stock::stock_count(
            c,
            query.keyword.as_deref(),
            query.only_negative.unwrap_or(false),
        )
        .map_err(crate::db::DbError::from)
    }) {
        Ok(n) => Json(n).into_response(),
        Err(err) => server_error(err),
    }
}

async fn stock_check_handler(State(state): State<WebState>) -> Response {
    match state.db.with(|c| {
        let issues = crate::stock::check_issues(c, 300).map_err(crate::db::DbError::from)?;
        let summary = crate::stock::check_summary(c).map_err(crate::db::DbError::from)?;
        Ok(serde_json::json!({ "issues": issues, "summary": summary }))
    }) {
        Ok(body) => Json(body).into_response(),
        Err(err) => server_error(err),
    }
}

async fn summary_handler(State(state): State<WebState>, Query(query): Query<SummaryQuery>) -> Response {
    let group_by = query.group_by.clone().unwrap_or_else(|| "month".into());
    match state.db.with(|c| summary::grouped(c, &query.filter(), &group_by, 50).map_err(crate::db::DbError::from)) {
        Ok(rows) => Json(rows).into_response(),
        Err(err) => server_error(err),
    }
}

async fn monthly(State(state): State<WebState>, Query(query): Query<SummaryQuery>) -> Response {
    match state.db.with(|c| summary::monthly(c, &query.filter()).map_err(crate::db::DbError::from)) {
        Ok(points) => Json(points).into_response(),
        Err(err) => server_error(err),
    }
}

async fn top_items(State(state): State<WebState>, Query(query): Query<SummaryQuery>) -> Response {
    let kind = query.kind_of_top.clone().unwrap_or_else(|| "out".into());
    match state.db.with(|c| summary::top_items(c, &query.filter(), &kind, query.limit.unwrap_or(10)).map_err(crate::db::DbError::from)) {
        Ok(rows) => Json(rows).into_response(),
        Err(err) => server_error(err),
    }
}

async fn compare(State(state): State<WebState>, Query(query): Query<SummaryQuery>) -> Response {
    match state.db.with(|c| summary::compare_previous(c, &query.filter()).map_err(crate::db::DbError::from)) {
        Ok(Some(cmp)) => Json(cmp).into_response(),
        Ok(None) => Json(serde_json::Value::Null).into_response(),
        Err(err) => server_error(err),
    }
}

/// 启动监听。先试指定端口（默认 80），失败退到 8080，再失败就报出来。
pub fn start(db: Arc<Db>, dist: Option<PathBuf>, preferred: u16) -> WebHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let port = Arc::new(AtomicUsize::new(preferred as usize));
    let status = Arc::new(Mutex::new(WebStatus {
        enabled: true,
        listening: false,
        port: preferred,
        requested_port: preferred,
        error: None,
        urls: Vec::new(),
        static_ready: dist.is_some(),
        started_at: None,
    }));
    let handle = WebHandle {
        stop: stop.clone(),
        status: status.clone(),
        port: port.clone(),
    };

    let state = WebState {
        db,
        dist,
        started_at: Instant::now(),
        rate: Arc::new(Mutex::new(Bucket::default())),
    };

    tauri::async_runtime::spawn(async move {
        let candidates: Vec<u16> = if preferred == DEFAULT_PORT {
            vec![DEFAULT_PORT, FALLBACK_PORT]
        } else {
            vec![preferred]
        };
        let mut last_error: Option<String> = None;
        for candidate in candidates {
            let v4 = SocketAddr::from(([0, 0, 0, 0], candidate));
            let v6 = SocketAddr::from(([0u16, 0, 0, 0, 0, 0, 0, 0], candidate));
            match tokio::net::TcpListener::bind(v4).await {
                Ok(listener) => {
                    // 再绑一份 IPv6：本机 localhost 在 Windows 上常先解析到 ::1，
                    // 只绑 0.0.0.0 会让 http://localhost 直接连不上。
                    // 绑定失败不算错误（有的系统关掉了 IPv6，或端口已被 v6 独占）。
                    match tokio::net::TcpListener::bind(v6).await {
                        Ok(v6_listener) => {
                            let v6_app = router(state.clone())
                                .into_make_service_with_connect_info::<SocketAddr>();
                            let v6_stop = stop.clone();
                            tauri::async_runtime::spawn(async move {
                                let v6_shutdown = async move {
                                    loop {
                                        if v6_stop.load(Ordering::SeqCst) {
                                            break;
                                        }
                                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                                    }
                                };
                                if let Err(err) = axum::serve(v6_listener, v6_app)
                                    .with_graceful_shutdown(v6_shutdown)
                                    .await
                                {
                                    log::warn!("IPv6 监听结束: {err}");
                                }
                            });
                            log::info!("IPv6 监听已开启: [::]:{candidate}");
                        }
                        Err(err) => log::info!("IPv6 监听跳过（{err}）"),
                    }
                    port.store(candidate as usize, Ordering::SeqCst);
                    if let Ok(mut s) = status.lock() {
                        s.listening = true;
                        s.port = candidate;
                        s.error = last_error.clone();
                        s.urls = local_urls(candidate);
                        s.started_at = Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
                    }
                    log::info!("只读站已启动: {}", local_urls(candidate).join(" "));
                    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
                    let server = axum::serve(listener, app);
                    let stop_flag = stop.clone();
                    let shutdown = async move {
                        loop {
                            if stop_flag.load(Ordering::SeqCst) {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        }
                    };
                    if let Err(err) = server.with_graceful_shutdown(shutdown).await {
                        log::error!("只读站运行中断: {err}");
                        if let Ok(mut s) = status.lock() {
                            s.listening = false;
                            s.error = Some(err.to_string());
                        }
                    }
                    return;
                }
                Err(err) => {
                    log::warn!("端口 {candidate} 绑定失败: {err}");
                    last_error = Some(format!("端口 {candidate} 绑定失败: {err}"));
                }
            }
        }
        if let Ok(mut s) = status.lock() {
            s.listening = false;
            s.error = last_error;
        }
    });

    handle
}

/// 白名单/限速以外的接口层参数校验。
pub fn validate_page(page: i64, page_size: i64) -> Result<(), String> {
    if page < 1 {
        return Err("页码从 1 开始".into());
    }
    if !(1..=500).contains(&page_size) {
        return Err("每页条数 1~500".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ranges_gate() {
        assert!(is_private("127.0.0.1".parse().unwrap()));
        assert!(is_private("192.168.1.20".parse().unwrap()));
        assert!(is_private("10.0.0.8".parse().unwrap()));
        assert!(is_private("172.16.5.4".parse().unwrap()));
        assert!(is_private("169.254.3.3".parse().unwrap()));
        assert!(!is_private("8.8.8.8".parse().unwrap()));
        assert!(!is_private("203.0.113.9".parse().unwrap()));
    }

    #[test]
    fn host_name_is_url_safe() {
        assert_eq!(normalize_host("DESKTOP-QLA9K2M").as_deref(), Some("desktop-qla9k2m"));
        assert_eq!(normalize_host("  Work-PC. \n").as_deref(), Some("work-pc"));
        // 空格、斜杠、中文都不能直接进 URL，拿不到就退回纯 IP 列表
        assert_eq!(normalize_host("my pc"), None);
        assert_eq!(normalize_host("a/b"), None);
        assert_eq!(normalize_host("打印机"), None);
        assert_eq!(normalize_host(""), None);
    }

    #[test]
    fn url_list_has_no_loopback() {
        let urls = local_urls(8080);
        // 这一栏发给同事，回环地址在他们那边打开只会指向自己的电脑
        for url in &urls {
            assert!(!url.contains("127.0.0.1"), "不应出现本机回环地址: {urls:?}");
            assert!(!url.contains("localhost"), "不应出现 localhost: {urls:?}");
        }
        // 所有地址都是合法 http 链接、端口一致
        for url in &urls {
            assert!(url.starts_with("http://"), "{url}");
            assert!(url.ends_with(":8080/"), "{url}");
        }
        let mut sorted = urls.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), urls.len(), "地址不应重复: {urls:?}");
    }

    #[test]
    fn rate_limit_blocks_after_burst() {
        let mut bucket = Bucket::default();
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let mut allowed = 0;
        for _ in 0..60 {
            if bucket.allow(ip) {
                allowed += 1;
            }
        }
        assert!(allowed <= RATE_PER_SECOND as usize + 1, "allowed={allowed}");
        assert!(allowed >= 1);
        // 别的 IP 不受影响
        assert!(bucket.allow("192.168.1.10".parse().unwrap()));
    }

    #[test]
    fn bucket_drains_without_elapsed_time() {
        // 同一瞬间的连续请求必须消耗令牌；只有真实经过的时间才补回来
        let mut bucket = Bucket::default();
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let mut allowed = 0;
        for _ in 0..40 {
            if bucket.allow(ip) {
                allowed += 1;
            }
        }
        assert_eq!(allowed, RATE_PER_SECOND as usize, "40 次连打只应放过容量那么多");
        let tokens = bucket.tokens.get(&ip).unwrap().0;
        assert!(tokens < 1.0, "桶应被抽干，实际 {tokens}");
    }

    #[test]
    fn bucket_refills_over_time() {
        let mut bucket = Bucket::default();
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        // 手动把时间戳往回拨一秒，模拟“过了一秒”
        assert!(bucket.allow(ip));
        if let Some(entry) = bucket.tokens.get_mut(&ip) {
            entry.0 = 0.0;
            entry.1 -= std::time::Duration::from_secs(1);
        }
        assert!(bucket.allow(ip));
    }

    #[test]
    fn page_bounds() {
        assert!(validate_page(1, 100).is_ok());
        assert!(validate_page(0, 100).is_err());
        assert!(validate_page(1, 0).is_err());
        assert!(validate_page(1, 501).is_err());
    }
}

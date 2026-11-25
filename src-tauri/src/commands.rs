//! Tauri 命令：桌面端是唯一能写数据的地方（导入、改行、删除）。
//!
//! 统一约定：所有命令返回 `Result<T, String>`，错误是给用户看的中文短句；
//! 前端只发意图，路径与参数在这里再校验一遍。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{self, Db};
use crate::dict;
use crate::import::{self, SheetPlan};
use crate::ledger::{self, LedgerFilter, LedgerPatch};
use crate::master;
use crate::paths;
use crate::stock;
use crate::summary;
use crate::voucher;
use crate::web::{self, WebHandle, WebStatus};

pub struct AppState {
    pub db: Arc<Db>,
    pub dev_root: Option<PathBuf>,
    pub resource_dir: Option<PathBuf>,
    pub web: std::sync::Mutex<Option<WebHandle>>,
    pub last_import: std::sync::Mutex<Option<import::ImportOutcome>>,
}

impl AppState {
    pub fn new(db: Arc<Db>, dev_root: Option<PathBuf>, resource_dir: Option<PathBuf>) -> Self {
        AppState {
            db,
            dev_root,
            resource_dir,
            web: std::sync::Mutex::new(None),
            last_import: std::sync::Mutex::new(None),
        }
    }
}

fn empty_facets() -> crate::ledger::Facets {
    crate::ledger::Facets {
        owners: Vec::new(),
        partners: Vec::new(),
        buyers: Vec::new(),
        min_date: None,
        max_date: None,
        item_count: 0,
        in_rows: 0,
        out_rows: 0,
    }
}

fn require_file(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("没有选择文件".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_file() {
        return Err(format!("文件不存在: {}", p.display()));
    }
    if !paths::is_excel(&p) {
        return Err("只支持 .xlsm / .xlsx 文件".into());
    }
    Ok(p)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub app_version: String,
    pub schema_version: i64,
    pub db_path: String,
    pub row_count: i64,
    pub import_count: i64,
    pub min_date: Option<String>,
    pub max_date: Option<String>,
    pub in_rows: i64,
    pub out_rows: i64,
    pub web: WebStatus,
    pub startup_import: Option<import::ImportOutcome>,
    pub last_error: Option<String>,
    pub sample_workbooks: Vec<String>,
}

#[tauri::command]
pub fn bootstrap(state: State<'_, Arc<AppState>>) -> Result<BootstrapInfo, String> {
    let db = &state.db;
    let facets = ledger::facets_from(db).unwrap_or_else(|_| empty_facets());
    let import_count = import::history(db).map(|rows| rows.len() as i64).unwrap_or(0);
    let web_status = state
        .web
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|h| h.snapshot()))
        .unwrap_or(WebStatus {
            enabled: false,
            listening: false,
            port: 0,
            requested_port: 0,
            error: None,
            urls: Vec::new(),
            static_ready: false,
            started_at: None,
        });
    let startup = state.last_import.lock().ok().and_then(|g| g.clone());
    Ok(BootstrapInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: db::schema_version(db),
        db_path: db.path.display().to_string(),
        row_count: ledger::count(db).unwrap_or(0),
        import_count,
        min_date: facets.min_date,
        max_date: facets.max_date,
        in_rows: facets.in_rows,
        out_rows: facets.out_rows,
        web: web_status,
        startup_import: startup,
        last_error: None,
        sample_workbooks: paths::sample_workbooks(state.dev_root.as_deref())
            .into_iter()
            .map(|p| p.display().to_string())
            .collect(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    #[serde(default)]
    pub filter: LedgerFilter,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub skip_totals: Option<bool>,
}

#[tauri::command]
pub fn ledger_page(state: State<'_, Arc<AppState>>, args: QueryArgs) -> Result<ledger::LedgerPage, String> {
    let page = args.page.unwrap_or(1);
    let size = args.page_size.unwrap_or(100);
    web::validate_page(page, size)?;
    ledger::page_from_opt(&state.db, &args.filter, page, size, args.skip_totals.unwrap_or(false))
}

#[tauri::command]
pub fn ledger_facets(state: State<'_, Arc<AppState>>) -> Result<ledger::Facets, String> {
    ledger::facets_from(&state.db)
}

#[tauri::command]
pub fn ledger_detail(state: State<'_, Arc<AppState>>, id: i64) -> Result<Option<ledger::LedgerRow>, String> {
    ledger::detail_from(&state.db, id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub id: i64,
    pub patch: serde_json::Value,
}

/// 解析前端传来的 JSON patch 再写库。
///
/// 抽成自由函数是为了能直接测：Tauri 的 `State` 在单测里不好构造，而
/// 「前端发来一坨 JSON，哪些字段被接受、哪个拼错就报错」正是最容易出问题
/// 的地方——字段名写错时 serde 默认会当成没传，静默什么都不改，用户点了保存
/// 却看不到变化。
pub(crate) fn apply_ledger_patch(db: &Db, id: i64, patch: serde_json::Value) -> Result<(), String> {
    let patch: LedgerPatch = serde_json::from_value(patch).map_err(|e| format!("字段格式不对: {e}"))?;
    db.with(|c| ledger::update(c, id, &patch).map_err(db::DbError::from))
}

#[tauri::command]
pub fn ledger_update(state: State<'_, Arc<AppState>>, args: UpdateArgs) -> Result<(), String> {
    apply_ledger_patch(&state.db, args.id, args.patch)
}

#[tauri::command]
pub fn ledger_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    state.db.with(|c| ledger::delete(c, id).map_err(db::DbError::from))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: i64,
}

#[tauri::command]
pub fn ledger_export(state: State<'_, Arc<AppState>>, args: QueryArgs, path: &str) -> Result<ExportResult, String> {
    let (csv, rows) = ledger::export_csv_from(&state.db, &args.filter, 500_000)?;
    write_csv(path, csv, rows)
}

/// 把 CSV 文本写到用户选定的路径，返回给前端提示用的路径与行数。
///
/// 台账导出与基础资料导出共用：目录不存在时先建，空路径直接拒绝。
fn write_csv(path: &str, csv: String, rows: i64) -> Result<ExportResult, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("没有选择保存位置".into());
    }
    if let Some(dir) = target.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&target, csv).map_err(|e| format!("写文件失败: {e}"))?;
    Ok(ExportResult {
        path: target.display().to_string(),
        rows,
    })
}

/// 基础资料 · 物料导出。筛选条件与列表页一致，`limit` 不传即导出全部命中行。
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemExportArgs {
    pub keyword: Option<String>,
    pub category: Option<String>,
    pub item_type: Option<String>,
    pub only_active: bool,
    /// 图号筛选：有图号 / 缺图号 / 不筛
    pub with_drawing: Option<bool>,
    /// 排序键，与列表页同一个枚举
    pub order: Option<String>,
}

#[tauri::command]
pub fn master_items_export(
    state: State<'_, Arc<AppState>>,
    args: ItemExportArgs,
    path: &str,
) -> Result<ExportResult, String> {
    let (csv, rows) = master::export_items_db(
        &state.db,
        args.keyword.as_deref(),
        args.category.as_deref(),
        args.item_type.as_deref(),
        args.only_active,
        args.with_drawing,
        master::ItemOrder::parse(args.order.as_deref()),
    )?;
    write_csv(path, csv, rows)
}

/// 基础资料 · 供应商导出。
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SupplierExportArgs {
    pub keyword: Option<String>,
}

#[tauri::command]
pub fn master_suppliers_export(
    state: State<'_, Arc<AppState>>,
    args: SupplierExportArgs,
    path: &str,
) -> Result<ExportResult, String> {
    let (csv, rows) = master::export_suppliers_db(&state.db, args.keyword.as_deref())?;
    write_csv(path, csv, rows)
}

/// 基础资料 · 字典导出（按当前类别 + 关键字 + 只看在用）。
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DictExportArgs {
    pub kind: String,
    pub keyword: Option<String>,
    pub only_active: bool,
}

#[tauri::command]
pub fn master_dict_export(
    state: State<'_, Arc<AppState>>,
    args: DictExportArgs,
    path: &str,
) -> Result<ExportResult, String> {
    let (csv, rows) = dict::export_db(&state.db, &args.kind, args.keyword.as_deref(), args.only_active)?;
    write_csv(path, csv, rows)
}

#[tauri::command]
pub fn import_inspect(path: String) -> Result<import::WorkbookReport, String> {
    let file = require_file(&path)?;
    import::inspect(&file)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewArgs {
    pub path: String,
    #[serde(default)]
    pub plans: Option<Vec<SheetPlan>>,
    #[serde(default)]
    pub sample_limit: Option<usize>,
    /// 月度进销存宽表所属年份。源表只有「1月…12月」，没有年份。
    #[serde(default)]
    pub year: Option<i32>,
}

#[tauri::command]
pub fn import_preview(args: PreviewArgs) -> Result<import::PreviewResult, String> {
    let file = require_file(&args.path)?;
    let year = args.year.unwrap_or_else(import::current_year);
    import::preview_with_year(&file, args.plans, args.sample_limit.unwrap_or(8).clamp(1, 50), year)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    pub path: String,
    #[serde(default)]
    pub plans: Option<Vec<SheetPlan>>,
    /// 覆盖同名 sheet 的旧数据
    #[serde(default)]
    pub replace: bool,
    /// 顺带把工作簿里的供应商 / 物料编号 / 基础信息写进基础资料
    #[serde(default = "default_true")]
    pub master: bool,
    /// 月度进销存宽表所属年份
    #[serde(default)]
    pub year: Option<i32>,
    /// 明确允许重复导入同一个文件（前端二次确认后才置 true）
    #[serde(default)]
    pub allow_duplicate: bool,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn import_run(state: State<'_, Arc<AppState>>, args: RunArgs) -> Result<import::ImportOutcome, String> {
    let file = require_file(&args.path)?;
    let year = args.year.unwrap_or_else(import::current_year);
    let mut outcome = import::run_with_options(&state.db, &file, args.plans, args.replace, year, args.allow_duplicate)?;
    // 宽表在 run_with_year 内部已顺带写好基础资料并填入 outcome.master；
    // 仅当常规明细工作簿尚未写入基础资料且开启了 master 选项时，才单独扫主数据表。
    if args.master && outcome.master.is_none() {
        match master::import_workbook_db(&state.db, &file) {
            Ok(ms) => {
                log::info!("主数据导入: {}", ms.message);
                outcome.master = Some(ms);
            }
            Err(err) => {
                log::warn!("主数据导入失败: {err}");
                outcome.master_error = Some(err);
            }
        }
    }
    // 导入完就不再需要缓存的整本工作簿（含所有 sheet 的解压 Range），
    // 主动释放，避免托盘常驻时内存只增不减。
    import::release_workbook_cache();
    if let Ok(mut slot) = state.last_import.lock() {
        *slot = Some(outcome.clone());
    }
    Ok(outcome)
}

#[tauri::command]
pub fn import_history(state: State<'_, Arc<AppState>>) -> Result<Vec<import::ImportRecord>, String> {
    import::history(&state.db)
}

#[tauri::command]
pub fn import_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<usize, String> {
    import::delete_import(&state.db, id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryArgs {
    #[serde(default)]
    pub filter: LedgerFilter,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryBundle {
    pub totals: ledger::LedgerTotals,
    pub monthly: Vec<summary::MonthPoint>,
    pub by_owner: Vec<summary::GroupRow>,
    pub by_partner: Vec<summary::GroupRow>,
    pub top_out: Vec<summary::TopItem>,
    pub top_in: Vec<summary::TopItem>,
    pub compare: Option<summary::PeriodCompare>,
}

#[tauri::command]
pub fn summary_bundle(state: State<'_, Arc<AppState>>, args: SummaryArgs) -> Result<SummaryBundle, String> {
    let db = &state.db;
    let filter = args.filter;
    let totals = state
        .db
        .with(|c| ledger::totals(c, &filter).map_err(db::DbError::from))?;
    Ok(SummaryBundle {
        totals,
        monthly: summary::monthly_from(db, &filter)?,
        by_owner: summary::grouped_from(db, &filter, "owner", args.limit.unwrap_or(12))?,
        by_partner: summary::grouped_from(db, &filter, "partner", args.limit.unwrap_or(12))?,
        top_out: summary::top_items_from(db, &filter, "out", args.limit.unwrap_or(10))?,
        top_in: summary::top_items_from(db, &filter, "in", args.limit.unwrap_or(10))?,
        compare: summary::compare_from(db, &filter)?,
    })
}

#[tauri::command]
pub fn summary_group(state: State<'_, Arc<AppState>>, args: SummaryArgs) -> Result<Vec<summary::GroupRow>, String> {
    let group_by = args.group_by.unwrap_or_else(|| "month".into());
    summary::grouped_from(&state.db, &args.filter, &group_by, args.limit.unwrap_or(50))
}

#[tauri::command]
pub fn web_status(state: State<'_, Arc<AppState>>) -> Result<WebStatus, String> {
    let guard = state.web.lock().map_err(|_| "状态不可用".to_string())?;
    match guard.as_ref() {
        Some(handle) => Ok(handle.snapshot()),
        None => Ok(WebStatus {
            enabled: false,
            listening: false,
            port: 0,
            requested_port: web::DEFAULT_PORT,
            error: None,
            urls: Vec::new(),
            static_ready: false,
            started_at: None,
        }),
    }
}

#[tauri::command]
pub fn web_start(state: State<'_, Arc<AppState>>) -> Result<WebStatus, String> {
    let mut guard = state.web.lock().map_err(|_| "状态不可用".to_string())?;
    if let Some(handle) = guard.as_ref() {
        let snap = handle.snapshot();
        if snap.listening {
            return Ok(snap);
        }
    }
    if let Some(old) = guard.take() {
        old.shutdown_and_wait(std::time::Duration::from_secs(2));
    }
    let dist = paths::remote_dist(state.resource_dir.as_deref(), remote_dev_dir().as_deref());
    let handle = web::start(state.db.clone(), dist, web::DEFAULT_PORT);
    let snapshot = handle.wait_ready(std::time::Duration::from_secs(3));
    *guard = Some(handle);
    Ok(snapshot)
}

#[tauri::command]
pub fn web_stop(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(handle) = state.web.lock().map_err(|_| "状态不可用".to_string())?.take() {
        handle.shutdown_and_wait(std::time::Duration::from_secs(2));
    }
    Ok(())
}

#[tauri::command]
pub fn web_access_log(state: State<'_, Arc<AppState>>, limit: Option<i64>) -> Result<Vec<db::AccessEntry>, String> {
    db::recent_access(&state.db, limit.unwrap_or(100))
}

#[tauri::command]
pub fn local_addresses() -> Vec<String> {
    web::local_urls(web::DEFAULT_PORT)
}

/// 当前 exe 路径：开机自启项要指向它。
pub(crate) fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("取不到程序路径：{e}"))
}

#[tauri::command]
pub fn autostart_status() -> Result<bool, String> {
    Ok(crate::autostart::is_enabled(&current_exe()?))
}

#[tauri::command]
pub fn autostart_set(state: State<'_, Arc<AppState>>, enabled: bool) -> Result<bool, String> {
    let exe = current_exe()?;
    crate::autostart::set_enabled(&exe, enabled)?;
    // 记录用户是否显式关闭开机自启
    let _ = crate::db::set_setting(&state.db, "autostart_disabled", if enabled { "0" } else { "1" });
    // 读回真实状态：写注册表可能被组策略拦下，以磁盘上的结果为准
    Ok(crate::autostart::is_enabled(&exe))
}

/// 把主窗口从托盘里叫回来（前端调用入口，逻辑与单实例唤醒共用）。
#[tauri::command]
pub fn window_show(app: tauri::AppHandle) -> Result<(), String> {
    // 窗口不存在时给前端明确的错误，便于提示而不是静默失败
    if crate::bring_main_window_to_front(&app) {
        Ok(())
    } else {
        Err("主窗口不存在".into())
    }
}

#[tauri::command]
pub fn client_log(level: Option<String>, message: String) {
    match level.as_deref() {
        Some("error") => log::error!("[webview] {message}"),
        Some("warn") => log::warn!("[webview] {message}"),
        _ => log::info!("[webview] {message}"),
    }
}

/// 开发时 `dist-remote` 在仓库根目录；打包后由资源目录提供。
fn remote_dev_dir() -> Option<PathBuf> {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist-remote");
    if candidate.join("index.html").is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// 首启自动导入：库是空的、未手动清空过、且能找到示例工作簿时跑一次。
pub fn auto_import(state: &AppState) -> Option<import::ImportOutcome> {
    if db::get_setting(&state.db, "manual_clear").as_deref() == Some("1") {
        return None;
    }
    if ledger::count(&state.db).unwrap_or(1) > 0 {
        return None;
    }
    let files = paths::sample_workbooks(state.dev_root.as_deref());
    for file in files {
        match import::run(&state.db, &file, None, true) {
            Ok(outcome) => {
                log::info!("首启自动导入 {} 行：{}", outcome.rows, file.display());
                return Some(outcome);
            }
            Err(err) => log::warn!("自动导入 {} 失败: {err}", file.display()),
        }
    }
    None
}

// ---------- 开单 ----------

#[tauri::command]
pub fn voucher_create(state: State<'_, Arc<AppState>>, args: voucher::VoucherInput) -> Result<i64, String> {
    voucher::create_db(&state.db, &args)
}

#[tauri::command]
pub fn voucher_update(state: State<'_, Arc<AppState>>, id: i64, args: voucher::VoucherInput) -> Result<(), String> {
    voucher::update_db(&state.db, id, &args)
}

#[tauri::command]
pub fn voucher_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<usize, String> {
    voucher::delete_db(&state.db, id)
}

#[tauri::command]
pub fn voucher_get(state: State<'_, Arc<AppState>>, id: i64) -> Result<Option<voucher::Voucher>, String> {
    voucher::get_db(&state.db, id)
}

#[tauri::command]
pub fn voucher_list(
    state: State<'_, Arc<AppState>>,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<voucher::VoucherSummary>, String> {
    voucher::list_db(&state.db, kind.as_deref(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn voucher_next_no(state: State<'_, Arc<AppState>>, kind: String, date: String) -> Result<String, String> {
    voucher::next_doc_no_db(&state.db, &kind, &date)
}

/// 物料快速输入候选。`inbound_only` 为真时只统计已入库的物料，
/// 开单页的「物料编码」就是要引用真正入库过的数据。
#[tauri::command]
pub fn item_master(
    state: State<'_, Arc<AppState>>,
    keyword: Option<String>,
    limit: Option<i64>,
    inbound_only: Option<bool>,
    in_stock_only: Option<bool>,
) -> Result<Vec<voucher::ItemMaster>, String> {
    voucher::item_master_db(
        &state.db,
        keyword.as_deref(),
        limit.unwrap_or(200),
        inbound_only.unwrap_or(false),
        in_stock_only.unwrap_or(false),
    )
}

// ---------- 库存 ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockArgs {
    #[serde(default)]
    pub keyword: Option<String>,
    /// 只看负库存
    #[serde(default)]
    pub only_negative: bool,
    #[serde(default = "default_stock_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_stock_limit() -> i64 {
    500
}

#[tauri::command]
pub fn stock_report(state: State<'_, Arc<AppState>>, args: StockArgs) -> Result<Vec<stock::StockRow>, String> {
    stock::stock_report_db(
        &state.db,
        args.keyword.as_deref(),
        args.only_negative,
        args.limit,
        args.offset,
    )
}

#[tauri::command]
pub fn stock_count(
    state: State<'_, Arc<AppState>>,
    keyword: Option<String>,
    only_negative: Option<bool>,
) -> Result<i64, String> {
    stock::stock_count_db(&state.db, keyword.as_deref(), only_negative.unwrap_or(false))
}

#[tauri::command]
pub fn stock_check(state: State<'_, Arc<AppState>>, limit: Option<i64>) -> Result<Vec<stock::IssueRow>, String> {
    stock::check_issues_db(&state.db, limit.unwrap_or(300))
}

#[tauri::command]
pub fn stock_check_summary(state: State<'_, Arc<AppState>>) -> Result<stock::CheckSummary, String> {
    stock::check_summary_db(&state.db)
}

// ---------- 批量 ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdateArgs {
    pub ids: Vec<i64>,
    pub patch: ledger::BulkPatch,
}

#[tauri::command]
pub fn ledger_bulk_update(state: State<'_, Arc<AppState>>, args: BulkUpdateArgs) -> Result<usize, String> {
    ledger::bulk_update_db(&state.db, &args.ids, &args.patch)
}

#[tauri::command]
pub fn ledger_bulk_delete(state: State<'_, Arc<AppState>>, ids: Vec<i64>) -> Result<usize, String> {
    ledger::bulk_delete_db(&state.db, &ids)
}

// ---------- 基础资料 ----------

#[tauri::command]
pub fn items_list(
    state: State<'_, Arc<AppState>>,
    keyword: Option<String>,
    category: Option<String>,
    item_type: Option<String>,
    only_active: Option<bool>,
    with_drawing: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    // true 时按建档时间倒序（最新在前），新增物料的候选清单用
    recent: Option<bool>,
    // 排序键：code（默认）/ newest / oldest / name / code_desc
    order: Option<String>,
) -> Result<Vec<master::Item>, String> {
    master::list_items_db(
        &state.db,
        keyword.as_deref(),
        category.as_deref(),
        item_type.as_deref(),
        only_active.unwrap_or(false),
        with_drawing,
        limit.unwrap_or(200),
        offset.unwrap_or(0),
        recent.unwrap_or(false),
        master::ItemOrder::parse(order.as_deref()),
    )
}

#[tauri::command]
pub fn items_count(
    state: State<'_, Arc<AppState>>,
    keyword: Option<String>,
    category: Option<String>,
    item_type: Option<String>,
    only_active: Option<bool>,
    with_drawing: Option<bool>,
) -> Result<i64, String> {
    master::count_items_db(
        &state.db,
        keyword.as_deref(),
        category.as_deref(),
        item_type.as_deref(),
        only_active.unwrap_or(false),
        with_drawing,
    )
}

#[tauri::command]
pub fn item_create(state: State<'_, Arc<AppState>>, args: master::ItemInput) -> Result<i64, String> {
    master::create_item_db(&state.db, &args)
}

#[tauri::command]
pub fn item_update(state: State<'_, Arc<AppState>>, id: i64, args: master::ItemInput) -> Result<(), String> {
    master::update_item_db(&state.db, id, &args)
}

#[tauri::command]
pub fn item_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    master::delete_item_db(&state.db, id)
}

#[tauri::command]
pub fn item_lookup(state: State<'_, Arc<AppState>>, code: String) -> Result<Option<master::Item>, String> {
    master::find_item_db(&state.db, &code)
}

// ---------- 字典（单位 / 类别 / 类型 / 出库部门 / 采购人） ----------

#[tauri::command]
pub fn dict_list(
    state: State<'_, Arc<AppState>>,
    kind: String,
    keyword: Option<String>,
    only_active: Option<bool>,
) -> Result<Vec<dict::DictEntry>, String> {
    dict::list_db(&state.db, &kind, keyword.as_deref(), only_active.unwrap_or(false))
}

#[tauri::command]
pub fn dict_counts(state: State<'_, Arc<AppState>>) -> Result<Vec<dict::DictKindCount>, String> {
    dict::kind_counts_db(&state.db)
}

#[tauri::command]
pub fn dict_create(state: State<'_, Arc<AppState>>, args: dict::DictInput) -> Result<i64, String> {
    dict::create_db(&state.db, &args)
}

/// 改字典值会同步改写用到它的台账/物料行，返回受影响行数。
#[tauri::command]
pub fn dict_update(state: State<'_, Arc<AppState>>, id: i64, args: dict::DictInput) -> Result<usize, String> {
    dict::update_db(&state.db, id, &args)
}

#[tauri::command]
pub fn dict_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    dict::delete_db(&state.db, id)
}

/// 从现有物料与台账重新扫一遍，把还没进字典的值补上。
#[tauri::command]
pub fn dict_sync(state: State<'_, Arc<AppState>>) -> Result<usize, String> {
    dict::sync_db(&state.db)
}

#[tauri::command]
pub fn suppliers_list(
    state: State<'_, Arc<AppState>>,
    keyword: Option<String>,
) -> Result<Vec<master::Supplier>, String> {
    master::list_suppliers_db(&state.db, keyword.as_deref())
}

#[tauri::command]
pub fn supplier_create(state: State<'_, Arc<AppState>>, args: master::SupplierInput) -> Result<i64, String> {
    master::create_supplier_db(&state.db, &args)
}

#[tauri::command]
pub fn supplier_update(state: State<'_, Arc<AppState>>, id: i64, args: master::SupplierInput) -> Result<(), String> {
    master::update_supplier_db(&state.db, id, &args)
}

#[tauri::command]
pub fn supplier_delete(state: State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    master::delete_supplier_db(&state.db, id)
}

#[tauri::command]
pub fn master_stats(state: State<'_, Arc<AppState>>) -> Result<master::MasterStats, String> {
    master::stats_db(&state.db)
}

#[tauri::command]
pub fn master_import_workbook(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<master::MasterImportOutcome, String> {
    let file = require_file(&path)?;
    master::import_workbook_db(&state.db, &file)
}

/// 把台账里出现但主数据缺的物料/供应商补进去。
#[tauri::command]
pub fn master_backfill(state: State<'_, Arc<AppState>>) -> Result<(usize, usize), String> {
    master::backfill_db(&state.db)
}

/// 首启把工作簿里的「物料编号」「供应商名称」导进主数据，再从台账补漏。
/// 只在主数据为空且未手动清空过时跑，避免覆盖用户后来的维护。
pub fn seed_master_data(state: &AppState) {
    if db::get_setting(&state.db, "manual_clear").as_deref() == Some("1") {
        return;
    }
    let existing = master::stats_db(&state.db).map(|s| s.items + s.suppliers).unwrap_or(1);
    if existing > 0 {
        return;
    }
    let files = paths::sample_workbooks(state.dev_root.as_deref());
    for file in files {
        match master::import_workbook_db(&state.db, &file) {
            Ok(outcome) => {
                log::info!("主数据导入: {}", outcome.message);
                break;
            }
            Err(err) => log::warn!("主数据导入 {} 失败: {err}", file.display()),
        }
    }
    match master::backfill_db(&state.db) {
        Ok((items, suppliers)) => log::info!("主数据补漏: 物料 +{items}，供应商 +{suppliers}"),
        Err(err) => log::warn!("主数据补漏失败: {err}"),
    }
}

#[tauri::command]
pub fn data_clear(state: State<'_, Arc<AppState>>, include_master: Option<bool>) -> Result<db::ClearOutcome, String> {
    let outcome = db::clear_data(&state.db, include_master.unwrap_or(false))?;
    if let Ok(mut slot) = state.last_import.lock() {
        *slot = None;
    }
    Ok(outcome)
}

// ---------- 单据查询 ----------

#[tauri::command]
pub fn doc_search(
    state: State<'_, Arc<AppState>>,
    keyword: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<voucher::DocHit>, String> {
    voucher::search_docs_db(&state.db, &keyword, kind.as_deref(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn doc_lines(
    state: State<'_, Arc<AppState>>,
    doc_no: String,
    kind: String,
) -> Result<Vec<ledger::LedgerRow>, String> {
    voucher::import_doc_lines_db(&state.db, &doc_no, &kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn seed_row(db: &Db) -> i64 {
        db.with(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, doc_date, doc_no, item_code, item_name, unit, qty, price_micros, amount_cents, owner, flags)
                 VALUES ('手工', 1, 'out', '2025-03-01', '20250301001', 'WG-A', '螺丝', '个', 4, 1500000, 600, '乾力车间', '')",
                [],
            )
            .map_err(db::DbError::from)?;
            Ok(c.last_insert_rowid())
        })
        .unwrap()
    }

    // ---- JSON patch 解析 ----
    //
    // 前端发的是 `{ qty: 4, priceMicros: 1500 }` 这种裸 JSON，字段名写错时
    // serde 的默认行为是「当成没传」，保存按钮点了却没变化且不报错。

    #[test]
    fn patch_applies_known_fields() {
        let db = db();
        let id = seed_row(&db);
        apply_ledger_patch(&db, id, json!({ "qty": 12.0, "remark": "改过" })).unwrap();
        let (qty, remark): (f64, Option<String>) = db
            .with(|c| {
                c.query_row("SELECT qty, remark FROM ledger WHERE id = ?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(db::DbError::from)
            })
            .unwrap();
        assert_eq!(qty, 12.0);
        assert_eq!(remark.as_deref(), Some("改过"));
    }

    #[test]
    fn patch_rejects_wrong_type_with_a_chinese_hint() {
        let db = db();
        let id = seed_row(&db);
        let err = apply_ledger_patch(&db, id, json!({ "qty": "四个" })).unwrap_err();
        assert!(err.contains("字段格式不对"), "{err}");
        // 报错时不能已经把库改了一半
        let qty: f64 = db
            .with(|c| {
                c.query_row("SELECT qty FROM ledger WHERE id = ?1", [id], |r| r.get(0))
                    .map_err(db::DbError::from)
            })
            .unwrap();
        assert_eq!(qty, 4.0);
    }

    #[test]
    fn patch_on_missing_row_is_an_error() {
        let db = db();
        // 行被别人删掉后再点保存，必须报错而不是静默成功
        assert!(apply_ledger_patch(&db, 99999, json!({ "qty": 1.0 })).is_err());
    }

    #[test]
    fn patch_empty_json_changes_nothing() {
        let db = db();
        let id = seed_row(&db);
        apply_ledger_patch(&db, id, json!({})).unwrap();
        let qty: f64 = db
            .with(|c| {
                c.query_row("SELECT qty FROM ledger WHERE id = ?1", [id], |r| r.get(0))
                    .map_err(db::DbError::from)
            })
            .unwrap();
        assert_eq!(qty, 4.0);
    }

    // ---- 导入前的入参校验 ----

    #[test]
    fn require_file_rejects_empty_missing_and_wrong_extension() {
        assert!(require_file("   ").unwrap_err().contains("没有选择文件"));
        assert!(require_file("Z:/definitely/not/here.xlsx")
            .unwrap_err()
            .contains("文件不存在"));
        // 存在的非 Excel 文件也不能放进来，否则 calamine 到后面才报错
        let tmp = std::env::temp_dir().join("ledger-require-file-test.txt");
        std::fs::write(&tmp, "x").unwrap();
        let err = require_file(&tmp.display().to_string()).unwrap_err();
        assert!(err.contains(".xlsm"), "{err}");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn write_csv_creates_parent_dirs_and_reports_rows() {
        let dir = std::env::temp_dir().join("ledger-write-csv-test/nested");
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("ledger-write-csv-test"));
        let target = dir.join("out.csv");
        let saved = write_csv(&target.display().to_string(), "a,b\n1,2\n".into(), 1).unwrap();
        assert_eq!(saved.rows, 1);
        assert!(target.is_file());
        assert!(write_csv("   ", String::new(), 0)
            .unwrap_err()
            .contains("没有选择保存位置"));
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("ledger-write-csv-test"));
    }

    // ---- 前端参数反序列化 ----

    #[test]
    fn query_args_accept_camel_case_and_default() {
        let args: QueryArgs = serde_json::from_value(json!({
            "filter": { "from": "2025-01-01", "keyword": "螺丝" },
            "page": 2,
            "pageSize": 50,
            "skipTotals": true
        }))
        .unwrap();
        assert_eq!(args.page, Some(2));
        assert_eq!(args.page_size, Some(50));
        assert_eq!(args.skip_totals, Some(true));
        assert_eq!(args.filter.keyword.as_deref(), Some("螺丝"));
        // 什么都不传也要能反序列化（默认第 1 页、每页 100）
        let args: QueryArgs = serde_json::from_value(json!({})).unwrap();
        assert_eq!(args.page, None);
        assert_eq!(args.page_size, None);
    }

    #[test]
    fn ledger_page_bounds_are_enforced_before_query() {
        // 命令层直接挡掉非法分页，避免把 0 或超大 pageSize 传进 SQL
        assert!(web::validate_page(0, 100).is_err());
        assert!(web::validate_page(1, 0).is_err());
        assert!(web::validate_page(1, 5001).is_err());
        assert!(web::validate_page(1, 100).is_ok());
    }
}

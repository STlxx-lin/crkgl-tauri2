//! xlsm 导入：先看（inspect）→ 预览（preview）→ 落库（run）。
//!
//! 按实测的 `仓库出入库明细_5611_Modified.xlsm` 对齐：
//!
//! - `入库明细` 首行表头：入库时间/单据编号/送货单号/物料编码/物料名称/单位/数量/单价/合计/备注/供应商名称/采购人
//! - `出库明细` 首行表头：日期/出库单号/物料编码/物料名称/单位/数量/备注/归属/领用人/采购人
//!
//! 同一个文件里可以有多张明细表：sheet 名不同但表头能对上就一起导入。
//!
//! 只读源文件。公式单元格取 Excel 缓存值；没有缓存就当空处理并打提醒。

use std::collections::BTreeMap;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{Db, DbError};
use crate::ledger::normalize_date;

/// 标准字段。顺序就是界面上映射下拉的顺序。
pub const FIELDS: &[&str] = &[
    "doc_date",
    "doc_no",
    "delivery_no",
    "item_code",
    "item_name",
    "spec",
    "unit",
    "qty",
    "price",
    "amount",
    "remark",
    "partner",
    "buyer",
    "owner",
    "receiver",
];

pub fn field_label(field: &str) -> &'static str {
    match field {
        "doc_date" => "日期",
        "doc_no" => "单据编号",
        "delivery_no" => "送货单号",
        "item_code" => "物料编码",
        "item_name" => "物料名称",
        "spec" => "规格型号",
        "unit" => "单位",
        "qty" => "数量",
        "price" => "单价",
        "amount" => "合计金额",
        "remark" => "备注",
        "partner" => "供应商",
        "buyer" => "采购人",
        "owner" => "归属",
        "receiver" => "领用人",
        _ => "未使用",
    }
}

/// 内置表头别名：精确匹配优先，再做去空白/去括号的二次比较。
const ALIASES: &[(&str, &[&str])] = &[
    (
        "doc_date",
        &[
            "入库时间",
            "日期",
            "入库日期",
            "出库时间",
            "出库日期",
            "发生日期",
            "单据日期",
        ],
    ),
    (
        "doc_no",
        &["单据编号", "入库单号", "出库单号", "单据号", "单号", "入库单", "出库单"],
    ),
    ("delivery_no", &["送货单号", "送货单", "验收单号"]),
    ("item_code", &["物料编码", "编码", "物料编号", "物料编码序号", "图号"]),
    ("item_name", &["物料名称", "名称", "品名", "物料"]),
    ("spec", &["规格型号", "规格", "型号"]),
    ("unit", &["单位", "计量单位"]),
    ("qty", &["数量", "入库数量", "出库数量"]),
    ("price", &["单价", "进货单价", "进货价", "价格"]),
    ("amount", &["合计", "金额", "总价", "合计金额", "金额合计"]),
    ("remark", &["备注", "说明"]),
    ("partner", &["供应商名称", "供应商", "供货商"]),
    ("buyer", &["采购人", "采购员", "采购"]),
    ("owner", &["归属", "归属部门", "使用部门", "领用部门", "车间"]),
    ("receiver", &["领用人", "领用", "领取人"]),
];

/// 明细表必须带日期 + 数量 + 物料，否则当成别的工作表跳过。
pub fn looks_like_detail(headers: &[(String, String)]) -> bool {
    let has_date = headers.iter().any(|(_, f)| *f == "doc_date");
    let has_qty = headers.iter().any(|(_, f)| *f == "qty");
    let has_name = headers.iter().any(|(_, f)| *f == "item_name" || *f == "item_code");
    has_date && has_qty && has_name
}

/// 认主数据表：返回给用户看的类别名。
///
/// 判定要与 `master::import_from_workbook` 一致，否则向导说「会导入」后端却跳过。
/// 关键区别是流水表：它们同样带「物料名称 / 物料编码」，但一定有送货单号、
/// 入库/出库时间、领用人这类只属于单据的列，见到任何一列就当流水。
pub fn master_sheet_kind(name: &str, headers: &[HeaderGuess]) -> Option<&'static str> {
    if ["明细", "库存", "单据"].iter().any(|k| name.contains(k)) {
        return None;
    }
    let has = |keyword: &str| {
        headers
            .iter()
            .any(|h| !h.header.is_empty() && h.header.trim().contains(keyword))
    };
    if ["送货单号", "入库时间", "出库时间", "领用人", "采购人", "单号"]
        .iter()
        .any(|k| has(k))
    {
        return None;
    }
    // 物料列判定要排除「供应商名称」：这一列里也含「名称」两个字
    let has_item_name = headers
        .iter()
        .any(|h| ["物料名称", "图号", "名称", "品名"].contains(&h.header.trim()) && !h.header.contains("供应商"));
    let supplier_like = has("供应商名称") || has("供应商");
    if !has_item_name {
        // 只有供应商名：这就是供应商表
        if name.contains("供应商") || supplier_like {
            return Some("供应商表");
        }
        return None;
    }
    if name.contains("供应商") && !has("物料名称") {
        return Some("供应商表");
    }
    let has_code = has("物料编码") || has("编码序号") || has("物料编号");
    if has_code {
        return Some("物料表");
    }
    // 只有名称、没有编码：旧版「基础信息」表
    if has("图号") || has("类型") || name.contains("基础") {
        return Some("基础信息表");
    }
    None
}

fn squash(s: &str) -> String {
    // 全角括号本身保留，只去掉空白和“（xxx）”这种备注尾巴
    let (head, _, _) = split_note(s);
    head.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `数量（个）` → (`数量`, `个`)，括号里的内容不当字段名。
fn split_note(s: &str) -> (&str, &str, bool) {
    for open in ['（', '('] {
        if let Some(index) = s.find(open) {
            let close = if open == '（' { '）' } else { ')' };
            let note_start = index + open.len_utf8();
            if let Some(end) = s[note_start..].find(close) {
                return (&s[..index], &s[note_start..note_start + end], true);
            }
            return (&s[..index], "", true);
        }
    }
    (s, "", false)
}

pub fn guess_field(header: &str) -> Option<String> {
    let raw = header.trim();
    if raw.is_empty() {
        return None;
    }
    for (field, names) in ALIASES {
        if names.contains(&raw) {
            return Some((*field).to_string());
        }
    }
    let target = squash(raw);
    for (field, names) in ALIASES {
        if names.iter().any(|n| squash(n) == target) {
            return Some((*field).to_string());
        }
    }
    None
}

pub(crate) fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => "".to_string(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => crate::ledger::trim_float(*f),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Data::DateTime(dt) => excel_date(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.trim().to_string(),
        Data::Error(e) => format!("#ERR:{e:?}"),
    }
}

pub(crate) fn cell_float(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(f) => Some(*f),
        Data::Int(i) => Some(*i as f64),
        Data::DateTime(dt) => Some(dt.as_f64()),
        Data::String(s) => parse_number(s),
        _ => None,
    }
}

/// `1,234.50`、`￥12`、`12元` 都要能认出来。
pub fn parse_number(raw: &str) -> Option<f64> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, ',' | '，' | ' ' | '¥' | '￥' | '元' | '%'))
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Excel 1900 日期系统的序列号 → `YYYY-MM-DD`。
pub fn excel_date(serial: f64) -> String {
    if !serial.is_finite() || !(1.0..=80000.0).contains(&serial) {
        return "".to_string();
    }
    let base = match chrono::NaiveDate::from_ymd_opt(1899, 12, 30) {
        Some(d) => d,
        None => return "".to_string(),
    };
    let days = serial.floor() as u64;
    (base + chrono::Days::new(days)).format("%Y-%m-%d").to_string()
}

/// 任何日期写法统一成 `YYYY-MM-DD`；认不出来返回空串。
pub fn parse_date_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        return "".to_string();
    }
    if let Ok(v) = trimmed.parse::<f64>() {
        return excel_date(v);
    }
    let normalized = normalize_date(trimmed);
    if chrono::NaiveDate::parse_from_str(&normalized, "%Y-%m-%d").is_ok() {
        return normalized;
    }
    let replaced = trimmed
        .replace(['年', '月'], "-")
        .replace('日', "")
        .replace(['.', '/'], "-");
    let normalized = normalize_date(&replaced);
    if chrono::NaiveDate::parse_from_str(&normalized, "%Y-%m-%d").is_ok() {
        return normalized;
    }
    "".to_string()
}

/// 元 → 分，四舍五入。金额用这个。
pub fn to_cents(value: f64) -> i64 {
    (value * 100.0).round() as i64
}

/// 元 → 万分之一元，四舍五入。**单价必须用这个**：
/// 源表里大量单价是厘/丝级（0.202、0.216），按分存会截断，
/// 导致「数量 × 单价」重算对不上合计。
pub fn to_micros(value: f64) -> i64 {
    (value * 10_000.0).round() as i64
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderGuess {
    pub column: usize,
    pub header: String,
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetReport {
    pub name: String,
    pub rows: usize,
    pub non_empty_rows: usize,
    pub detail: bool,
    /// 主数据表（供应商名称 / 物料编号 / 基础信息），由 master 模块写入，不进台账
    pub master: bool,
    /// 月度「库存进销存报表」宽表：一行一物料 + 逐日入库/出库网格。
    /// 这类表由 `pivot` 模块拆成流水，不参与列映射。
    pub pivot: bool,
    /// 宽表态摘要（不是宽表时为空）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pivot_info: Option<PivotSheetInfo>,
    pub note: String,
    pub headers: Vec<HeaderGuess>,
    /// 前 5 行原始值（截断到 20 列），给向导里看一眼
    pub sample: Vec<Vec<String>>,
}

/// 宽表在向导里能一眼看清的摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotSheetInfo {
    /// 认出的月份；认不出就是 null，那张表会跳过
    pub month: Option<u32>,
    /// 逐日网格的天数
    pub days: usize,
    /// 真实物料行数（不含尾部填充行）
    pub items: usize,
    /// 尾部「编码=0」的填充行
    pub filler_rows: usize,
    /// 日格里的非零笔数
    pub flow_cells: usize,
    /// 有期初结存的物料数
    pub opening_items: usize,
    /// 源表「现结存」非零的物料数
    pub closing_items: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookReport {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sheets: Vec<SheetReport>,
}

/// 向导里每张表最多显示前几列原始值。
const SAMPLE_COLUMNS: usize = 20;

#[inline]
pub(crate) fn cell_is_empty(cell: &Data) -> bool {
    match cell {
        Data::Empty => true,
        Data::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

/// 解析结果缓存的时间上限。
///
/// 100MB+ 的工作簿，缓存里存的是所有 sheet 的 `Range`（解压后的单元格），
/// 常驻不释放等于把整本账本摊在内存里。托盘常驻的桌面程序在低配办公机上
/// 会开始换页，所以给它一个明确的过期时间，导入完成后也主动清掉。
const CACHE_TTL_SECS: u64 = 600;

#[derive(Clone)]
struct CachedWorkbook {
    path: std::path::PathBuf,
    size_bytes: u64,
    modified: Option<std::time::SystemTime>,
    /// 写缓存的时间，用于 TTL 判定
    cached_at: std::time::Instant,
    report: WorkbookReport,
    pivot_sheets: Vec<crate::pivot::PivotSheet>,
    master_sheets: Vec<(String, calamine::Range<Data>)>,
    flow_parsed: Vec<(SheetPlan, ParsedSheet)>,
}

/// 缓存是否还新鲜。文件被改过（大小/mtime 变化）或超过 TTL 都算过期。
fn cache_fresh(cached: &CachedWorkbook, path: &Path, size_bytes: u64, modified: Option<std::time::SystemTime>) -> bool {
    cache_fresh_at(cached, path, size_bytes, modified, std::time::Instant::now())
}

/// 与 cache_fresh 相同，只是「当前时刻」由调用方传入，便于测试。
///
/// 测试不能靠「Instant::now() 减去 Duration」造过期数据：Windows 上 Instant 是开机
/// 以来的时间，全新的 CI 机器绝对值可能还不到 TTL 那么大，相减直接溢出 panic。
/// 反过来把「现在」往后挪，只有到表示上限才会溢出。
fn cache_fresh_at(
    cached: &CachedWorkbook,
    path: &Path,
    size_bytes: u64,
    modified: Option<std::time::SystemTime>,
    now: std::time::Instant,
) -> bool {
    cached.path == path
        && cached.size_bytes == size_bytes
        && cached.modified == modified
        && now.saturating_duration_since(cached.cached_at).as_secs() < CACHE_TTL_SECS
}

/// 主动清缓存。导入/主数据写入完成后调用：那之后不再需要缓存的整本工作簿。
pub fn release_workbook_cache() {
    let cache_lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = cache_lock.lock() {
        *guard = None;
    }
}

static WORKBOOK_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CachedWorkbook>>> = std::sync::OnceLock::new();

/// 读工作簿里所有 sheet，按首行表头猜字段，标出哪些是明细表。
pub fn inspect(path: &Path) -> Result<WorkbookReport, String> {
    let (report, _) = inspect_and_collect_cached(path)?;
    Ok(report)
}

fn inspect_single_sheet(
    name: String,
    range_res: Result<calamine::Range<Data>, calamine::Error>,
) -> (
    SheetReport,
    Option<crate::pivot::PivotSheet>,
    Option<calamine::Range<Data>>,
    Option<(SheetPlan, ParsedSheet)>,
) {
    let range = match range_res {
        Ok(r) => r,
        Err(err) => {
            return (
                SheetReport {
                    name,
                    rows: 0,
                    non_empty_rows: 0,
                    detail: false,
                    master: false,
                    pivot: false,
                    pivot_info: None,
                    note: format!("读取失败: {err}"),
                    headers: Vec::new(),
                    sample: Vec::new(),
                },
                None,
                None,
                None,
            );
        }
    };
    let rows_ref: Vec<&[Data]> = range.rows().collect();
    let total = rows_ref.len();
    let sample: Vec<Vec<String>> = rows_ref
        .iter()
        .take(5)
        .map(|row| row.iter().take(SAMPLE_COLUMNS).map(cell_text).collect())
        .collect();
    let non_empty = rows_ref
        .iter()
        .filter(|row| row.iter().any(|c| !cell_is_empty(c)))
        .count();
    let headers: Vec<HeaderGuess> = rows_ref
        .first()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(column, cell)| {
                    let header = cell_text(cell);
                    HeaderGuess {
                        column,
                        field: guess_field(&header),
                        header,
                    }
                })
                .filter(|h| !h.header.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // 月度进销存宽表要先认，否则它也会落进「不像明细表」被跳过：
    // 它的表头里没有日期列，只有「1日…31日」两两一对的网格。
    if let Some(parsed) = crate::pivot::read_sheet(&name, &rows_ref) {
        let flows: usize = parsed
            .items
            .iter()
            .map(|i| i.days.iter().filter(|(_, a, b)| a.is_some() || b.is_some()).count())
            .sum();
        let items = parsed.items.len();
        let filler = parsed.filler_rows;
        let opening = parsed.items.iter().filter(|i| i.opening.unwrap_or(0.0) != 0.0).count();
        let closing = parsed.items.iter().filter(|i| i.closing.unwrap_or(0.0) != 0.0).count();
        let month = parsed.month;
        let day_count = parsed.day_count;
        let note = match month {
            Some(m) => format!("{m}月进销存宽表：{items} 个物料 · {day_count} 天网格 · {flows} 笔进出"),
            None => format!("像月度进销存宽表，但表名认不出月份（应为「1月」~「12月」）：{items} 个物料，会跳过"),
        };
        return (
            SheetReport {
                name,
                rows: total,
                non_empty_rows: non_empty,
                detail: false,
                master: false,
                pivot: true,
                pivot_info: Some(PivotSheetInfo {
                    month,
                    days: day_count,
                    items,
                    filler_rows: filler,
                    flow_cells: flows,
                    opening_items: opening,
                    closing_items: closing,
                }),
                note,
                headers,
                sample,
            },
            Some(parsed),
            None,
            None,
        );
    }

    let pairs: Vec<(String, String)> = headers
        .iter()
        .filter_map(|h| h.field.clone().map(|f| (h.header.clone(), f)))
        .collect();
    let detail = looks_like_detail(&pairs);
    let master_kind = if detail {
        None
    } else {
        master_sheet_kind(&name, &headers)
    };
    let note = if detail {
        format!("明细表：{} 行数据", non_empty.saturating_sub(1))
    } else if let Some(kind) = master_kind {
        format!("{kind}：{} 行，写入基础资料", non_empty.saturating_sub(1))
    } else if non_empty == 0 {
        "空表".to_string()
    } else {
        "不像明细表（缺日期/数量/物料列），不会导入".to_string()
    };
    let is_master = master_kind.is_some();
    let master_range = if is_master { Some(range.clone()) } else { None };
    let flow_item = if detail {
        let mut default_mapping = BTreeMap::new();
        for h in &headers {
            if let Some(f) = &h.field {
                default_mapping.insert(h.column, f.clone());
            }
        }
        let parsed = parse_sheet_from_range(&range, &name, &default_mapping);
        Some((
            SheetPlan {
                name: name.clone(),
                mapping: default_mapping,
                mode: None,
            },
            parsed,
        ))
    } else {
        None
    };

    (
        SheetReport {
            name,
            rows: total,
            non_empty_rows: non_empty,
            detail,
            master: is_master,
            pivot: false,
            pivot_info: None,
            note,
            headers,
            sample,
        },
        None,
        master_range,
        flow_item,
    )
}

/// 带文件状态校验与多线程加速的工作簿解析：
/// - 同一文件在「选文件 → 预览 → 切换年份 → 导入」多步调用中直接命中缓存，不重复解压；
/// - 首次打开大体积多表工作簿（如 123MB XML 的 12 个月宽表）时按 CPU 核心并行解压与解析。
pub(crate) fn inspect_and_collect_cached(
    path: &Path,
) -> Result<(WorkbookReport, Vec<crate::pivot::PivotSheet>), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到文件: {e}"))?;
    let size_bytes = meta.len();
    let modified = meta.modified().ok();
    let cache_lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache_lock.lock() {
        if let Some(cached) = guard.as_ref() {
            if cache_fresh(cached, path, size_bytes, modified) {
                return Ok((cached.report.clone(), cached.pivot_sheets.clone()));
            }
        }
    }

    let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
    let names = book.sheet_names().to_vec();
    let mut sheets = Vec::with_capacity(names.len());
    let mut pivot_parsed = Vec::new();
    let mut master_sheets = Vec::new();
    let mut flow_parsed = Vec::new();

    if names.len() >= 4 && size_bytes > 512 * 1024 {
        drop(book);
        // 每个 worker 都要 open 一次整本工作簿（calamine 解压后整册进内存），
        // 峰值内存约等于 worker 数 × 文件解压后大小。按 256MB 预算折算上限，
        // 否则 8 个 worker 解析 100MB 账本会直接吃掉 800MB+。
        let budget = 256usize * 1024 * 1024;
        let by_memory = if size_bytes as usize == 0 {
            8
        } else {
            (budget / size_bytes as usize).max(1)
        };
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(names.len())
            .min(by_memory)
            .clamp(1, 8);
        let indexed: Vec<(usize, String)> = names.into_iter().enumerate().collect();
        let chunk_size = indexed.len().div_ceil(workers);
        let mut results: Vec<(
            usize,
            SheetReport,
            Option<crate::pivot::PivotSheet>,
            Option<calamine::Range<Data>>,
            Option<(SheetPlan, ParsedSheet)>,
        )> = std::thread::scope(|s| {
            let mut handles = Vec::new();
            for chunk in indexed.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut local_book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
                    let mut out = Vec::with_capacity(chunk.len());
                    for (idx, name) in chunk {
                        let range_res = local_book.worksheet_range(name);
                        let (rep, piv, m_range, flow_item) = inspect_single_sheet(name.clone(), range_res);
                        out.push((*idx, rep, piv, m_range, flow_item));
                    }
                    Ok::<_, String>(out)
                }));
            }
            let mut merged = Vec::new();
            for h in handles {
                let part = h.join().map_err(|_| "并行解析工作表线程异常".to_string())??;
                merged.extend(part);
            }
            Ok::<_, String>(merged)
        })?;
        results.sort_by_key(|(idx, _, _, _, _)| *idx);
        for (_, rep, piv, m_range, flow_item) in results {
            if let Some(mr) = m_range {
                master_sheets.push((rep.name.clone(), mr));
            }
            if let Some(fi) = flow_item {
                flow_parsed.push(fi);
            }
            sheets.push(rep);
            if let Some(p) = piv {
                pivot_parsed.push(p);
            }
        }
    } else {
        for name in names {
            let range_res = book.worksheet_range(&name);
            let (rep, piv, m_range, flow_item) = inspect_single_sheet(name, range_res);
            if let Some(mr) = m_range {
                master_sheets.push((rep.name.clone(), mr));
            }
            if let Some(fi) = flow_item {
                flow_parsed.push(fi);
            }
            sheets.push(rep);
            if let Some(p) = piv {
                pivot_parsed.push(p);
            }
        }
    }

    let report = WorkbookReport {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size_bytes,
        sheets,
    };

    if let Ok(mut guard) = cache_lock.lock() {
        *guard = Some(CachedWorkbook {
            path: path.to_path_buf(),
            size_bytes,
            modified,
            cached_at: std::time::Instant::now(),
            report: report.clone(),
            pivot_sheets: pivot_parsed.clone(),
            master_sheets,
            flow_parsed,
        });
    }

    Ok((report, pivot_parsed))
}

pub(crate) fn get_cached_master_sheets(path: &Path) -> Option<Vec<(String, calamine::Range<Data>)>> {
    let meta = std::fs::metadata(path).ok()?;
    let size_bytes = meta.len();
    let modified = meta.modified().ok();
    let cache_lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache_lock.lock() {
        if let Some(cached) = guard.as_ref() {
            if cache_fresh(cached, path, size_bytes, modified) && !cached.master_sheets.is_empty() {
                return Some(cached.master_sheets.clone());
            }
        }
    }
    None
}

pub(crate) fn update_cached_flow_parsed(path: &Path, parsed: Vec<(SheetPlan, ParsedSheet)>) {
    let cache_lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = cache_lock.lock() {
        if let Some(cached) = guard.as_mut() {
            if cached.path == path {
                cached.flow_parsed = parsed;
            }
        }
    }
}

pub(crate) fn get_cached_flow_parsed(path: &Path, plans: &[SheetPlan]) -> Option<Vec<ParsedSheet>> {
    let meta = std::fs::metadata(path).ok()?;
    let size_bytes = meta.len();
    let modified = meta.modified().ok();
    let cache_lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache_lock.lock() {
        if let Some(cached) = guard.as_ref() {
            if cache_fresh(cached, path, size_bytes, modified)
                && cached.flow_parsed.len() == plans.len()
                && !plans.is_empty()
            {
                let all_match = plans.iter().all(|p| {
                    cached
                        .flow_parsed
                        .iter()
                        .any(|(cp, _)| cp.name == p.name && cp.mapping == p.mapping)
                });
                if all_match {
                    let mut out = Vec::new();
                    for p in plans {
                        if let Some((_, parsed)) = cached.flow_parsed.iter().find(|(cp, _)| cp.name == p.name) {
                            out.push(parsed.clone());
                        }
                    }
                    return Some(out);
                }
            }
        }
    }
    None
}

/// 一条问题：哪张表、哪一行、什么毛病。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub sheet: String,
    pub row_no: u64,
    pub message: String,
}

/// 标准化后的一行。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRow {
    pub sheet: String,
    pub row_no: u64,
    pub kind: String,
    pub doc_date: String,
    pub doc_no: String,
    pub delivery_no: String,
    pub item_code: String,
    pub item_name: String,
    pub location: String,
    pub spec: String,
    pub unit: String,
    pub qty: Option<f64>,
    pub price_micros: Option<i64>,
    pub amount_cents: Option<i64>,
    pub remark: String,
    pub partner: String,
    pub buyer: String,
    pub owner: String,
    pub receiver: String,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedSheet {
    pub name: String,
    pub rows: Vec<DraftRow>,
    pub issues: Vec<Issue>,
    pub skipped: usize,
}

impl ParsedSheet {
    pub fn is_in(&self) -> bool {
        infer_kind(&self.name, &self.rows) == "in"
    }
}

/// 先看表名；名字里没有方向词时，带供应商/送货单号的行算入库。
pub fn infer_kind(sheet_name: &str, rows: &[DraftRow]) -> &'static str {
    let name = sheet_name.replace(' ', "");
    if name.contains("入库") {
        return "in";
    }
    if name.contains("出库") || name.contains("领用") {
        return "out";
    }
    if rows.iter().any(|r| !r.partner.is_empty() || !r.delivery_no.is_empty()) {
        "in"
    } else {
        "out"
    }
}

/// 列序号 → 字段。BTreeMap 保证遍历顺序稳定。
pub type ColumnMap = BTreeMap<usize, String>;

/// `mapping`：列序号 → 字段名（空 / `unused` 表示不导入）。
pub fn parse_sheet<RS: std::io::Read + std::io::Seek>(
    book: &mut impl calamine::Reader<RS>,
    sheet: &str,
    mapping: &ColumnMap,
) -> Result<ParsedSheet, String> {
    let range = book
        .worksheet_range(sheet)
        .map_err(|e| format!("读取工作表 `{sheet}` 失败: {e:?}"))?;
    Ok(parse_sheet_from_range(&range, sheet, mapping))
}

/// 直接从内存 Range 解析明细表，循环前预先提取列索引，避免每行重复线性搜索
pub fn parse_sheet_from_range(range: &calamine::Range<Data>, sheet: &str, mapping: &ColumnMap) -> ParsedSheet {
    let find_col =
        |f: &str| -> Option<usize> { mapping.iter().find(|(_, field)| field.as_str() == f).map(|(c, _)| *c) };

    let col_date = find_col("doc_date");
    let col_code = find_col("item_code");
    let col_name = find_col("item_name");
    let col_spec = find_col("spec");
    let col_unit = find_col("unit");
    let col_qty = find_col("qty");
    let col_price = find_col("price");
    let col_amount = find_col("amount");
    let col_remark = find_col("remark");
    let col_partner = find_col("partner");
    let col_buyer = find_col("buyer");
    let col_owner = find_col("owner");
    let col_receiver = find_col("receiver");
    let col_doc_no = find_col("doc_no");
    let col_delivery_no = find_col("delivery_no");

    let mut rows_out: Vec<DraftRow> = Vec::with_capacity(range.height().saturating_sub(1));
    let mut issues: Vec<Issue> = Vec::new();
    let mut skipped = 0usize;

    for (index, row) in range.rows().enumerate() {
        if index == 0 {
            continue; // 表头
        }
        let row_no = (index + 1) as u64;
        let get = |c: Option<usize>| -> Option<&Data> { c.and_then(|idx| row.get(idx)) };
        let text = |c: Option<usize>| -> String { get(c).map(cell_text).unwrap_or_default() };

        let date_raw = text(col_date);
        let code = text(col_code);
        let name = text(col_name);
        let qty_raw = get(col_qty).and_then(cell_float);
        let qty_text = get(col_qty).map(cell_text).unwrap_or_default();

        // 整行空：跳过但不算问题
        if date_raw.is_empty()
            && code.is_empty()
            && name.is_empty()
            && qty_text.is_empty()
            && text(col_amount).is_empty()
            && text(col_doc_no).is_empty()
        {
            skipped += 1;
            continue;
        }
        if code.is_empty() && name.is_empty() {
            skipped += 1;
            issues.push(Issue {
                sheet: sheet.to_string(),
                row_no,
                message: "没有物料编码也没有物料名称，整行跳过".to_string(),
            });
            continue;
        }

        let mut flags: Vec<String> = Vec::new();
        let date = parse_date_text(&date_raw);
        if date.is_empty() {
            flags.push("no_date".into());
            issues.push(Issue {
                sheet: sheet.to_string(),
                row_no,
                message: format!("日期认不出来：`{date_raw}`"),
            });
        }
        if code.is_empty() {
            flags.push("no_code".into());
        }
        let price = get(col_price).and_then(cell_float).map(to_micros);
        let amount = get(col_amount).and_then(cell_float).map(to_cents);
        if price.is_none() {
            flags.push("no_price".into());
        }
        if amount.is_none_or(|a| a == 0) {
            flags.push("no_amount".into());
        }
        if qty_raw.is_none() {
            flags.push("no_qty".into());
            issues.push(Issue {
                sheet: sheet.to_string(),
                row_no,
                message: if qty_text.is_empty() {
                    "数量为空".to_string()
                } else {
                    format!("数量不是数字：`{qty_text}`")
                },
            });
        }
        // 数量 × 单价 与合计对不上（容差 1 分）：只提醒，不改数。
        // 注意单位：单价是万分之一元，合计是分，所以要先除以 100。
        if let (Some(q), Some(p), Some(a)) = (qty_raw, price, amount) {
            let expect = (q * p as f64 / 100.0).round() as i64;
            if a != 0 && (expect - a).abs() > 1 {
                flags.push("qty_mismatch".into());
            }
        }

        rows_out.push(DraftRow {
            sheet: sheet.to_string(),
            row_no,
            kind: String::new(), // 导入时按 infer_kind 统一填
            doc_date: date,
            doc_no: text(col_doc_no),
            delivery_no: text(col_delivery_no),
            item_code: code,
            item_name: name,
            location: String::new(),
            spec: text(col_spec),
            unit: text(col_unit),
            qty: qty_raw,
            price_micros: price,
            amount_cents: amount,
            remark: text(col_remark),
            partner: text(col_partner),
            buyer: text(col_buyer),
            owner: text(col_owner),
            receiver: text(col_receiver),
            flags,
        });
    }

    ParsedSheet {
        name: sheet.to_string(),
        rows: rows_out,
        issues,
        skipped,
    }
}

/// 从解析报告的猜测结果生成默认映射。
pub fn mapping_from_report(sheet: &SheetReport) -> ColumnMap {
    let mut map = BTreeMap::new();
    for header in &sheet.headers {
        if let Some(field) = &header.field {
            map.insert(header.column, field.clone());
        }
    }
    map
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPlan {
    pub name: String,
    pub mapping: ColumnMap,
    /// `replace` = 先删这张表的旧行再导；`append` = 追加
    #[serde(default)]
    pub mode: Option<String>,
}

/// 月度进销存宽表拆解后的预览对账摘要。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotPreviewSummary {
    pub months: Vec<u32>,
    pub total_items: usize,
    pub located_items: usize,
    pub opening_rows: usize,
    pub daily_rows: usize,
    pub residual_rows: usize,
    pub adjust_rows: usize,
    pub correction_rows: usize,
    pub filler_rows: usize,
    pub corrections: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreview {
    pub name: String,
    pub kind: String,
    pub rows: usize,
    pub skipped: usize,
    pub flagged: usize,
    pub issues: Vec<Issue>,
    pub sample: Vec<DraftRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pivot_summary: Option<PivotPreviewSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub sheets: Vec<SheetPreview>,
    pub total_rows: usize,
    pub total_issues: usize,
    pub flagged_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub name: String,
    pub kind: String,
    pub rows: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub import_id: i64,
    pub file_name: String,
    pub rows: usize,
    pub skipped: usize,
    pub flagged: usize,
    pub replaced: usize,
    pub issues: Vec<Issue>,
    pub sheets: Vec<SheetSummary>,
    pub duplicate_of: Option<i64>,
    /// 顺带导入的基础资料结果（供应商 / 物料编号 / 基础信息）；没开或没找到表就是 None
    #[serde(default)]
    pub master: Option<crate::master::MasterImportOutcome>,
    /// 基础资料导入失败的原因。台账已经写成功，这里只提示，不回滚
    #[serde(default)]
    pub master_error: Option<String>,
}

fn plan_for(report: &WorkbookReport, requested: Option<Vec<SheetPlan>>) -> Result<Vec<SheetPlan>, String> {
    if let Some(plans) = requested {
        let plans: Vec<SheetPlan> = plans.into_iter().filter(|p| !p.name.trim().is_empty()).collect();
        if !plans.is_empty() {
            return Ok(plans);
        }
    }
    let plans: Vec<SheetPlan> = report
        .sheets
        .iter()
        .filter(|s| s.detail)
        .map(|s| SheetPlan {
            name: s.name.clone(),
            mapping: mapping_from_report(s),
            mode: None,
        })
        .collect();
    if plans.is_empty() {
        return Err(
            "这个工作簿里没找到能识别的明细表（需要同时有日期、数量、物料列）。可以手动指定列映射后再试。".to_string(),
        );
    }
    Ok(plans)
}

/// 挑选宽表预览样本：兼顾期初结存、日常进出与盘点/校正行，避免前 20 行全是 1 月期初。
fn sample_pivot_rows(rows: &[DraftRow], limit: usize) -> Vec<DraftRow> {
    if rows.len() <= limit {
        return rows.to_vec();
    }
    let qc_quota = (limit / 4).clamp(1, 3);
    let mut out = Vec::with_capacity(limit);
    for r in rows.iter().filter(|r| r.doc_no.ends_with("QC")).take(qc_quota) {
        out.push(r.clone());
    }
    for r in rows.iter().filter(|r| !r.doc_no.ends_with("QC")) {
        if out.len() >= limit {
            break;
        }
        out.push(r.clone());
    }
    if out.len() < limit {
        for r in rows.iter().filter(|r| r.doc_no.ends_with("QC")).skip(qc_quota) {
            if out.len() >= limit {
                break;
            }
            out.push(r.clone());
        }
    }
    out
}

/// 该工作簿里有几张宽表、各是哪几个月。
fn pivot_sheets(report: &WorkbookReport) -> Vec<&SheetReport> {
    report.sheets.iter().filter(|s| s.pivot).collect()
}

pub fn preview(path: &Path, plans: Option<Vec<SheetPlan>>, sample_limit: usize) -> Result<PreviewResult, String> {
    preview_with_year(path, plans, sample_limit, current_year())
}

pub fn preview_with_year(
    path: &Path,
    plans: Option<Vec<SheetPlan>>,
    sample_limit: usize,
    year: i32,
) -> Result<PreviewResult, String> {
    let (report, pivot_parsed) = inspect_and_collect_cached(path)?;
    let mut total_rows = 0usize;
    let mut total_issues = 0usize;
    let mut flagged_rows = 0usize;
    let mut sheets = Vec::new();

    // 宽表走 pivot：直接复用缓存/首次解析好的月度表，不二次解压 XML。
    if !pivot_parsed.is_empty() {
        let built = crate::pivot::build_with_hint(&pivot_parsed, year, Some(&report.file_name));
        total_rows += built.rows.len();
        total_issues += built.issues.len();
        flagged_rows += built.correction_rows;
        let issues: Vec<Issue> = built
            .issues
            .iter()
            .take(60)
            .map(|message| Issue {
                sheet: "月度进销存".to_string(),
                row_no: 0,
                message: message.clone(),
            })
            .collect();
        let located_items = built
            .items
            .iter()
            .filter(|i| i.location.as_deref().is_some_and(|l| !l.trim().is_empty()))
            .count();
        sheets.push(SheetPreview {
            name: format!("月度进销存（{} 个月）", built.months.len()),
            kind: "pivot".to_string(),
            rows: built.rows.len(),
            skipped: built.filler_rows,
            flagged: built.correction_rows,
            issues,
            sample: sample_pivot_rows(&built.rows, sample_limit),
            pivot_summary: Some(PivotPreviewSummary {
                months: built.months.clone(),
                total_items: built.items.len(),
                located_items,
                opening_rows: built.opening_rows,
                daily_rows: built.daily_rows,
                residual_rows: built.residual_rows,
                adjust_rows: built.adjust_rows,
                correction_rows: built.correction_rows,
                filler_rows: built.filler_rows,
                corrections: built.corrections.clone(),
            }),
        });
    }

    // 同一本工作簿里如果还有常规明细表，照旧走列映射。
    let flow_report = WorkbookReport {
        sheets: report.sheets.iter().filter(|s| s.detail).cloned().collect(),
        ..report.clone()
    };
    if !flow_report.sheets.is_empty() {
        let flow_plans = plan_for(&flow_report, plans)?;
        let parsed_sheets = if let Some(cached) = get_cached_flow_parsed(path, &flow_plans) {
            cached
        } else {
            let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
            let mut list = Vec::new();
            let mut cached_to_save = Vec::new();
            for plan in &flow_plans {
                let parsed = parse_sheet(&mut book, &plan.name, &plan.mapping)?;
                cached_to_save.push((plan.clone(), parsed.clone()));
                list.push(parsed);
            }
            update_cached_flow_parsed(path, cached_to_save);
            list
        };

        for (plan, parsed) in flow_plans.iter().zip(parsed_sheets) {
            let kind = if parsed.is_in() { "in" } else { "out" };
            let flagged = parsed.rows.iter().filter(|r| !r.flags.is_empty()).count();
            total_rows += parsed.rows.len();
            total_issues += parsed.issues.len();
            flagged_rows += flagged;
            let sample: Vec<DraftRow> = parsed.rows.iter().take(sample_limit).cloned().collect();
            let mut issues = parsed.issues;
            issues.truncate(60);
            sheets.push(SheetPreview {
                name: plan.name.clone(),
                kind: kind.to_string(),
                rows: parsed.rows.len(),
                skipped: parsed.skipped,
                flagged,
                issues,
                sample,
                pivot_summary: None,
            });
        }
    }

    if sheets.is_empty() {
        return Err("这个工作簿里没找到能识别的明细表，也没有月度进销存宽表。可以手动指定列映射后再试。".to_string());
    }

    Ok(PreviewResult {
        sheets,
        total_rows,
        total_issues,
        flagged_rows,
    })
}

fn file_hash(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

pub struct HeaderRow {
    pub file_name: String,
    pub file_hash: String,
    pub sheets_json: String,
    pub imported_at: String,
    pub row_count: i64,
    pub skipped_count: i64,
    pub note: Option<String>,
}

fn null_if_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 实际写库：一个事务，要么全进要么一条不进。返回 (导入批次 id, 被覆盖的行数)。
///
/// 「覆盖同名 sheet」按 `header.file_name` 限定在同一个源工作簿内：同一张
/// `入库明细` 在两个不同工作簿里都存在时，导入第二个不能把第一个的明细删掉。
pub fn write_rows(
    db: &Db,
    header: &HeaderRow,
    rows: &[DraftRow],
    replace_sheets: &[String],
) -> Result<(i64, usize), String> {
    let (id, replaced, _) = write_rows_with_items(db, header, rows, replace_sheets, &[])?;
    Ok((id, replaced))
}

/// 与 [`write_rows`] 相同，但把宽表带来的基础资料一并写进**同一个事务**。
///
/// 以前台账写完先 commit，再单独 upsert 物料；中途失败只返回一句提示，于是
/// 库里留下「台账行数对、但物料没有库位/规格」的半成品，用户重复点导入又会
/// 追加一遍。现在两者一次提交，失败一起回滚。
pub fn write_rows_with_items(
    db: &Db,
    header: &HeaderRow,
    rows: &[DraftRow],
    replace_sheets: &[String],
    master_items: &[crate::pivot::PivotItemDef],
) -> Result<(i64, usize, Option<(usize, usize)>), String> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction().map_err(DbError::from)?;
        let mut replaced = 0usize;
        for sheet in replace_sheets {
            replaced += tx
                .execute(
                    "DELETE FROM ledger WHERE sheet = ?1
                       AND import_id IN (SELECT id FROM imports WHERE file_name = ?2)",
                    rusqlite::params![sheet, header.file_name],
                )
                .map_err(DbError::from)?;
        }
        // 被覆盖批次的 row_count 得跟着修正，否则导入历史里仍显示原来的行数
        if replaced > 0 {
            tx.execute(
                "UPDATE imports SET row_count =
                    (SELECT COUNT(*) FROM ledger l WHERE l.import_id = imports.id)
                 WHERE file_name = ?1",
                rusqlite::params![header.file_name],
            )
            .map_err(DbError::from)?;
        }
        tx.execute(
            "INSERT INTO imports (file_name, file_hash, sheets, imported_at, row_count, skipped_count, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                header.file_name,
                header.file_hash,
                header.sheets_json,
                header.imported_at,
                header.row_count,
                header.skipped_count,
                header.note
            ],
        )
        .map_err(DbError::from)?;
        let import_id = tx.last_insert_rowid();

        // 预查已有物料的规格与单位（避免写完库后再全表扫描 UPDATE ledger 并做标量子查询）
        let mut item_meta_cache: std::collections::HashMap<String, (Option<String>, Option<String>)> =
            std::collections::HashMap::new();
        let need_meta_lookup = rows.iter().any(|r| {
            !r.item_code.trim().is_empty() && (r.unit.trim().is_empty() || r.spec.trim().is_empty())
        });
        if need_meta_lookup {
            if let Ok(mut stmt) = tx.prepare(
                "SELECT item_code, NULLIF(TRIM(unit), ''), NULLIF(TRIM(spec), '') FROM items
                 WHERE (unit IS NOT NULL AND TRIM(unit) != '') OR (spec IS NOT NULL AND TRIM(spec) != '')",
            ) {
                if let Ok(rows_iter) = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, (r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)))
                }) {
                    for entry in rows_iter.flatten() {
                        item_meta_cache.insert(entry.0, entry.1);
                    }
                }
            }
        }

        // 批量插入台账行
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO ledger (import_id, sheet, row_no, kind, doc_date, doc_no, delivery_no,
                        item_code, item_name, spec, unit, qty, price_micros, amount_cents, remark,
                        partner, buyer, owner, receiver, flags)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                )
                .map_err(DbError::from)?;

            for row in rows {
                let (spec, unit) = match item_meta_cache.get(&row.item_code) {
                    Some((cached_unit, cached_spec)) => {
                        let final_spec = if row.spec.trim().is_empty() {
                            cached_spec.as_deref().unwrap_or(row.spec.as_str())
                        } else {
                            row.spec.as_str()
                        };
                        let final_unit = if row.unit.trim().is_empty() {
                            cached_unit.as_deref().unwrap_or(row.unit.as_str())
                        } else {
                            row.unit.as_str()
                        };
                        (final_spec, final_unit)
                    }
                    None => (row.spec.as_str(), row.unit.as_str()),
                };

                stmt.execute(rusqlite::params![
                    import_id,
                    row.sheet,
                    row.row_no,
                    row.kind,
                    null_if_empty(&row.doc_date),
                    null_if_empty(&row.doc_no),
                    null_if_empty(&row.delivery_no),
                    null_if_empty(&row.item_code),
                    null_if_empty(&row.item_name),
                    null_if_empty(spec),
                    null_if_empty(unit),
                    row.qty,
                    row.price_micros,
                    row.amount_cents,
                    null_if_empty(&row.remark),
                    null_if_empty(&row.partner),
                    null_if_empty(&row.buyer),
                    null_if_empty(&row.owner),
                    null_if_empty(&row.receiver),
                    row.flags.join(","),
                ])
                .map_err(DbError::from)?;
            }
        }

        // 导入的文字字段在内存中聚合频次后批量写入字典，避免数万次单条 SQL 往返
        let mut dict_counts: std::collections::HashMap<(&'static str, String), i64> =
            std::collections::HashMap::new();
        for row in rows {
            let unit = if row.unit.trim().is_empty() {
                item_meta_cache
                    .get(&row.item_code)
                    .and_then(|(u, _)| u.as_deref())
                    .unwrap_or("")
            } else {
                row.unit.trim()
            };
            if !unit.is_empty() {
                *dict_counts.entry(("unit", unit.to_string())).or_insert(0) += 1;
            }
            let owner = row.owner.trim();
            if !owner.is_empty() {
                *dict_counts.entry(("owner", owner.to_string())).or_insert(0) += 1;
            }
            let buyer = row.buyer.trim();
            if !buyer.is_empty() {
                *dict_counts.entry(("buyer", buyer.to_string())).or_insert(0) += 1;
            }
        }
        crate::dict::touch_many(&tx, dict_counts.iter().map(|((k, v), c)| (*k, v.as_str(), *c)));

        // 宽表物料与台账同事务：任一失败一起回滚，不会留下单边数据
        let item_counts = if master_items.is_empty() {
            None
        } else {
            Some(crate::pivot::upsert_items_tx(&tx, master_items).map_err(DbError::from)?)
        };

        tx.commit().map_err(DbError::from)?;
        Ok((import_id, replaced, item_counts))
    })
}

/// 完整导入：读文件 → 解析 → 写库。
pub fn run(db: &Db, path: &Path, plans: Option<Vec<SheetPlan>>, replace_all: bool) -> Result<ImportOutcome, String> {
    run_with_year(db, path, plans, replace_all, current_year())
}

/// 当前年份：宽表里没有年份，默认按今年算。
pub fn current_year() -> i32 {
    chrono::Local::now().year()
}

/// 带年份的完整导入。`year` 只对月度进销存宽表有意义。
pub fn run_with_year(
    db: &Db,
    path: &Path,
    plans: Option<Vec<SheetPlan>>,
    replace_all: bool,
    year: i32,
) -> Result<ImportOutcome, String> {
    run_with_options(db, path, plans, replace_all, year, false)
}

/// 完整导入 + 「允许重复导入」开关。
///
/// 默认拒绝重复导入：同一个文件（内容 hash 相同）再追加一次，台账、库存结存、
/// 月度汇总、金额合计全部翻倍，而这种错误很难事后发现。用户确实要重导时，
/// 前端会二次确认后再带 `allow_duplicate = true` 调一次。
pub fn run_with_options(
    db: &Db,
    path: &Path,
    plans: Option<Vec<SheetPlan>>,
    replace_all: bool,
    year: i32,
    allow_duplicate: bool,
) -> Result<ImportOutcome, String> {
    let (report, pivot_parsed) = inspect_and_collect_cached(path)?;
    let mut all_rows: Vec<DraftRow> = Vec::new();
    let mut all_issues: Vec<Issue> = Vec::new();
    let mut summaries: Vec<SheetSummary> = Vec::new();
    let mut replace_sheets: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let mut pivot_master: Option<crate::pivot::PivotBuild> = None;

    // ---- 月度进销存宽表 ----
    if !pivot_parsed.is_empty() {
        let built = crate::pivot::build_with_hint(&pivot_parsed, year, Some(&report.file_name));
        if built.rows.is_empty() {
            return Err(
                "月度进销存宽表里没有可导入的流水：表名要写成「1月」~「12月」，源表还要有逐日入库/出库格子。"
                    .to_string(),
            );
        }
        all_issues.extend(built.issues.iter().take(200).map(|m| Issue {
            sheet: "月度进销存".to_string(),
            row_no: 0,
            message: m.clone(),
        }));
        summaries.push(SheetSummary {
            name: format!("月度进销存 {} 个月", built.months.len()),
            kind: "pivot".to_string(),
            rows: built.rows.len(),
            skipped: built.filler_rows,
        });
        skipped += built.filler_rows;
        if replace_all {
            // 整本宽表按「表名」逐页覆盖；先记下这些表名，写库时一起清
            for sheet in pivot_sheets(&report) {
                replace_sheets.push(sheet.name.clone());
            }
        }
        all_rows.extend(built.rows.iter().cloned());
        pivot_master = Some(built);
    }

    // ---- 常规出入库明细 ----
    let flow_report = WorkbookReport {
        sheets: report.sheets.iter().filter(|s| s.detail).cloned().collect(),
        ..report.clone()
    };
    if !flow_report.sheets.is_empty() {
        let flow_plans = plan_for(&flow_report, plans)?;
        let parsed_sheets = if let Some(cached) = get_cached_flow_parsed(path, &flow_plans) {
            cached
        } else {
            let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
            let mut list = Vec::new();
            let mut to_save = Vec::new();
            for plan in &flow_plans {
                let parsed = parse_sheet(&mut book, &plan.name, &plan.mapping)?;
                to_save.push((plan.clone(), parsed.clone()));
                list.push(parsed);
            }
            update_cached_flow_parsed(path, to_save);
            list
        };

        for parsed in parsed_sheets {
            let kind = if parsed.is_in() { "in" } else { "out" };
            for row in &parsed.rows {
                let mut row = row.clone();
                row.kind = kind.to_string();
                all_rows.push(row);
            }
            all_issues.extend(parsed.issues.iter().take(200).cloned());
            summaries.push(SheetSummary {
                name: parsed.name.clone(),
                kind: kind.to_string(),
                rows: parsed.rows.len(),
                skipped: parsed.skipped,
            });
            skipped += parsed.skipped;
            let mode = flow_plans
                .iter()
                .find(|p| p.name == parsed.name)
                .and_then(|p| p.mode.as_deref())
                .unwrap_or("append");
            if replace_all || mode == "replace" {
                replace_sheets.push(parsed.name.clone());
            }
        }
    }

    if all_rows.is_empty() {
        return Err("这个工作簿里没找到能识别的明细表，也没有月度进销存宽表。可以手动指定列映射后再试。".to_string());
    }

    let mut flagged = all_rows.iter().filter(|r| !r.flags.is_empty()).count();
    if let Some(built) = &pivot_master {
        flagged += built.correction_rows;
    }
    let hash = file_hash(path)?;
    let duplicate_of = find_import_by_hash(db, &hash)?;
    ensure_not_duplicate(db, &report.file_name, duplicate_of, allow_duplicate)?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let sheets_json = serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string());
    let note = if replace_sheets.is_empty() {
        None
    } else {
        Some(format!("覆盖表: {}", replace_sheets.join(",")))
    };

    let header = HeaderRow {
        file_name: report.file_name.clone(),
        file_hash: hash,
        sheets_json,
        imported_at: now,
        row_count: all_rows.len() as i64,
        skipped_count: skipped as i64,
        note,
    };
    // 宽表物料（含库位/规格/单位/类型）跟台账同事务写：失败一起回滚，
    // 不会出现「行数对但物料缺库位」，用户也不必重复点导入。
    let master_items: &[crate::pivot::PivotItemDef] = pivot_master.as_ref().map(|b| b.items.as_slice()).unwrap_or(&[]);
    let (import_id, replaced, item_counts) =
        write_rows_with_items(db, &header, &all_rows, &replace_sheets, master_items)?;

    // 事务已经提交，走到这里物料一定写成功；统计直接用本次写入的数字。
    let mut master_outcome = None;
    let master_error = None;
    if let Some(built) = &pivot_master {
        if let (false, Some((added, updated))) = (built.items.is_empty(), item_counts) {
            let located = built
                .items
                .iter()
                .filter(|i| i.location.as_deref().is_some_and(|l| !l.trim().is_empty()))
                .count();
            master_outcome = Some(crate::master::MasterImportOutcome {
                items_added: added,
                items_updated: updated,
                suppliers_added: 0,
                suppliers_skipped: 0,
                sheets_found: vec![format!(
                    "月度进销存 {} 个月（物料 {} 个，含库位 {} 个）",
                    built.months.len(),
                    built.items.len(),
                    located
                )],
                message: format!("物料 +{added} 更新 {updated}（同步库位 {located} 个）"),
            });
        }
    }

    Ok(ImportOutcome {
        import_id,
        file_name: report.file_name,
        rows: all_rows.len(),
        skipped,
        flagged,
        replaced,
        issues: all_issues,
        sheets: summaries,
        duplicate_of,
        master: master_outcome,
        master_error,
    })
}

fn find_import_by_hash(db: &Db, hash: &str) -> Result<Option<i64>, String> {
    let found = db
        .with(|c| {
            c.query_row(
                "SELECT id FROM imports WHERE file_hash = ?1 ORDER BY id DESC LIMIT 1",
                [hash],
                |r| r.get(0),
            )
            .map_err(DbError::from)
        })
        .ok();
    Ok(found)
}

/// 同一份文件（内容 hash 相同）已经导过时怎么办。
///
/// 默认拒绝：再追加一次会让台账行、库存结存、月度汇总与金额合计全部翻倍，
/// 事后极难拆回。确实要重导（例如上次只导了一半）时，前端二次确认后带
/// `allow_duplicate = true` 再调一次。
fn ensure_not_duplicate(
    db: &Db,
    file_name: &str,
    duplicate_of: Option<i64>,
    allow_duplicate: bool,
) -> Result<(), String> {
    let Some(existing) = duplicate_of else {
        return Ok(());
    };
    if allow_duplicate {
        log::warn!("用户显式允许重复导入：{file_name}（命中批次 #{existing}）");
        return Ok(());
    }
    let detail = db
        .with(|c| {
            c.query_row(
                "SELECT file_name, imported_at, row_count FROM imports WHERE id = ?1",
                [existing],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
            )
            .map_err(DbError::from)
        })
        .ok()
        .map(|(name, at, rows)| format!("#{existing}（{name}，{at}，{rows} 行）"))
        .unwrap_or_else(|| format!("#{existing}"));
    Err(format!(
        "这个文件之前已经导入过（批次 {detail}）。再导一次会让台账、库存和汇总翻倍；\
         需要重导请先在导入历史里删掉那一批，或打开「允许重复导入」再点一次。"
    ))
}

/// 导入历史。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub id: i64,
    pub file_name: String,
    pub file_hash: String,
    pub imported_at: String,
    pub row_count: i64,
    pub skipped_count: i64,
    pub note: Option<String>,
    pub live_rows: i64,
}

pub fn history(db: &Db) -> Result<Vec<ImportRecord>, String> {
    db.with(|c| {
        let mut stmt = c
            .prepare(
                "SELECT i.id, i.file_name, i.file_hash, i.imported_at, i.row_count, i.skipped_count, i.note,
                        (SELECT COUNT(*) FROM ledger l WHERE l.import_id = i.id)
                 FROM imports i ORDER BY i.id DESC LIMIT 50",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ImportRecord {
                    id: r.get(0)?,
                    file_name: r.get(1)?,
                    file_hash: r.get(2)?,
                    imported_at: r.get(3)?,
                    row_count: r.get(4)?,
                    skipped_count: r.get(5)?,
                    note: r.get(6)?,
                    live_rows: r.get(7)?,
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(DbError::from)?;
        Ok(rows)
    })
}

/// 删掉一次导入（级联删明细）。
pub fn delete_import(db: &Db, id: i64) -> Result<usize, String> {
    db.with(|c| {
        c.execute("DELETE FROM ledger WHERE import_id = ?1", [id])
            .map_err(DbError::from)?;
        c.execute("DELETE FROM imports WHERE id = ?1", [id])
            .map_err(DbError::from)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存必须能主动释放：导入完成后不再需要整本工作簿的 Range。
    #[test]
    fn workbook_cache_can_be_released() {
        let lock = WORKBOOK_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        if let Ok(mut guard) = lock.lock() {
            *guard = None;
        }
        release_workbook_cache();
        let empty = lock.lock().map(|g| g.is_none()).unwrap_or(false);
        assert!(empty, "释放后缓存应为空");
    }

    /// 超过 TTL 的缓存必须被判成过期，不能一直拿旧解析结果。
    #[test]
    fn stale_cache_is_not_fresh() {
        let path = std::path::PathBuf::from("C:/x/y.xlsx");
        let cached = CachedWorkbook {
            path: path.clone(),
            size_bytes: 10,
            modified: None,
            cached_at: std::time::Instant::now(),
            report: WorkbookReport {
                path: String::new(),
                file_name: String::new(),
                size_bytes: 0,
                sheets: Vec::new(),
            },
            pivot_sheets: Vec::new(),
            master_sheets: Vec::new(),
            flow_parsed: Vec::new(),
        };
        assert!(cache_fresh(&cached, &path, 10, None));
        // 文件变大说明被改过
        assert!(!cache_fresh(&cached, &path, 11, None));
        // 时间拨到 TTL 之外。注意是往后拨「现在」，不能回拨 cached_at：
        // 新机器上 Instant 的绝对值可能小于 TTL，减法会溢出 panic。
        let later = cached.cached_at + std::time::Duration::from_secs(CACHE_TTL_SECS + 1);
        assert!(!cache_fresh_at(&cached, &path, 10, None, later));
    }

    fn guesses(headers: &[&str]) -> Vec<HeaderGuess> {
        headers
            .iter()
            .enumerate()
            .map(|(column, header)| HeaderGuess {
                column,
                field: guess_field(header),
                header: header.to_string(),
            })
            .collect()
    }

    /// 月度进销存宽表也能被 `inspect` 认出来，且不会被当成明细表或主数据表。
    #[test]
    fn pivot_sheets_are_detected_as_pivot() {
        // 造一张最小的月度宽表：表头在第 2 行，31 个日列
        let mut header = vec![
            "序号".to_string(),
            "物料编码".to_string(),
            "名称".to_string(),
            "库位".to_string(),
            "上月结存".to_string(),
            "本月入库".to_string(),
            "本月出库".to_string(),
            "现结存".to_string(),
        ];
        for day in 1..=31 {
            header.push(format!("{day}日"));
            header.push(String::new());
        }
        let rows = [
            vec!["".to_string(), "1 月 库  存  进  销  存  报  表".to_string()],
            header,
            vec!["".to_string(); 70],
            {
                let mut row = vec![
                    "1".to_string(),
                    "WG00002".to_string(),
                    "电焊面罩".to_string(),
                    "D-01-02-4F".to_string(),
                    "0".to_string(),
                    "0".to_string(),
                    "0".to_string(),
                    "0".to_string(),
                ];
                for day in 1..=31 {
                    row.push(if day == 3 { "5".to_string() } else { String::new() });
                    row.push(if day == 4 { "8".to_string() } else { String::new() });
                }
                row
            },
        ];
        let head = rows.clone();
        let layout = crate::pivot::detect(&head).expect("应认出宽表");
        assert_eq!(layout.day_count(), 31);
        assert_eq!(layout.header_row, 1);
        assert_eq!(layout.loc_col, Some(3));

        // 宽表不带「日期」列，所以不会被误认成常规明细表
        let pairs: Vec<(String, String)> = guesses(&["序号", "物料编码", "名称", "现结存"])
            .iter()
            .filter_map(|h| h.field.clone().map(|f| (h.header.clone(), f)))
            .collect();
        assert!(!looks_like_detail(&pairs));
    }

    #[test]
    fn master_sheets_are_recognised_and_flow_sheets_are_not() {
        // 供应商名称表
        assert_eq!(
            master_sheet_kind("供应商名称", &guesses(&["序号", "供应商名称"])),
            Some("供应商表")
        );
        // 物料编号表：有编码列就算物料表（它也带「数量」列，不能被误判成流水）
        assert_eq!(
            master_sheet_kind(
                "物料编号",
                &guesses(&["物料类别", "物料名称", "单位", "数量", "单价", "物料编码序号"])
            ),
            Some("物料表")
        );
        // 基础信息表：只有名称/图号/类型，没有编码
        assert_eq!(
            master_sheet_kind("基础信息", &guesses(&["序号", "图号", "名称", "单位", "单价", "类型1"])),
            Some("基础信息表")
        );
        // 入库/出库明细：带送货单号、时间、领用人，属于流水，不是主数据
        assert_eq!(
            master_sheet_kind(
                "入库明细",
                &guesses(&["入库时间", "单据编号", "送货单号", "物料编码", "物料名称", "数量"])
            ),
            None
        );
        assert_eq!(
            master_sheet_kind(
                "出库明细",
                &guesses(&["日期", "出库单号", "物料编码", "物料名称", "单位", "数量", "领用人"])
            ),
            None
        );
        // 表名带「明细 / 库存 / 单据」一律不算主数据
        assert_eq!(master_sheet_kind("库存明细", &guesses(&["物料名称", "物料编码"])), None);
    }

    #[test]
    fn header_aliases_match_known_sheets() {
        assert_eq!(guess_field("入库时间").as_deref(), Some("doc_date"));
        assert_eq!(guess_field(" 日期 ").as_deref(), Some("doc_date"));
        assert_eq!(guess_field("出库单号").as_deref(), Some("doc_no"));
        assert_eq!(guess_field("单据编号").as_deref(), Some("doc_no"));
        assert_eq!(guess_field("合计").as_deref(), Some("amount"));
        assert_eq!(guess_field("供应商名称").as_deref(), Some("partner"));
        assert_eq!(guess_field("归属").as_deref(), Some("owner"));
        assert_eq!(guess_field("数量（个）").as_deref(), Some("qty"));
        assert_eq!(guess_field("辅助列"), None);
        assert_eq!(guess_field("库存数量"), None);
    }

    #[test]
    fn detail_detection_needs_date_qty_and_item() {
        let ok = vec![
            ("入库时间".to_string(), "doc_date".to_string()),
            ("数量".to_string(), "qty".to_string()),
            ("物料名称".to_string(), "item_name".to_string()),
        ];
        assert!(looks_like_detail(&ok));
        let missing_qty = vec![
            ("日期".to_string(), "doc_date".to_string()),
            ("物料名称".to_string(), "item_name".to_string()),
        ];
        assert!(!looks_like_detail(&missing_qty));
    }

    #[test]
    fn date_forms_converge() {
        assert_eq!(parse_date_text("2025/10/30"), "2025-10-30");
        assert_eq!(parse_date_text("2025-6-30"), "2025-06-30");
        assert_eq!(parse_date_text("2025年1月5日"), "2025-01-05");
        assert_eq!(parse_date_text("45759"), "2025-04-12");
        assert_eq!(parse_date_text("-"), "");
        assert_eq!(parse_date_text("上周"), "");
    }

    #[test]
    fn numbers_with_decorations() {
        assert_eq!(parse_number("1,234.50"), Some(1234.5));
        assert_eq!(parse_number("￥12"), Some(12.0));
        assert_eq!(parse_number("12元"), Some(12.0));
        assert_eq!(parse_number("abc"), None);
        assert_eq!(to_cents(0.1 + 0.2), 30);
    }

    #[test]
    fn kind_inference_prefers_sheet_name() {
        assert_eq!(infer_kind("入库明细", &[]), "in");
        assert_eq!(infer_kind("出库明细", &[]), "out");
        assert_eq!(infer_kind("Sheet4", &[]), "out");
    }

    fn sample_row() -> DraftRow {
        DraftRow {
            sheet: "入库明细".into(),
            row_no: 2,
            kind: "in".into(),
            doc_date: "2025-10-30".into(),
            doc_no: "20251030200".into(),
            item_code: "WG-WJ-0292".into(),
            item_name: "M10*80膨胀螺丝".into(),
            unit: "斤".into(),
            qty: Some(2.5),
            price_micros: Some(60_000),
            amount_cents: Some(1500),
            flags: vec!["no_code".into()],
            ..Default::default()
        }
    }

    fn header() -> HeaderRow {
        HeaderRow {
            file_name: "t.xlsm".into(),
            file_hash: "h1".into(),
            sheets_json: "[]".into(),
            imported_at: "2025-10-30 10:00:00".into(),
            row_count: 1,
            skipped_count: 0,
            note: None,
        }
    }

    #[test]
    fn write_rows_stores_flags_and_nulls() {
        let db = Db::open_in_memory().unwrap();
        let (id, replaced) = write_rows(&db, &header(), &[sample_row()], &[]).unwrap();
        assert!(id > 0);
        assert_eq!(replaced, 0);
        db.with(|c| {
            let (flags, partner): (String, Option<String>) = c
                .query_row("SELECT flags, partner FROM ledger LIMIT 1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(DbError::from)?;
            assert_eq!(flags, "no_code");
            assert!(partner.is_none());
            Ok(())
        })
        .unwrap();
    }

    /// 台账与基础资料同事务：物料写入失败时，台账那批也必须回滚。
    #[test]
    fn master_items_roll_back_with_ledger_on_failure() {
        let db = Db::open_in_memory().unwrap();

        // 正常路径：台账与物料一次调用一起落库
        let (_id, _replaced, counts) = write_rows_with_items(
            &db,
            &header(),
            &[sample_row()],
            &[],
            &[crate::pivot::PivotItemDef {
                item_code: "WG-NEW-1".into(),
                item_name: "新物料".into(),
                ..Default::default()
            }],
        )
        .unwrap();
        assert_eq!(counts, Some((1, 0)));

        // 失败路径：用触发器让物料写入在事务中途失败，台账那批也要一起回滚
        db.with(|c| {
            c.execute_batch(
                "CREATE TRIGGER t_block_items BEFORE INSERT ON items
                 BEGIN SELECT RAISE(ABORT, 'simulated item failure'); END;",
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();
        let mut second = header();
        second.file_hash = "h2".into();
        let err = write_rows_with_items(
            &db,
            &second,
            &[sample_row()],
            &[],
            &[crate::pivot::PivotItemDef {
                item_code: "WG-NEW-2".into(),
                item_name: "另一个物料".into(),
                ..Default::default()
            }],
        )
        .unwrap_err();
        assert!(err.contains("simulated item failure"), "{err}");
        let (rows_after, imports_after): (i64, i64) = db
            .with(|c| {
                Ok((
                    c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
                        .map_err(DbError::from)?,
                    c.query_row("SELECT COUNT(*) FROM imports", [], |r| r.get(0))
                        .map_err(DbError::from)?,
                ))
            })
            .unwrap();
        assert_eq!(rows_after, 1, "第二次导入的台账行必须回滚掉");
        assert_eq!(imports_after, 1, "导入批次记录也必须回滚");
    }

    #[test]
    fn replace_mode_clears_sheet_first() {
        let db = Db::open_in_memory().unwrap();
        write_rows(&db, &header(), &[sample_row(), sample_row()], &[]).unwrap();
        let (_id, replaced) = write_rows(&db, &header(), &[sample_row()], &["入库明细".to_string()]).unwrap();
        assert_eq!(replaced, 2);
        let count: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    /// 「覆盖同名表」只能覆盖同一个源工作簿的数据：
    /// 两个工作簿都有 `入库明细` 时，导第二个不能把第一个的明细删掉。
    #[test]
    fn replace_mode_is_scoped_to_same_workbook() {
        let db = Db::open_in_memory().unwrap();
        let mut first = header();
        first.file_name = "一月.xlsm".into();
        first.file_hash = "h-jan".into();
        let mut second = header();
        second.file_name = "二月.xlsm".into();
        second.file_hash = "h-feb".into();

        write_rows(&db, &first, &[sample_row(), sample_row()], &[]).unwrap();
        // 第二个工作簿覆盖同名表，不该动第一个工作簿的行
        let (_id, replaced) = write_rows(&db, &second, &[sample_row()], &["入库明细".to_string()]).unwrap();
        assert_eq!(replaced, 0, "别的批次没有同名表行可删");
        let count: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(count, 3, "1 月的两行必须还在");

        // 同一个工作簿再覆盖一次，才清掉它自己那批
        let (_id, replaced) = write_rows(&db, &second, &[sample_row()], &["入库明细".to_string()]).unwrap();
        assert_eq!(replaced, 1);
        let count: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(count, 3);
    }

    /// 覆盖后旧批次的 `row_count` 要跟着改，导入历史不能继续显示原来的行数。
    #[test]
    fn replace_mode_repairs_old_import_row_count() {
        let db = Db::open_in_memory().unwrap();
        write_rows(&db, &header(), &[sample_row(), sample_row(), sample_row()], &[]).unwrap();
        write_rows(&db, &header(), &[sample_row()], &["入库明细".to_string()]).unwrap();
        let rows = history(&db).unwrap();
        // 最新一条是本次导入（1 行），旧批次已被清空（0 行）
        assert_eq!(rows[0].row_count, 1);
        assert_eq!(rows[1].row_count, 0);
        assert_eq!(rows[1].live_rows, 0);
    }

    /// 同 hash 的文件默认拒绝，显式允许后才放行。
    #[test]
    fn duplicate_import_is_rejected_by_default() {
        let db = Db::open_in_memory().unwrap();
        write_rows(&db, &header(), &[sample_row()], &[]).unwrap();
        let existing = find_import_by_hash(&db, "h1").unwrap();
        assert_eq!(existing, Some(1));

        let err = ensure_not_duplicate(&db, "t.xlsm", existing, false).unwrap_err();
        assert!(err.contains("已经导入过"), "错误文案要说明原因，实际 {err}");
        assert!(err.contains("t.xlsm"));

        // 没有重复时放行
        assert!(ensure_not_duplicate(&db, "t.xlsm", None, false).is_ok());
        // 显式允许时放行
        assert!(ensure_not_duplicate(&db, "t.xlsm", existing, true).is_ok());
    }

    #[test]
    fn delete_import_cascades_rows() {
        let db = Db::open_in_memory().unwrap();
        let (id, _) = write_rows(&db, &header(), &[sample_row()], &[]).unwrap();
        let rows = history(&db).unwrap();
        assert_eq!(rows[0].live_rows, 1);
        delete_import(&db, id).unwrap();
        assert!(history(&db).unwrap().is_empty());
        let count: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}

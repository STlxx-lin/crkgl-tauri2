//! xlsm 导入：先看（inspect）→ 预览（preview）→ 落库（run）。
//!
//! 按实测的 `仓库出入库明细_5611_Modified.xlsm` 对齐：
//!   - `入库明细` 首行表头：入库时间/单据编号/送货单号/物料编码/物料名称/单位/数量/单价/合计/备注/供应商名称/采购人
//!   - `出库明细` 首行表头：日期/出库单号/物料编码/物料名称/单位/数量/备注/归属/领用人/采购人
//! 同一个文件里可以有多张明细表：sheet 名不同但表头能对上就一起导入。
//!
//! 只读源文件。公式单元格取 Excel 缓存值；没有缓存就当空处理并打提醒。

use std::collections::BTreeMap;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
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
    ("doc_date", &["入库时间", "日期", "入库日期", "出库时间", "出库日期", "发生日期", "单据日期"]),
    ("doc_no", &["单据编号", "入库单号", "出库单号", "单据号", "单号", "入库单", "出库单"]),
    ("delivery_no", &["送货单号", "送货单", "验收单号"]),
    ("item_code", &["物料编码", "编码", "物料编号", "物料编码序号", "图号"]),
    ("item_name", &["物料名称", "名称", "品名", "物料"]),
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
    if ["送货单号", "入库时间", "出库时间", "领用人", "采购人", "单号"].iter().any(|k| has(k)) {
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
        if names.iter().any(|n| *n == raw) {
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

fn cell_text(cell: &Data) -> String {
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

fn cell_float(cell: &Data) -> Option<f64> {
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
    (base + chrono::Days::new(days))
        .format("%Y-%m-%d")
        .to_string()
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
        .replace('年', "-")
        .replace('月', "-")
        .replace('日', "")
        .replace('.', "-")
        .replace('/', "-");
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
    pub note: String,
    pub headers: Vec<HeaderGuess>,
    /// 前 5 行原始值（截断到 20 列），给向导里看一眼
    pub sample: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookReport {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sheets: Vec<SheetReport>,
}

const SAMPLE_COLUMNS: usize = 20;

/// 读工作簿里所有 sheet，按首行表头猜字段，标出哪些是明细表。
pub fn inspect(path: &Path) -> Result<WorkbookReport, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到文件: {e}"))?;
    let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
    let names = book.sheet_names().to_vec();
    let mut sheets = Vec::new();
    for name in names {
        let range = match book.worksheet_range(&name) {
            Ok(r) => r,
            Err(err) => {
                sheets.push(SheetReport {
                    name,
                    rows: 0,
                    non_empty_rows: 0,
                    detail: false,
                    master: false,
                    note: format!("读取失败: {err}"),
                    headers: Vec::new(),
                    sample: Vec::new(),
                });
                continue;
            }
        };
        let total = range.height();
        let mut non_empty = 0usize;
        let mut sample: Vec<Vec<String>> = Vec::new();
        for (index, row) in range.rows().enumerate() {
            let texts: Vec<String> = row.iter().take(SAMPLE_COLUMNS).map(cell_text).collect();
            if row.iter().any(|c| !cell_text(c).is_empty()) {
                non_empty += 1;
            }
            if index < 5 {
                sample.push(texts);
            }
        }
        let headers: Vec<HeaderGuess> = range
            .rows()
            .next()
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
        let pairs: Vec<(String, String)> = headers
            .iter()
            .filter_map(|h| h.field.clone().map(|f| (h.header.clone(), f)))
            .collect();
        let detail = looks_like_detail(&pairs);
        let master_kind = if detail { None } else { master_sheet_kind(&name, &headers) };
        let note = if detail {
            format!("明细表：{} 行数据", non_empty.saturating_sub(1))
        } else if let Some(kind) = master_kind {
            format!("{kind}：{} 行，写入基础资料", non_empty.saturating_sub(1))
        } else if non_empty == 0 {
            "空表".to_string()
        } else {
            "不像明细表（缺日期/数量/物料列），不会导入".to_string()
        };
        sheets.push(SheetReport {
            name,
            rows: total,
            non_empty_rows: non_empty,
            detail,
            master: master_kind.is_some(),
            note,
            headers,
            sample,
        });
    }
    Ok(WorkbookReport {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size_bytes: meta.len(),
        sheets,
    })
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
    let field_col: Vec<(&str, usize)> = mapping
        .iter()
        .filter(|(_, f)| !f.is_empty() && f.as_str() != "unused")
        .map(|(column, field)| (field.as_str(), *column))
        .collect();

    let mut rows_out: Vec<DraftRow> = Vec::new();
    let mut issues: Vec<Issue> = Vec::new();
    let mut skipped = 0usize;

    for (index, row) in range.rows().enumerate() {
        if index == 0 {
            continue; // 表头
        }
        let row_no = (index + 1) as u64;
        let get = |field: &str| -> Option<&Data> {
            field_col
                .iter()
                .find(|(f, _)| *f == field)
                .and_then(|(_, column)| row.get(*column))
        };
        let text = |field: &str| -> String { get(field).map(cell_text).unwrap_or_default() };

        let date_raw = text("doc_date");
        let code = text("item_code");
        let name = text("item_name");
        let qty_raw = get("qty").and_then(cell_float);
        let qty_text = get("qty").map(cell_text).unwrap_or_default();

        // 整行空：跳过但不算问题
        if date_raw.is_empty()
            && code.is_empty()
            && name.is_empty()
            && qty_text.is_empty()
            && text("amount").is_empty()
            && text("doc_no").is_empty()
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
        let price = get("price").and_then(cell_float).map(to_micros);
        let amount = get("amount").and_then(cell_float).map(to_cents);
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
            doc_no: text("doc_no"),
            delivery_no: text("delivery_no"),
            item_code: code,
            item_name: name,
            unit: text("unit"),
            qty: qty_raw,
            price_micros: price,
            amount_cents: amount,
            remark: text("remark"),
            partner: text("partner"),
            buyer: text("buyer"),
            owner: text("owner"),
            receiver: text("receiver"),
            flags,
        });
    }

    Ok(ParsedSheet {
        name: sheet.to_string(),
        rows: rows_out,
        issues,
        skipped,
    })
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPlan {
    pub name: String,
    pub mapping: ColumnMap,
    /// `replace` = 先删这张表的旧行再导；`append` = 追加
    #[serde(default)]
    pub mode: Option<String>,
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
        return Err("这个工作簿里没找到能识别的明细表（需要同时有日期、数量、物料列）。可以手动指定列映射后再试。".to_string());
    }
    Ok(plans)
}

pub fn preview(path: &Path, plans: Option<Vec<SheetPlan>>, sample_limit: usize) -> Result<PreviewResult, String> {
    let report = inspect(path)?;
    let plans = plan_for(&report, plans)?;
    let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
    let mut total_rows = 0usize;
    let mut total_issues = 0usize;
    let mut flagged_rows = 0usize;
    let mut sheets = Vec::new();
    for plan in &plans {
        let parsed = parse_sheet(&mut book, &plan.name, &plan.mapping)?;
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
        });
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
pub fn write_rows(
    db: &Db,
    header: &HeaderRow,
    rows: &[DraftRow],
    replace_sheets: &[String],
) -> Result<(i64, usize), String> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction().map_err(DbError::from)?;
        let mut replaced = 0usize;
        for sheet in replace_sheets {
            replaced += tx
                .execute("DELETE FROM ledger WHERE sheet = ?1", [sheet])
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
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO ledger (import_id, sheet, row_no, kind, doc_date, doc_no, delivery_no,
                        item_code, item_name, unit, qty, price_micros, amount_cents, remark,
                        partner, buyer, owner, receiver, flags)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                )
                .map_err(DbError::from)?;
            for row in rows {
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
                    null_if_empty(&row.unit),
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
        tx.commit().map_err(DbError::from)?;
        Ok((import_id, replaced))
    })
}

/// 完整导入：读文件 → 解析 → 写库。
pub fn run(
    db: &Db,
    path: &Path,
    plans: Option<Vec<SheetPlan>>,
    replace_all: bool,
) -> Result<ImportOutcome, String> {
    let report = inspect(path)?;
    let plans = plan_for(&report, plans)?;
    let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;

    let mut parsed_sheets = Vec::new();
    for plan in &plans {
        parsed_sheets.push(parse_sheet(&mut book, &plan.name, &plan.mapping)?);
    }

    let mut all_rows: Vec<DraftRow> = Vec::new();
    let mut all_issues: Vec<Issue> = Vec::new();
    let mut summaries: Vec<SheetSummary> = Vec::new();
    let mut replace_sheets: Vec<String> = Vec::new();

    for (plan, parsed) in plans.iter().zip(parsed_sheets.iter()) {
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
        let mode = plan.mode.as_deref().unwrap_or("append");
        if replace_all || mode == "replace" {
            replace_sheets.push(parsed.name.clone());
        }
    }

    let skipped: usize = parsed_sheets.iter().map(|p| p.skipped).sum();
    let flagged = all_rows.iter().filter(|r| !r.flags.is_empty()).count();
    let hash = file_hash(path)?;
    let duplicate_of = find_import_by_hash(db, &hash)?;
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
    let (import_id, replaced) = write_rows(db, &header, &all_rows, &replace_sheets)?;
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
        // 基础资料由命令层单独调用 master 模块补进来
        master: None,
        master_error: None,
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
        assert_eq!(
            master_sheet_kind("库存明细", &guesses(&["物料名称", "物料编码"])),
            None
        );
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

    #[test]
    fn replace_mode_clears_sheet_first() {
        let db = Db::open_in_memory().unwrap();
        write_rows(&db, &header(), &[sample_row(), sample_row()], &[]).unwrap();
        let (_id, replaced) = write_rows(&db, &header(), &[sample_row()], &["入库明细".to_string()]).unwrap();
        assert_eq!(replaced, 2);
        let count: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0)).map_err(DbError::from))
            .unwrap();
        assert_eq!(count, 1);
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
            .with(|c| c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0)).map_err(DbError::from))
            .unwrap();
        assert_eq!(count, 0);
    }
}

//! 月度「库存进销存报表」宽表 → 台账流水。
//!
//! 认的表长这样（12 张月度表共用一套版式，`仓库进销存-外购件.xlsx` 就是它）：
//!
//! ```text
//! 行1  (空) | 1 月 库  存  进  销  存  报  表
//! 行2  序号 | 物料编码 | 名称 | 库位 | 规格型号 | 上月结存 | 本月入库 | 本月出库 | 现结存 | 1日 || 2日 || …
//! 行3  (空) | …                                                                     | 入库|出库| 入库|出库| …
//! 行4  1 | WG00002 | 电焊面罩 | D-01-02-4F | 5*5 | 0 | 0 | 0 | 0 | …
//! ```
//!
//! 与「入库明细 / 出库明细」那种一行一笔的流水表不同，这里是**一行一物料**、
//! 逐日两列（入库 / 出库）的宽表。按月整表导会丢掉日期，所以这里把网格拆成
//! 台账能吃的流水行。
//!
//! ## 拆行口径
//!
//! 1. 最早那张月的「上月结存」→ 期初，记一行 `期初结存`；
//! 2. 每天的非零格子 → 一行流水，日期 `YYYY-MM-DD`；
//! 3. 「本月入库 / 本月出库」与逐日合计的差 → 月末补一行 `月末补差`
//!    （源表有 4 处这列填了数、日格没填）；
//! 4. 「盘点差异数调整」的入库 / 出库对 → 月末 `盘点调整`；
//! 5. 上面几步算出的结存与「现结存」仍不一致的，月末补一行 `结存校正`。
//!
//! 第 5 步是必要的：源表自己有内部矛盾（WG01268 / WG01269 两行结存互换、
//! WG01456 全年有出无入却被清零），不校正会有 11 个物料到年底对不上。
//! 校正行在备注里写明来由，不静默改数。

use std::collections::BTreeMap;

use calamine::Data;
use rusqlite::Connection;
use serde::Serialize;

use crate::db::{DbError, DbResult};
use crate::import::{cell_float, cell_text, DraftRow};

/// 判定「两个数量相等」的容差。源表数量都是整数，1e-9 足够严。
const EPS: f64 = 1e-9;

/// 宽表版式：各字段落在第几列。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotLayout {
    /// 表头所在行（0 基）。这套表在第 2 行（索引 1）。
    pub header_row: usize,
    pub code_col: Option<usize>,
    pub name_col: Option<usize>,
    pub loc_col: Option<usize>,
    pub spec_col: Option<usize>,
    pub unit_col: Option<usize>,
    pub open_col: Option<usize>,
    pub in_col: Option<usize>,
    pub out_col: Option<usize>,
    pub close_col: Option<usize>,
    pub check_col: Option<usize>,
    pub diff_col: Option<usize>,
    /// 「盘点差异数调整」的两个子列：入库 / 出库
    pub adj_in_col: Option<usize>,
    pub adj_out_col: Option<usize>,
    /// 日 → 该日「入库」列序号；出库在 `+1`。
    pub days: BTreeMap<u32, usize>,
}

impl PivotLayout {
    pub fn day_count(&self) -> usize {
        self.days.len()
    }
}

/// 去掉空白与全角空格，便于比表头。
fn norm(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
        .collect()
}

fn find_col(header: &[String], exact: &[&str]) -> Option<usize> {
    header
        .iter()
        .position(|cell| exact.iter().any(|want| *cell == *want))
}

/// 「盘点差异数调整」这一列：表头写法不统一（有的中间还夹个「数」字），
/// 不能整词匹配，只能同时要求「调整」和「盘点/差异」。
fn find_adjust_col(header: &[String]) -> Option<usize> {
    header.iter().position(|cell| {
        cell.contains("调整") && (cell.contains("盘点") || cell.contains("差异"))
    })
}

/// 从头部若干行猜版式。认不出返回 `None`。
///
/// 判据：有「名称」列；有「上月结存」或「现结存」；至少 20 个「N日」日列。
/// 最后一条很关键——单月的出入库明细表不会有逐日网格。
pub fn detect(rows: &[Vec<String>]) -> Option<PivotLayout> {
    for (header_row, raw) in rows.iter().take(6).enumerate() {
        let header: Vec<String> = raw.iter().map(|c| norm(c)).collect();
        let Some(name_col) = find_col(&header, &["名称", "物料名称", "品名"]) else {
            continue;
        };
        let close_col = find_col(&header, &["现结存", "本期结存", "月末结存"]);
        let open_col = find_col(&header, &["上月结存", "期初结存", "上期结存"]);
        if close_col.is_none() && open_col.is_none() {
            continue;
        }

        let mut days: BTreeMap<u32, usize> = BTreeMap::new();
        for (index, cell) in header.iter().enumerate() {
            let Some(day_text) = cell.strip_suffix('日') else {
                continue;
            };
            if day_text.is_empty() || !day_text.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if let Ok(day) = day_text.parse::<u32>() {
                if (1..=31).contains(&day) {
                    days.insert(day, index);
                }
            }
        }
        if days.len() < 20 {
            continue;
        }

        // 11 月那页的「物料编码」表头被删过，用「名称」左边一格兜底。
        let code_col = find_col(&header, &["物料编码", "编码", "物料编号", "物料号"])
            .or_else(|| name_col.checked_sub(1));
        let adj_in_col = find_adjust_col(&header);

        let layout = PivotLayout {
            header_row,
            code_col,
            name_col: Some(name_col),
            loc_col: find_col(&header, &["库位", "货位", "仓位"]),
            spec_col: find_col(&header, &["规格型号", "规格", "型号"]),
            unit_col: find_col(&header, &["单位", "计量单位"]),
            open_col,
            in_col: find_col(&header, &["本月入库", "本期入库", "入库"]),
            out_col: find_col(&header, &["本月出库", "本期出库", "出库"]),
            close_col,
            check_col: find_col(&header, &["本月盘点数", "盘点数"]),
            diff_col: find_col(&header, &["盘点差异数", "盘点差异"]),
            adj_in_col,
            adj_out_col: adj_in_col.map(|c| c + 1),
            days,
        };
        if layout.in_col.is_none() && layout.out_col.is_none() {
            continue;
        }
        return Some(layout);
    }
    None
}

/// 一个物料在某个月的宽表行。
#[derive(Debug, Clone, Default)]
pub struct PivotItem {
    pub row_no: u64,
    pub code: String,
    pub name: String,
    pub location: String,
    pub spec: String,
    pub unit: String,
    pub opening: Option<f64>,
    pub in_total: Option<f64>,
    pub out_total: Option<f64>,
    pub closing: Option<f64>,
    pub checked: Option<f64>,
    pub diff: Option<f64>,
    pub adj_in: Option<f64>,
    pub adj_out: Option<f64>,
    /// (日, 入库量, 出库量)
    pub days: Vec<(u32, Option<f64>, Option<f64>)>,
}

impl PivotItem {
    fn daily_in(&self) -> f64 {
        self.days.iter().filter_map(|(_, i, _)| *i).sum()
    }
    fn daily_out(&self) -> f64 {
        self.days.iter().filter_map(|(_, _, o)| *o).sum()
    }
}

/// 一张月度宽表的解析结果。
#[derive(Debug, Clone, Default)]
pub struct PivotSheet {
    pub name: String,
    /// 从表名认出的月份（1-12）；认不出就是 None，那张表会跳过。
    pub month: Option<u32>,
    /// 逐日网格的天数（通常 28~31）。
    pub day_count: usize,
    pub items: Vec<PivotItem>,
    /// 尾部「编码 = 0 / 空」的填充行，不算错，只是不导
    pub filler_rows: usize,
    /// 有编码但名称是 0 / 空的行
    pub nameless_rows: usize,
    pub issues: Vec<String>,
}

/// 「1月」「12 月」「1 月 库  存  进  销  存  报  表」→ Some(1)。
pub fn month_from_text(text: &str) -> Option<u32> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace() && *c != '\u{3000}').collect();
    let head = compact.split('库').next().unwrap_or(&compact);
    if !head.contains('月') {
        return None;
    }
    let digits: String = head.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok().filter(|m| (1..=12).contains(m))
}

fn cell_at(row: &[Data], index: Option<usize>) -> String {
    index
        .and_then(|i| row.get(i))
        .map(cell_text)
        .unwrap_or_default()
}

fn num_at(row: &[Data], index: Option<usize>) -> Option<f64> {
    let value = index.and_then(|i| row.get(i))?;
    match cell_float(value) {
        Some(v) if v.is_finite() => Some(v),
        _ => None,
    }
}

fn is_filler(code: &str) -> bool {
    let code = code.trim();
    code.is_empty() || code == "0" || code == "-"
}

/// 快速判断单元格是否为空或 `0`/`-` 填充值，避免对每张表数千行填充行分配 `String`。
fn is_filler_cell(row: &[Data], index: Option<usize>) -> bool {
    let Some(cell) = index.and_then(|i| row.get(i)) else {
        return true;
    };
    match cell {
        Data::Empty => true,
        Data::Float(f) => *f == 0.0,
        Data::Int(0) => true,
        Data::String(s) => is_filler(s),
        _ => false,
    }
}

/// 解析一张宽表。`sheet_name` 只用来认月份。
pub fn read_sheet(sheet_name: &str, rows: &[&[Data]]) -> Option<PivotSheet> {
    let head: Vec<Vec<String>> = rows
        .iter()
        .take(6)
        .map(|row| row.iter().map(cell_text).collect())
        .collect();
    let layout = detect(&head)?;

    let mut sheet = PivotSheet {
        name: sheet_name.to_string(),
        month: month_from_text(sheet_name),
        day_count: layout.day_count(),
        ..Default::default()
    };
    if sheet.month.is_none() {
        sheet.issues.push("表名认不出月份（应为「1月」~「12月」），这张表跳过".into());
        return Some(sheet);
    }

    // 数据从表头下一行开始；紧跟着的「入库 / 出库」子表头要跳过。
    let first_day_col = layout.days.values().next().copied();
    let subheader_row = layout.header_row + 1;
    for (index, row) in rows.iter().enumerate().skip(subheader_row) {
        let row_no = (index + 1) as u64;
        if index == subheader_row {
            if let Some(col) = first_day_col {
                if cell_at(row, Some(col)) == "入库" {
                    continue; // 子表头
                }
            }
        }

        if is_filler_cell(row, layout.code_col) {
            if is_filler_cell(row, layout.name_col) {
                // 尾部几千行「编码=0、名称=0」的模板填充行，零分配直接跳过
                sheet.filler_rows += 1;
                continue;
            }
            let name = cell_at(row, layout.name_col);
            if is_filler(&name) {
                sheet.filler_rows += 1;
                continue;
            }
            // 名称是真的但没有编码：不能当流水，提醒一句
            sheet.issues.push(format!(
                "第 {row_no} 行「{name}」没有物料编码，跳过（不计入结存）"
            ));
            continue;
        }

        let code = cell_at(row, layout.code_col);
        let name = if is_filler_cell(row, layout.name_col) {
            String::new()
        } else {
            cell_at(row, layout.name_col)
        };
        if is_filler(&name) {
            sheet.nameless_rows += 1;
        }

        let mut days = Vec::new();
        for (day, col) in &layout.days {
            let in_qty = num_at(row, Some(*col));
            let out_qty = num_at(row, Some(col + 1));
            if in_qty.unwrap_or(0.0) != 0.0 || out_qty.unwrap_or(0.0) != 0.0 {
                days.push((*day, in_qty, out_qty));
            }
        }

        let location = if is_filler_cell(row, layout.loc_col) {
            String::new()
        } else {
            cell_at(row, layout.loc_col)
        };
        let spec = if is_filler_cell(row, layout.spec_col) {
            String::new()
        } else {
            cell_at(row, layout.spec_col)
        };
        let unit = if is_filler_cell(row, layout.unit_col) {
            String::new()
        } else {
            cell_at(row, layout.unit_col)
        };

        sheet.items.push(PivotItem {
            row_no,
            code: code.trim().to_string(),
            name: if is_filler(&name) { String::new() } else { name.trim().to_string() },
            location: if is_filler(&location) { String::new() } else { location.trim().to_string() },
            spec: if is_filler(&spec) { String::new() } else { spec.trim().to_string() },
            unit: if is_filler(&unit) { String::new() } else { unit.trim().to_string() },
            opening: num_at(row, layout.open_col),
            in_total: num_at(row, layout.in_col),
            out_total: num_at(row, layout.out_col),
            closing: num_at(row, layout.close_col),
            checked: num_at(row, layout.check_col),
            diff: num_at(row, layout.diff_col),
            adj_in: num_at(row, layout.adj_in_col),
            adj_out: num_at(row, layout.adj_out_col),
            days,
        });
    }

    Some(sheet)
}

/// 进主数据用的一条物料。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotItemDef {
    pub item_code: String,
    pub item_name: String,
    pub spec: Option<String>,
    pub unit: Option<String>,
    pub location: Option<String>,
    pub item_type: Option<String>,
}

/// 从文件名或物料编码前缀推断物料类型（如「外购件」「加工件」）。
pub fn infer_item_type(code: &str, file_hint: Option<&str>) -> Option<String> {
    if let Some(hint) = file_hint {
        for kind in ["外购件", "加工件", "标准件", "原材料", "辅料"] {
            if hint.contains(kind) {
                return Some(kind.to_string());
            }
        }
    }
    let upper = code.trim().to_ascii_uppercase();
    if upper.starts_with("WG") {
        Some("外购件".to_string())
    } else if upper.starts_with("JG") {
        Some("加工件".to_string())
    } else {
        None
    }
}

/// 宽表拆成流水的结果。
#[derive(Debug, Clone, Default)]
pub struct PivotBuild {
    pub rows: Vec<DraftRow>,
    pub items: Vec<PivotItemDef>,
    pub issues: Vec<String>,
    pub months: Vec<u32>,
    pub opening_rows: usize,
    pub daily_rows: usize,
    pub residual_rows: usize,
    pub adjust_rows: usize,
    pub correction_rows: usize,
    pub filler_rows: usize,
    pub nameless_rows: usize,
    /// 校正明细：给预览面板列出来，让用户知道哪几笔是补的
    pub corrections: Vec<String>,
}

/// 该月最后一天。用 chrono 算，闰年自动正确。
fn last_day(year: i32, month: u32) -> u32 {
    let first_next = if month == 12 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    match first_next {
        Some(next) => (next - chrono::Days::new(1)).day(),
        // 年份越界这类极端情况：按 31 天兜底，比少算一天更安全
        None => 31,
    }
}

use chrono::Datelike;

fn date_of(year: i32, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

fn push_row(
    out: &mut Vec<DraftRow>,
    sheet: &str,
    item: &PivotItem,
    def: Option<&PivotItemDef>,
    kind: &str,
    date: String,
    doc_no: String,
    qty: f64,
    remark: String,
) {
    let item_name = if !item.name.is_empty() {
        item.name.clone()
    } else if let Some(d) = def {
        d.item_name.clone()
    } else {
        item.code.clone()
    };
    let unit = if !item.unit.is_empty() {
        item.unit.clone()
    } else {
        def.and_then(|d| d.unit.clone()).unwrap_or_default()
    };
    let spec = if !item.spec.is_empty() {
        item.spec.clone()
    } else {
        def.and_then(|d| d.spec.clone()).unwrap_or_default()
    };
    let location = if !item.location.is_empty() {
        item.location.clone()
    } else {
        def.and_then(|d| d.location.clone()).unwrap_or_default()
    };
    out.push(DraftRow {
        sheet: sheet.to_string(),
        row_no: item.row_no,
        kind: kind.to_string(),
        doc_date: date,
        doc_no,
        item_code: item.code.clone(),
        item_name,
        location,
        spec,
        unit,
        qty: Some(qty),
        price_micros: None,
        amount_cents: None,
        remark,
        ..Default::default()
    });
}

/// 把若干张月度宽表拆成流水。
///
/// `year` 是这些月度表所属的年份——源表里没有年份，必须由用户指定。
pub fn build(sheets: &[PivotSheet], year: i32) -> PivotBuild {
    build_with_hint(sheets, year, None)
}

/// 带文件名提示地把月度宽表拆成流水（文件名可用于推断「外购件」等物料类型）。
pub fn build_with_hint(sheets: &[PivotSheet], year: i32, file_hint: Option<&str>) -> PivotBuild {
    let mut build = PivotBuild::default();
    let mut ordered: Vec<&PivotSheet> = sheets
        .iter()
        .filter(|s| s.month.is_some() && !s.items.is_empty())
        .collect();
    ordered.sort_by_key(|s| s.month);

    for sheet in &ordered {
        if !build.months.contains(&sheet.month.unwrap_or(0)) {
            build.months.push(sheet.month.unwrap_or(0));
        }
        build.filler_rows += sheet.filler_rows;
        build.nameless_rows += sheet.nameless_rows;
        build.issues.extend(sheet.issues.iter().cloned());
    }
    if ordered.is_empty() {
        return build;
    }

    // 物料字典：编码 → 名称/规格/单位/库位/类型，跨 1~12 月取第一次非空的写法
    // （源表 2~12 月没有「单位」列，通过这里汇总后回填给全年流水）
    let mut defs: BTreeMap<String, PivotItemDef> = BTreeMap::new();
    for sheet in &ordered {
        for item in &sheet.items {
            let entry = defs.entry(item.code.clone()).or_insert_with(|| PivotItemDef {
                item_code: item.code.clone(),
                item_name: item.code.clone(),
                spec: None,
                unit: None,
                location: None,
                item_type: infer_item_type(&item.code, file_hint),
            });
            if entry.item_name == entry.item_code && !item.name.is_empty() {
                entry.item_name = item.name.clone();
            }
            if entry.spec.is_none() && !item.spec.is_empty() {
                entry.spec = Some(item.spec.clone());
            }
            if entry.unit.is_none() && !item.unit.is_empty() {
                entry.unit = Some(item.unit.clone());
            }
            if entry.location.is_none() && !item.location.is_empty() {
                entry.location = Some(item.location.clone());
            }
        }
    }

    // 期初取最早那张月的「上月结存」
    let mut stock: BTreeMap<String, f64> = BTreeMap::new();
    let first = ordered[0];
    let first_month = first.month.unwrap_or(1);
    for item in &first.items {
        if let Some(opening) = item.opening.filter(|v| v.abs() > EPS) {
            let def = defs.get(&item.code);
            push_row(
                &mut build.rows,
                &first.name,
                item,
                def,
                "in",
                date_of(year, first_month, 1),
                format!("{year}QC"),
                opening,
                "期初结存（源表「上月结存」）".to_string(),
            );
            *stock.entry(item.code.clone()).or_insert(0.0) += opening;
            build.opening_rows += 1;
        }
    }

    for sheet in &ordered {
        let month = sheet.month.unwrap_or(1);
        let month_last = last_day(year, month);
        let doc_daily = format!("{year}{month:02}");
        for item in &sheet.items {
            let def = defs.get(&item.code);
            let running = stock.entry(item.code.clone()).or_insert(0.0);

            // 1) 逐日流水
            for (day, in_qty, out_qty) in &item.days {
                if let Some(qty) = in_qty.filter(|v| v.abs() > EPS) {
                    push_row(
                        &mut build.rows,
                        &sheet.name,
                        item,
                        def,
                        "in",
                        date_of(year, month, *day),
                        doc_daily.clone(),
                        qty,
                        format!("{month}月进销存 {day}日入库"),
                    );
                    *running += qty;
                    build.daily_rows += 1;
                }
                if let Some(qty) = out_qty.filter(|v| v.abs() > EPS) {
                    push_row(
                        &mut build.rows,
                        &sheet.name,
                        item,
                        def,
                        "out",
                        date_of(year, month, *day),
                        doc_daily.clone(),
                        qty,
                        format!("{month}月进销存 {day}日出库"),
                    );
                    *running -= qty;
                    build.daily_rows += 1;
                }
            }

            // 2) 本月入库/出库 与逐日合计的差
            //
            // 注意「本月入库」里可能已经把盘点调整算进去了（源表的公式就是
            // 逐日合计 + 调整）。这时差额恰好等于调整量，剥出来后单独记，
            // 否则同一次调整会被记两遍。
            if let Some(total) = item.in_total {
                let mut residual = total - item.daily_in();
                if let Some(adj) = item.adj_in.filter(|v| v.abs() > EPS) {
                    if (residual - adj).abs() <= EPS {
                        residual = 0.0;
                    }
                }
                if residual.abs() > EPS {
                    push_row(
                        &mut build.rows,
                        &sheet.name,
                        item,
                        def,
                        "in",
                        date_of(year, month, month_last),
                        format!("{year}{month:02}BC"),
                        residual,
                        format!("月末补差：源表本月入库 {total}，逐日合计 {}", item.daily_in()),
                    );
                    *running += residual;
                    build.residual_rows += 1;
                }
            }
            if let Some(total) = item.out_total {
                let mut residual = total - item.daily_out();
                if let Some(adj) = item.adj_out.filter(|v| v.abs() > EPS) {
                    if (residual - adj).abs() <= EPS {
                        residual = 0.0;
                    }
                }
                if residual.abs() > EPS {
                    push_row(
                        &mut build.rows,
                        &sheet.name,
                        item,
                        def,
                        "out",
                        date_of(year, month, month_last),
                        format!("{year}{month:02}BC"),
                        residual,
                        format!("月末补差：源表本月出库 {total}，逐日合计 {}", item.daily_out()),
                    );
                    *running -= residual;
                    build.residual_rows += 1;
                }
            }

            // 3) 盘点差异调整
            if let Some(qty) = item.adj_in.filter(|v| v.abs() > EPS) {
                push_row(
                    &mut build.rows,
                    &sheet.name,
                    item,
                    def,
                    "in",
                    date_of(year, month, month_last),
                    format!("{year}{month:02}PD"),
                    qty,
                    "盘点调整（源表「盘点差异数调整」入库）".to_string(),
                );
                *running += qty;
                build.adjust_rows += 1;
            }
            if let Some(qty) = item.adj_out.filter(|v| v.abs() > EPS) {
                push_row(
                    &mut build.rows,
                    &sheet.name,
                    item,
                    def,
                    "out",
                    date_of(year, month, month_last),
                    format!("{year}{month:02}PD"),
                    qty,
                    "盘点调整（源表「盘点差异数调整」出库）".to_string(),
                );
                *running -= qty;
                build.adjust_rows += 1;
            }

            // 4) 与「现结存」对齐
            if let Some(closing) = item.closing {
                let delta = closing - *running;
                if delta.abs() > EPS {
                    let kind = if delta > 0.0 { "in" } else { "out" };
                    let qty = delta.abs();
                    push_row(
                        &mut build.rows,
                        &sheet.name,
                        item,
                        def,
                        kind,
                        date_of(year, month, month_last),
                        format!("{year}{month:02}JZ"),
                        qty,
                        format!(
                            "结存校正：源表现结存 {closing}，台账算出 {}",
                            crate::ledger::trim_float(*running)
                        ),
                    );
                    *running = closing;
                    build.correction_rows += 1;
                    if build.corrections.len() < 30 {
                        let resolved_name = if !item.name.is_empty() {
                            item.name.as_str()
                        } else if let Some(d) = def.filter(|d| d.item_name != d.item_code) {
                            d.item_name.as_str()
                        } else {
                            "（无名称）"
                        };
                        build.corrections.push(format!(
                            "{month}月 {} {} {} {}",
                            item.code,
                            resolved_name,
                            if kind == "in" { "补入库" } else { "补出库" },
                            crate::ledger::trim_float(qty)
                        ));
                    }
                }
            }
        }
    }

    build.items = defs.into_values().collect();
    build
}

/// 物料写进基础资料（主数据）。已有编码只补空字段，不覆盖用户填过的。
///
/// 返回 `(新增, 更新)`。
pub fn upsert_items(conn: &Connection, items: &[PivotItemDef]) -> DbResult<(usize, usize)> {
    let tx = conn.unchecked_transaction().map_err(|e| DbError::from(e).0)?;
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut dict_counts: std::collections::HashMap<(&'static str, String), i64> =
        std::collections::HashMap::new();

    // 先查再写：内存预查已有编码，避免对成千上万物料逐行 round-trip SELECT
    {
        let mut existing_codes: std::collections::HashSet<String> = {
            let mut stmt = tx
                .prepare("SELECT item_code FROM items")
                .map_err(|e| DbError::from(e).0)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| DbError::from(e).0)?;
            rows.filter_map(Result::ok).collect()
        };

        let mut insert = tx
            .prepare(
                "INSERT INTO items (item_code, item_name, spec, unit, location, item_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| DbError::from(e).0)?;
        // 只填空字段：用户手填的规格/单位/库位/类型优先级更高
        let mut update = tx
            .prepare(
                "UPDATE items SET
                    item_name = CASE
                        WHEN TRIM(COALESCE(item_name, '')) = '' OR item_name = item_code
                        THEN COALESCE(NULLIF(TRIM(?2), ''), item_name)
                        ELSE item_name END,
                    spec      = COALESCE(NULLIF(TRIM(spec), ''), NULLIF(TRIM(?3), '')),
                    unit      = COALESCE(NULLIF(TRIM(unit), ''), NULLIF(TRIM(?4), '')),
                    location  = COALESCE(NULLIF(TRIM(location), ''), NULLIF(TRIM(?5), '')),
                    item_type = COALESCE(NULLIF(TRIM(item_type), ''), NULLIF(TRIM(?6), '')),
                    updated_at = datetime('now', 'localtime')
                 WHERE item_code = ?1",
            )
            .map_err(|e| DbError::from(e).0)?;

        for item in items {
            let code = item.item_code.trim();
            if code.is_empty() {
                continue;
            }
            let name = if item.item_name.trim().is_empty() {
                code.to_string()
            } else {
                item.item_name.clone()
            };
            let item_type = item
                .item_type
                .clone()
                .or_else(|| infer_item_type(code, None));

            if existing_codes.contains(code) {
                update
                    .execute(rusqlite::params![
                        code,
                        name,
                        item.spec,
                        item.unit,
                        item.location,
                        item_type
                    ])
                    .map_err(|e| DbError::from(e).0)?;
                updated += 1;
            } else {
                insert
                    .execute(rusqlite::params![
                        code,
                        name,
                        item.spec,
                        item.unit,
                        item.location,
                        item_type
                    ])
                    .map_err(|e| DbError::from(e).0)?;
                existing_codes.insert(code.to_string());
                added += 1;
            }

            if let Some(u) = item.unit.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                *dict_counts.entry(("unit", u.to_string())).or_insert(0) += 1;
            }
            if let Some(t) = item_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                *dict_counts.entry(("item_type", t.to_string())).or_insert(0) += 1;
            }
        }
    }

    crate::dict::touch_many(&tx, dict_counts.iter().map(|((k, v), c)| (*k, v.as_str(), *c)));
    tx.commit().map_err(|e| DbError::from(e).0)?;
    Ok((added, updated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_row() -> Vec<String> {
        let mut row = vec![
            "序号".into(),
            "物料编码".into(),
            "名称".into(),
            "库位".into(),
            "规格型号".into(),
            "上月结存".into(),
            "本月入库".into(),
            "本月出库".into(),
            "现结存".into(),
        ];
        for day in 1..=31 {
            row.push(format!("{day}日"));
            row.push(String::new());
        }
        row
    }

    #[test]
    fn month_forms() {
        assert_eq!(month_from_text("1月"), Some(1));
        assert_eq!(month_from_text("12月"), Some(12));
        assert_eq!(month_from_text("1 月 库  存  进  销  存  报  表"), Some(1));
        assert_eq!(month_from_text("主页"), None);
        assert_eq!(month_from_text("13月"), None);
    }

    #[test]
    fn detects_wide_pivot_layout() {
        let rows = vec![
            vec!["".to_string(), "1 月 库  存  进  销  存  报  表".to_string()],
            header_row(),
        ];
        let layout = detect(&rows).expect("should detect");
        assert_eq!(layout.header_row, 1);
        assert_eq!(layout.code_col, Some(1));
        assert_eq!(layout.name_col, Some(2));
        assert_eq!(layout.loc_col, Some(3));
        assert_eq!(layout.spec_col, Some(4));
        assert_eq!(layout.open_col, Some(5));
        assert_eq!(layout.in_col, Some(6));
        assert_eq!(layout.out_col, Some(7));
        assert_eq!(layout.close_col, Some(8));
        assert_eq!(layout.day_count(), 31);
        assert_eq!(layout.days.get(&1), Some(&9));
        assert_eq!(layout.days.get(&31), Some(&69));
    }

    #[test]
    fn narrow_flow_sheet_is_not_a_pivot() {
        // 入库明细这类一行一笔的表没有逐日网格，不能被认成宽表
        let rows = vec![vec![
            "入库时间".to_string(),
            "单据编号".to_string(),
            "物料编码".to_string(),
            "物料名称".to_string(),
            "数量".to_string(),
        ]];
        assert!(detect(&rows).is_none());
    }

    #[test]
    fn month_end_days() {
        assert_eq!(last_day(2026, 1), 31);
        assert_eq!(last_day(2026, 2), 28);
        assert_eq!(last_day(2024, 2), 29);
        assert_eq!(last_day(2026, 4), 30);
        assert_eq!(last_day(2026, 12), 31);
    }

    /// 造一张最小宽表：一行物料，日格用 `(日, 入, 出)` 指定。
    fn sheet_of(month: &str, items: Vec<(&str, &str, Option<f64>, Option<f64>, Vec<(u32, f64, f64)>)>) -> PivotSheet {
        PivotSheet {
            name: month.to_string(),
            month: month_from_text(month),
            items: items
                .into_iter()
                .map(|(code, name, opening, closing, days)| PivotItem {
                    row_no: 4,
                    code: code.to_string(),
                    name: name.to_string(),
                    opening,
                    closing,
                    days: days
                        .into_iter()
                        .map(|(d, i, o)| (d, Some(i), Some(o)))
                        .collect(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn build_splits_opening_daily_and_closing() {
        let sheets = vec![sheet_of(
            "1月",
            vec![(
                "WG1",
                "螺丝",
                Some(10.0),
                Some(7.0),
                vec![(3, 5.0, 0.0), (4, 0.0, 8.0)],
            )],
        )];
        let built = build(&sheets, 2026);

        assert_eq!(built.opening_rows, 1);
        assert_eq!(built.daily_rows, 2);
        assert_eq!(built.rows.len(), 3);
        // 期初 10 + 入 5 - 出 8 = 7，与现结存一致，不该补校正行
        assert_eq!(built.correction_rows, 0);

        let dates: Vec<&str> = built.rows.iter().map(|r| r.doc_date.as_str()).collect();
        assert_eq!(dates, vec!["2026-01-01", "2026-01-03", "2026-01-04"]);
        assert_eq!(built.rows[0].kind, "in");
        assert_eq!(built.rows[1].qty, Some(5.0));
        assert_eq!(built.rows[2].kind, "out");
    }

    #[test]
    fn build_adds_correction_when_source_disagrees() {
        // 源表说期初 10、当天出 8，现结存却写 7：差 5，要补一行校正
        let sheets = vec![sheet_of(
            "1月",
            vec![("WG1", "螺丝", Some(10.0), Some(7.0), vec![(4, 0.0, 8.0)])],
        )];
        let built = build(&sheets, 2026);

        assert_eq!(built.correction_rows, 1);
        let fix = built.rows.iter().find(|r| r.doc_no.ends_with("JZ")).expect("校正行");
        assert_eq!(fix.doc_date, "2026-01-31", "校正落在月末");
        assert_eq!(fix.kind, "in", "校正方向按差值符号");
        assert_eq!(fix.qty, Some(5.0));
        assert_eq!(built.corrections.len(), 1);
    }

    #[test]
    fn build_fills_gap_between_daily_sum_and_month_total() {
        // 逐日只填了 5，但「本月入库」写 20：差 15 要补成月末一行
        let mut sheet = sheet_of("1月", vec![("WG1", "螺丝", None, Some(20.0), vec![(3, 5.0, 0.0)])]);
        sheet.items[0].in_total = Some(20.0);
        let built = build(&[sheet], 2026);

        assert_eq!(built.residual_rows, 1);
        let gap = built.rows.iter().find(|r| r.doc_no.ends_with("BC")).expect("补差行");
        assert_eq!(gap.qty, Some(15.0));
        assert_eq!(gap.doc_date, "2026-01-31");
        // 5 + 15 = 20 与现结存一致
        assert_eq!(built.correction_rows, 0);
    }

    #[test]
    fn build_applies_stocktake_adjustment() {
        let mut sheet = sheet_of("1月", vec![("WG1", "轴承", Some(85.0), Some(90.0), Vec::new())]);
        sheet.items[0].adj_in = Some(5.0);
        let built = build(&[sheet], 2026);

        assert_eq!(built.adjust_rows, 1);
        let adj = built.rows.iter().find(|r| r.doc_no.ends_with("PD")).expect("盘点行");
        assert_eq!(adj.kind, "in");
        assert_eq!(adj.qty, Some(5.0));
        assert_eq!(built.correction_rows, 0, "85 + 5 = 90，不需要再校正");
    }

    #[test]
    fn build_uses_only_first_month_opening() {
        // 两张表都带「上月结存」，只有最早的 1 月算期初
        let sheets = vec![
            sheet_of("1月", vec![("WG1", "螺丝", Some(10.0), Some(10.0), Vec::new())]),
            sheet_of("2月", vec![("WG1", "螺丝", Some(10.0), Some(10.0), Vec::new())]),
        ];
        let built = build(&sheets, 2026);
        assert_eq!(built.opening_rows, 1, "期初只落一次，否则结存会翻倍");
        assert_eq!(built.rows.len(), 1);
        assert_eq!(built.months, vec![1, 2]);
    }

    #[test]
    fn build_collects_item_definitions_with_location() {
        let mut sheet1 = sheet_of("1月", vec![("WG00002", "电焊面罩", Some(1.0), Some(1.0), Vec::new())]);
        sheet1.items[0].spec = "5*5".into();
        sheet1.items[0].unit = "个".into();
        sheet1.items[0].location = "D-01-02-4F".into();
        // 2月没有单位列，但有日进出，生成的流水应从 1月 继承 unit 和 spec
        let sheet2 = sheet_of("2月", vec![("WG00002", "", Some(1.0), Some(3.0), vec![(5, 2.0, 0.0)])]);
        let built = build_with_hint(&[sheet1, sheet2], 2026, Some("仓库进销存-外购件.xlsx"));

        assert_eq!(built.items.len(), 1);
        let def = &built.items[0];
        assert_eq!(def.item_code, "WG00002");
        assert_eq!(def.item_name, "电焊面罩");
        assert_eq!(def.spec.as_deref(), Some("5*5"));
        assert_eq!(def.unit.as_deref(), Some("个"));
        assert_eq!(def.location.as_deref(), Some("D-01-02-4F"));
        assert_eq!(def.item_type.as_deref(), Some("外购件"));

        let feb_row = built.rows.iter().find(|r| r.doc_date == "2026-02-05").expect("2月流水");
        assert_eq!(feb_row.item_name, "电焊面罩", "2月空名称应从跨月字典回填");
        assert_eq!(feb_row.unit, "个", "2月无单位列应从1月回填");
        assert_eq!(feb_row.spec, "5*5", "2月无规格应从1月回填");
    }

    #[test]
    fn upsert_items_fills_blanks_but_keeps_manual_values() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO items (item_code, item_name, location) VALUES ('WG1','手填名称','A-1')",
                [],
            )
            .map_err(DbError::from)?;
            let defs = vec![
                PivotItemDef {
                    item_code: "WG1".into(),
                    item_name: "表里的名称".into(),
                    spec: Some("5*5".into()),
                    unit: Some("个".into()),
                    location: Some("D-01-02-4F".into()),
                    item_type: Some("外购件".into()),
                },
                PivotItemDef {
                    item_code: "WG2".into(),
                    item_name: "新增件".into(),
                    spec: None,
                    unit: None,
                    location: Some("B-2".into()),
                    item_type: None,
                },
            ];
            let (added, updated) = upsert_items(c, &defs).map_err(DbError)?;
            assert_eq!((added, updated), (1, 1));
            Ok(())
        })
        .unwrap();

        let (name, location, spec, item_type): (String, Option<String>, Option<String>, Option<String>) = db
            .with(|c| {
                c.query_row(
                    "SELECT item_name, location, spec, item_type FROM items WHERE item_code = 'WG1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(name, "手填名称", "已有名称不该被覆盖");
        assert_eq!(location.as_deref(), Some("A-1"), "已有库位不该被覆盖");
        assert_eq!(spec.as_deref(), Some("5*5"), "空字段要补上");
        assert_eq!(item_type.as_deref(), Some("外购件"), "空类型要补上");
    }
}

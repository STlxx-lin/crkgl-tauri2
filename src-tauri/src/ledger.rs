//! 台账查询：分页、筛选、单行详情、编辑、删除、导出。
//!
//! 所有筛选条件集中编译成 `(where 子句, 参数)`，列表与汇总共用同一套，
//! 保证“筛出来的行”和“算出来的合计”永远对应。

use rusqlite::{types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError, DbResult};

/// 前端传来的筛选条件。字段名与前端 `LedgerFilter` 一致（camelCase）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LedgerFilter {
    pub from: Option<String>,
    pub to: Option<String>,
    /// `in` / `out` / 空 = 全部
    pub kind: Option<String>,
    pub owner: Option<String>,
    pub partner: Option<String>,
    pub buyer: Option<String>,
    /// 关键字：单据号、物料编码、物料名称、供应商、备注
    pub keyword: Option<String>,
    /// 只保留有数据问题的行
    pub flagged: bool,
    /// `date` | `amount` | `qty` | `name`
    pub sort: Option<String>,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub id: i64,
    pub kind: String,
    pub doc_date: Option<String>,
    pub doc_no: Option<String>,
    pub delivery_no: Option<String>,
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub spec: Option<String>,
    pub unit: Option<String>,
    pub qty: Option<f64>,
    pub price_micros: Option<i64>,
    pub amount_cents: Option<i64>,
    pub remark: Option<String>,
    pub partner: Option<String>,
    pub buyer: Option<String>,
    pub owner: Option<String>,
    pub receiver: Option<String>,
    pub flags: Vec<String>,
    pub sheet: String,
    pub row_no: i64,
    pub import_id: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTotals {
    pub rows: i64,
    pub in_rows: i64,
    pub out_rows: i64,
    pub amount_in_cents: i64,
    pub amount_out_cents: i64,
    pub qty_in: f64,
    pub qty_out: f64,
    pub doc_count: i64,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPage {
    pub rows: Vec<LedgerRow>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub totals: LedgerTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub owners: Vec<String>,
    pub partners: Vec<String>,
    pub buyers: Vec<String>,
    pub min_date: Option<String>,
    pub max_date: Option<String>,
    pub item_count: i64,
    pub in_rows: i64,
    pub out_rows: i64,
}

fn text(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// 把筛选编译成 SQL 片段 + 参数。汇总、导出、计数都走这里。
pub fn compile_where(filter: &LedgerFilter) -> (String, Vec<Value>) {
    let mut clauses: Vec<&str> = vec!["1 = 1"];
    let mut params: Vec<Value> = Vec::new();

    if let Some(from) = text(&filter.from) {
        clauses.push("doc_date >= ?");
        params.push(Value::Text(normalize_date(from)));
    }
    if let Some(to) = text(&filter.to) {
        clauses.push("doc_date <= ?");
        params.push(Value::Text(normalize_date(to)));
    }
    if let Some(kind) = text(&filter.kind) {
        if kind == "in" || kind == "out" {
            clauses.push("kind = ?");
            params.push(Value::Text(kind.to_string()));
        }
    }
    if let Some(owner) = text(&filter.owner) {
        clauses.push("owner = ?");
        params.push(Value::Text(owner.to_string()));
    }
    if let Some(partner) = text(&filter.partner) {
        clauses.push("partner = ?");
        params.push(Value::Text(partner.to_string()));
    }
    if let Some(buyer) = text(&filter.buyer) {
        clauses.push("buyer = ?");
        params.push(Value::Text(buyer.to_string()));
    }
    if let Some(keyword) = text(&filter.keyword) {
        clauses.push(
            "(doc_no LIKE ? OR delivery_no LIKE ? OR item_code LIKE ? OR item_name LIKE ? OR partner LIKE ? OR remark LIKE ? OR owner LIKE ?)",
        );
        let like = format!("%{}%", keyword);
        for _ in 0..7 {
            params.push(Value::Text(like.clone()));
        }
    }
    if filter.flagged {
        clauses.push("flags <> ''");
    }
    (clauses.join(" AND "), params)
}

fn order_by(sort: &Option<String>, desc: bool) -> String {
    let column = match sort.as_deref() {
        Some("amount") => "amount_cents",
        Some("qty") => "qty",
        Some("name") => "item_name",
        _ => "doc_date, id",
    };
    let dir = if desc { "DESC" } else { "ASC" };
    if column == "doc_date, id" {
        format!("ORDER BY doc_date IS NULL, doc_date {dir}, id {dir}")
    } else {
        format!("ORDER BY {column} IS NULL, {column} {dir}, id {dir}")
    }
}

/// `2025-1-5` / `2025/1/5` → `2025-01-05`，非法值原样返回（SQL 里自然筛不到）。
pub fn normalize_date(raw: &str) -> String {
    let parts: Vec<&str> = raw
        .split(['-', '/', '.'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            if (1..=12).contains(&m) && (1..=31).contains(&d) {
                return format!("{y:04}-{m:02}-{d:02}");
            }
        }
    }
    raw.trim().to_string()
}

pub(crate) fn bind_row_pub(row: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerRow> {
    let flags: String = row.get("flags")?;
    Ok(LedgerRow {
        id: row.get("id")?,
        kind: row.get("kind")?,
        doc_date: row.get("doc_date")?,
        doc_no: row.get("doc_no")?,
        delivery_no: row.get("delivery_no")?,
        item_code: row.get("item_code")?,
        item_name: row.get("item_name")?,
        spec: row.get("spec")?,
        unit: row.get("unit")?,
        qty: row.get("qty")?,
        price_micros: row.get("price_micros")?,
        amount_cents: row.get("amount_cents")?,
        remark: row.get("remark")?,
        partner: row.get("partner")?,
        buyer: row.get("buyer")?,
        owner: row.get("owner")?,
        receiver: row.get("receiver")?,
        flags: split_flags(&flags),
        sheet: row.get("sheet")?,
        row_no: row.get("row_no")?,
        import_id: row.get("import_id")?,
        created_at: row.get("created_at")?,
    })
}

fn split_flags(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}


pub(crate) const SELECT_COLUMNS_PUB: &str = "id, kind, doc_date, doc_no, delivery_no, item_code, item_name, spec, unit,
    qty, price_micros, amount_cents, remark, partner, buyer, owner, receiver, flags, sheet, row_no, import_id, created_at";

pub fn totals(conn: &Connection, filter: &LedgerFilter) -> DbResult<LedgerTotals> {
    let (where_sql, params) = compile_where(filter);
    let sql = format!(
        "SELECT
            COUNT(*) AS rows,
            COALESCE(SUM(kind = 'in'), 0) AS in_rows,
            COALESCE(SUM(kind = 'out'), 0) AS out_rows,
            COALESCE(SUM(CASE WHEN kind = 'in' THEN amount_cents END), 0) AS amount_in_cents,
            COALESCE(SUM(CASE WHEN kind = 'out' THEN amount_cents END), 0) AS amount_out_cents,
            COALESCE(SUM(CASE WHEN kind = 'in' THEN qty END), 0) AS qty_in,
            COALESCE(SUM(CASE WHEN kind = 'out' THEN qty END), 0) AS qty_out,
            COUNT(DISTINCT doc_no) AS doc_count,
            COUNT(DISTINCT COALESCE(item_code, item_name)) AS item_count
         FROM ledger WHERE {where_sql}"
    );
    conn.query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| {
        Ok(LedgerTotals {
            rows: r.get(0)?,
            in_rows: r.get(1)?,
            out_rows: r.get(2)?,
            amount_in_cents: r.get(3)?,
            amount_out_cents: r.get(4)?,
            qty_in: r.get(5)?,
            qty_out: r.get(6)?,
            doc_count: r.get(7)?,
            item_count: r.get(8)?,
        })
    })
    .map_err(DbError::from)
    .map_err(|e| e.0)
}

pub fn page(conn: &Connection, filter: &LedgerFilter, page: i64, page_size: i64) -> DbResult<LedgerPage> {
    let page = page.max(1);
    let page_size = page_size.clamp(20, 500);
    let (where_sql, params) = compile_where(filter);
    let totals = totals(conn, filter)?;
    let sql = format!(
        "SELECT {SELECT_COLUMNS_PUB} FROM ledger WHERE {where_sql} {} LIMIT ? OFFSET ?",
        order_by(&filter.sort, filter.desc)
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let mut all: Vec<Value> = params;
    all.push(Value::Integer(page_size));
    all.push(Value::Integer((page - 1) * page_size));
    let rows = stmt
        .query_map(rusqlite::params_from_iter(all.iter()), bind_row_pub)
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(LedgerPage {
        rows,
        total: totals.rows,
        page,
        page_size,
        totals,
    })
}

/// 带连接封装的翻页入口：桌面命令与 80 端口服务共用。
pub fn page_from(db: &Db, filter: &LedgerFilter, page_no: i64, page_size: i64) -> DbResult<LedgerPage> {
    db.with(|c| page(c, filter, page_no, page_size).map_err(DbError::from))
}

pub fn detail(conn: &Connection, id: i64) -> DbResult<Option<LedgerRow>> {
    let sql = format!("SELECT {SELECT_COLUMNS_PUB} FROM ledger WHERE id = ?1");
    match conn.query_row(&sql, [id], bind_row_pub) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(DbError::from(err).0),
    }
}

/// 可编辑字段白名单。金额按“元”传入，落库统一转分。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPatch {
    pub doc_date: Option<String>,
    pub doc_no: Option<String>,
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub unit: Option<String>,
    pub qty: Option<f64>,
    pub price_micros: Option<i64>,
    pub amount_cents: Option<i64>,
    pub remark: Option<String>,
    pub owner: Option<String>,
}

fn reconcile_vouchers(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "DELETE FROM vouchers WHERE id NOT IN (SELECT DISTINCT voucher_id FROM ledger WHERE voucher_id IS NOT NULL)",
        [],
    )
    .map_err(DbError::from)?;
    conn.execute(
        "UPDATE vouchers SET
            row_count = (SELECT COUNT(*) FROM ledger l WHERE l.voucher_id = vouchers.id),
            amount_cents = COALESCE((SELECT SUM(l.amount_cents) FROM ledger l WHERE l.voucher_id = vouchers.id), 0)",
        [],
    )
    .map_err(DbError::from)?;
    Ok(())
}

pub fn update(conn: &Connection, id: i64, patch: &LedgerPatch) -> DbResult<()> {
    conn.execute(
        "UPDATE ledger SET
            doc_date = COALESCE(?1, doc_date),
            doc_no = COALESCE(?2, doc_no),
            item_code = COALESCE(?3, item_code),
            item_name = COALESCE(?4, item_name),
            unit = COALESCE(?5, unit),
            qty = COALESCE(?6, qty),
            price_micros = COALESCE(?7, price_micros),
            amount_cents = COALESCE(?8, amount_cents),
            remark = COALESCE(?9, remark),
            owner = COALESCE(?10, owner)
         WHERE id = ?11",
        rusqlite::params![
            patch.doc_date.as_deref().map(normalize_date),
            patch.doc_no,
            patch.item_code,
            patch.item_name,
            patch.unit,
            patch.qty,
            patch.price_micros,
            patch.amount_cents,
            patch.remark,
            patch.owner,
            id
        ],
    )
    .map_err(DbError::from)?;
    reconcile_vouchers(conn)?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM ledger WHERE id = ?1", [id])
        .map_err(DbError::from)?;
    reconcile_vouchers(conn)?;
    Ok(())
}

/// 批量改：只动「归属 / 采购人 / 备注」这类描述性字段。
/// 数量、单价、金额不批量改——那是记账数据，逐行确认更安全。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPatch {
    pub owner: Option<String>,
    pub buyer: Option<String>,
    pub remark: Option<String>,
}

/// 返回实际改动的行数。
pub fn bulk_update(conn: &Connection, ids: &[i64], patch: &BulkPatch) -> DbResult<usize> {
    if ids.is_empty() {
        return Err("没有选中任何行".into());
    }
    if ids.len() > 5000 {
        return Err("一次最多改 5000 行".into());
    }
    let owner = patch.owner.as_deref();
    let buyer = patch.buyer.as_deref();
    let remark = patch.remark.as_deref();
    if owner.is_none() && buyer.is_none() && remark.is_none() {
        return Err("没有要改的字段".into());
    }
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    let mut changed = 0usize;
    {
        let mut stmt = tx
            .prepare(
                "UPDATE ledger SET
                    owner  = COALESCE(?1, owner),
                    buyer  = COALESCE(?2, buyer),
                    remark = COALESCE(?3, remark)
                 WHERE id = ?4",
            )
            .map_err(DbError::from)?;
        for id in ids {
            changed += stmt
                .execute(rusqlite::params![owner, buyer, remark, id])
                .map_err(DbError::from)?;
        }
    }
    tx.commit().map_err(DbError::from)?;
    Ok(changed)
}

/// 批量删。开单产生的行会连带把单据头删掉（避免留下没有明细的空单据）。
pub fn bulk_delete(conn: &Connection, ids: &[i64]) -> DbResult<usize> {
    if ids.is_empty() {
        return Err("没有选中任何行".into());
    }
    if ids.len() > 5000 {
        return Err("一次最多删 5000 行".into());
    }
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    let mut removed = 0usize;
    {
        let mut stmt = tx
            .prepare("DELETE FROM ledger WHERE id = ?1")
            .map_err(DbError::from)?;
        for id in ids {
            removed += stmt.execute([id]).map_err(DbError::from)?;
        }
    }
    // 清掉明细已经空了的单据头，并重算剩余单据的行数与合计金额
    reconcile_vouchers(&tx)?;
    tx.commit().map_err(DbError::from)?;
    Ok(removed)
}

pub fn bulk_update_db(db: &Db, ids: &[i64], patch: &BulkPatch) -> DbResult<usize> {
    db.with(|c| bulk_update(c, ids, patch).map_err(DbError::from))
}

pub fn bulk_delete_db(db: &Db, ids: &[i64]) -> DbResult<usize> {
    db.with(|c| bulk_delete(c, ids).map_err(DbError::from))
}

/// 带连接封装的查询入口：80 端口服务的处理器直接用。
pub fn facets_from(db: &Db) -> DbResult<Facets> {
    db.with(|c| facets(c).map_err(DbError::from))
}

pub fn detail_from(db: &Db, id: i64) -> DbResult<Option<LedgerRow>> {
    db.with(|c| detail(c, id).map_err(DbError::from))
}

pub fn export_csv_from(db: &Db, filter: &LedgerFilter, limit: i64) -> DbResult<(String, i64)> {
    db.with(|c| export_csv(c, filter, limit).map_err(DbError::from))
}


pub fn facets(conn: &Connection) -> DbResult<Facets> {
    let distinct = |column: &str| -> DbResult<Vec<String>> {
        let sql = format!(
            "SELECT DISTINCT {column} FROM ledger WHERE {column} IS NOT NULL AND TRIM({column}) <> '' ORDER BY {column}"
        );
        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .and_then(|it| it.collect())
            .map_err(DbError::from)?;
        Ok(rows)
    };
    let (min_date, max_date, item_count, in_rows, out_rows) = conn
        .query_row(
            "SELECT MIN(doc_date), MAX(doc_date),
                    COUNT(DISTINCT COALESCE(item_code, item_name)),
                    COALESCE(SUM(kind='in'),0), COALESCE(SUM(kind='out'),0)
             FROM ledger",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(DbError::from)?;
    Ok(Facets {
        owners: distinct("owner")?,
        partners: distinct("partner")?,
        buyers: distinct("buyer")?,
        min_date,
        max_date,
        item_count,
        in_rows,
        out_rows,
    })
}

/// 导出 CSV：UTF-8 BOM + 逗号转义，Excel 直接打开不乱码。
pub fn export_csv(conn: &Connection, filter: &LedgerFilter, limit: i64) -> DbResult<(String, i64)> {
    let (where_sql, params) = compile_where(filter);
    let sql = format!(
        "SELECT {SELECT_COLUMNS_PUB} FROM ledger WHERE {where_sql} {} LIMIT ?",
        order_by(&filter.sort, filter.desc)
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let mut all: Vec<Value> = params;
    all.push(Value::Integer(limit));
    let rows = stmt
        .query_map(rusqlite::params_from_iter(all.iter()), bind_row_pub)
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;

    let mut out = String::from("\u{feff}");
    out.push_str("类型,日期,单据编号,送货单号,物料编码,物料名称,规格/单位,单位,数量,单价,合计,供应商,采购人,归属,领用人,备注,提醒,来源表,源行号\n");
    for row in &rows {
        let fields = [
            if row.kind == "in" { "入库" } else { "出库" }.to_string(),
            row.doc_date.clone().unwrap_or_default(),
            row.doc_no.clone().unwrap_or_default(),
            row.delivery_no.clone().unwrap_or_default(),
            row.item_code.clone().unwrap_or_default(),
            row.item_name.clone().unwrap_or_default(),
            row.spec.clone().unwrap_or_default(),
            row.unit.clone().unwrap_or_default(),
            row.qty.map(|v| trim_float(v)).unwrap_or_default(),
            row.price_micros.map(micros_text).unwrap_or_default(),
            row.amount_cents.map(cents_text).unwrap_or_default(),
            row.partner.clone().unwrap_or_default(),
            row.buyer.clone().unwrap_or_default(),
            row.owner.clone().unwrap_or_default(),
            row.receiver.clone().unwrap_or_default(),
            row.remark.clone().unwrap_or_default(),
            row.flags.join(" "),
            row.sheet.clone(),
            row.row_no.to_string(),
        ];
        out.push_str(&csv_row(&fields));
    }
    Ok((out, rows.len() as i64))
}

/// 分 → `12.34` 文本，不带千分位（CSV 里要能被 Excel 当数字）。
/// 万分之一元 → 文本（保留到厘，尾零去掉）。
/// 单价必须用它，不能用 `cents_text`（那是金额/分的格式化，会差 100 倍）。
pub fn micros_text(micros: i64) -> String {
    let sign = if micros < 0 { "-" } else { "" };
    let abs = micros.unsigned_abs();
    let whole = abs / 10_000;
    let frac = abs % 10_000;
    if frac == 0 {
        return format!("{sign}{whole}");
    }
    let mut tail = format!("{frac:04}");
    while tail.ends_with('0') {
        tail.pop();
    }
    format!("{sign}{whole}.{tail}")
}

pub fn cents_text(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// 去掉浮点尾巴：2.5 → "2.5"，100 → "100"。
pub fn trim_float(v: f64) -> String {
    if v.fract().abs() < 1e-9 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn csv_row(fields: &[String]) -> String {
    let escaped: Vec<String> = fields
        .iter()
        .map(|f| {
            if f.contains([',', '"', '\n', '\r']) {
                format!("\"{}\"", f.replace('"', "\"\""))
            } else {
                f.clone()
            }
        })
        .collect();
    escaped.join(",") + "\n"
}

pub fn count(db: &Db) -> DbResult<i64> {
    db.with(|c| {
        c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0))
            .map_err(DbError::from)
    })
}

#[cfg(test)]
pub fn insert_sample(
    conn: &Connection,
    kind: &str,
    date: &str,
    code: &str,
    name: &str,
    qty: f64,
    price_micros: i64,
    owner: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ledger (sheet, row_no, kind, doc_date, doc_no, item_code, item_name, unit, qty, price_micros, amount_cents, owner, flags)
         VALUES ('t', 1, ?1, ?2, 'D1', ?3, ?4, '个', ?5, ?6, ?7, ?8, '')",
        rusqlite::params![kind, date, code, name, qty, price_micros, (qty * price_micros as f64).round() as i64, owner],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            insert_sample(c, "in", "2025-01-05", "WG-A", "螺丝", 10.0, 150, "").map_err(DbError::from)?;
            insert_sample(c, "in", "2025-02-05", "WG-B", "轴承", 2.0, 1000, "").map_err(DbError::from)?;
            insert_sample(c, "out", "2025-02-06", "WG-A", "螺丝", 4.0, 150, "乾力车间").map_err(DbError::from)?;
            insert_sample(c, "out", "2025-03-01", "WG-C", "电机", 1.0, 50000, "MQ").map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn date_normalization() {
        assert_eq!(normalize_date("2025/1/5"), "2025-01-05");
        assert_eq!(normalize_date("2025-1-5"), "2025-01-05");
        assert_eq!(normalize_date("2025.12.31"), "2025-12-31");
        assert_eq!(normalize_date("2025/13/1"), "2025/13/1");
        assert_eq!(normalize_date("上周"), "上周");
    }

    #[test]
    fn totals_split_by_kind() {
        let db = seeded();
        let t = db.with(|c| totals(c, &LedgerFilter::default()).map_err(DbError::from)).unwrap();
        assert_eq!(t.rows, 4);
        assert_eq!(t.in_rows, 2);
        assert_eq!(t.out_rows, 2);
        assert_eq!(t.amount_in_cents, 10 * 150 + 2 * 1000);
        assert_eq!(t.amount_out_cents, 4 * 150 + 50000);
        assert_eq!(t.item_count, 3);
    }

    #[test]
    fn filter_by_owner_and_kind() {
        let db = seeded();
        let f = LedgerFilter {
            owner: Some("乾力车间".into()),
            kind: Some("out".into()),
            ..Default::default()
        };
        let p = db.with(|c| page(c, &f, 1, 50).map_err(DbError::from)).unwrap();
        assert_eq!(p.total, 1);
        assert_eq!(p.rows[0].item_name.as_deref(), Some("螺丝"));
    }

    #[test]
    fn filter_by_date_range_and_keyword() {
        let db = seeded();
        let f = LedgerFilter {
            from: Some("2025-02-01".into()),
            to: Some("2025/2/28".into()),
            keyword: Some("轴".into()),
            ..Default::default()
        };
        let p = db.with(|c| page(c, &f, 1, 50).map_err(DbError::from)).unwrap();
        assert_eq!(p.total, 1);
        assert_eq!(p.rows[0].doc_date.as_deref(), Some("2025-02-05"));
    }

    #[test]
    fn paging_is_stable_and_sorted() {
        let db = seeded();
        let f = LedgerFilter {
            sort: Some("amount".into()),
            desc: true,
            ..Default::default()
        };
        let p1 = db.with(|c| page(c, &f, 1, 20).map_err(DbError::from)).unwrap();
        assert_eq!(p1.rows.len(), 4);
        assert_eq!(p1.rows[0].amount_cents, Some(50000));
        let p2 = db.with(|c| page(c, &f, 2, 20).map_err(DbError::from)).unwrap();
        assert_eq!(p2.rows.len(), 0);
        assert!(p1.rows[0].amount_cents >= p1.rows[3].amount_cents);
    }

    #[test]
    fn update_and_delete() {
        let db = seeded();
        let id = db
            .with(|c| {
                c.query_row("SELECT id FROM ledger WHERE item_code='WG-B'", [], |r| r.get::<_, i64>(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        let patch = LedgerPatch {
            price_micros: Some(1234),
            remark: Some("补录".into()),
            doc_date: None,
            doc_no: None,
            item_code: None,
            item_name: None,
            unit: None,
            qty: None,
            amount_cents: None,
            owner: None,
        };
        db.with(|c| update(c, id, &patch).map_err(DbError::from)).unwrap();
        let row = db.with(|c| detail(c, id).map_err(DbError::from)).unwrap().unwrap();
        assert_eq!(row.price_micros, Some(1234));
        assert_eq!(row.remark.as_deref(), Some("补录"));
        db.with(|c| delete(c, id).map_err(DbError::from)).unwrap();
        assert!(db.with(|c| detail(c, id).map_err(DbError::from)).unwrap().is_none());
    }

#[test]
    fn bulk_update_only_touches_given_fields() {
        let db = seeded();
        let ids: Vec<i64> = db
            .with(|c| {
                let mut stmt = c.prepare("SELECT id FROM ledger ORDER BY id").map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get(0))
                    .and_then(|it| it.collect::<Result<Vec<i64>, _>>())
                    .map_err(DbError::from)?;
                Ok(rows)
            })
            .unwrap();
        let patch = BulkPatch {
            owner: Some("批量归属".into()),
            ..Default::default()
        };
        let changed = db.with(|c| bulk_update(c, &ids[..2], &patch).map_err(DbError::from)).unwrap();
        assert_eq!(changed, 2);
        let owners: Vec<Option<String>> = db
            .with(|c| {
                let mut stmt = c.prepare("SELECT owner FROM ledger ORDER BY id").map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get(0))
                    .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                    .map_err(DbError::from)?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(owners[0].as_deref(), Some("批量归属"));
        assert_eq!(owners[1].as_deref(), Some("批量归属"));
        assert_ne!(owners[2].as_deref(), Some("批量归属"), "未选中的行不该被改");
    }

    #[test]
    fn bulk_operations_reject_empty_and_oversized() {
        let db = seeded();
        db.with(|c| {
            assert!(bulk_update(c, &[], &BulkPatch { owner: Some("x".into()), ..Default::default() }).is_err());
            assert!(bulk_delete(c, &[]).is_err());
            let too_many = vec![1i64; 5001];
            assert!(bulk_delete(c, &too_many).is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn bulk_update_requires_a_field() {
        let db = seeded();
        db.with(|c| {
            assert!(bulk_update(c, &[1], &BulkPatch::default()).is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn csv_has_bom_and_escapes_commas() {
        let db = seeded();
        db.with(|c| {
            c.execute(
                "UPDATE ledger SET remark = 'a,b' WHERE id = (SELECT id FROM ledger WHERE kind='out' LIMIT 1)",
                [],
            )
                .map_err(DbError::from)
                .map(|_| ())
        })
        .unwrap();
        let (csv, n) = db.with(|c| export_csv(c, &LedgerFilter::default(), 1000).map_err(DbError::from)).unwrap();
        assert_eq!(n, 4);
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("\"a,b\""));
        assert!(csv.contains("15.00"));
    }

#[test]
    fn micros_text_keeps_sub_cent_precision() {
        assert_eq!(micros_text(2_020), "0.202");
        assert_eq!(micros_text(2_160), "0.216");
        assert_eq!(micros_text(960), "0.096");
        assert_eq!(micros_text(1_000_000), "100");
        assert_eq!(micros_text(1_500_000), "150");
        assert_eq!(micros_text(15_000), "1.5");
        assert_eq!(micros_text(0), "0");
        assert_eq!(micros_text(-2_020), "-0.202");
    }

    #[test]
    fn cents_and_float_text() {
        assert_eq!(cents_text(150), "1.50");
        assert_eq!(cents_text(-5), "-0.05");
        assert_eq!(trim_float(2.5), "2.5");
        assert_eq!(trim_float(100.0), "100");
        assert_eq!(trim_float(0.3333), "0.3333");
    }
}

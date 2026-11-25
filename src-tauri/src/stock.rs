//! 库存核对与结存报表。
//!
//! 结存口径：`入库数量合计 - 出库数量合计`，按物料编码聚合，不引入期初余额表。
//! 核对页专门挑出三类要人处理的数据：负库存、缺物料编码、数量异常。
//! 这里只做查询与展示——修正动作由用户自己在台账里补单或改行。

use rusqlite::Connection;
use serde::Serialize;

use crate::db::{Db, DbError, DbResult};

/// 结存报表一行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockRow {
    pub item_code: String,
    pub item_name: String,
    pub location: Option<String>,
    pub spec: Option<String>,
    pub unit: Option<String>,
    /// 入库数量合计
    pub in_qty: f64,
    /// 出库数量合计
    pub out_qty: f64,
    /// 结存 = 入库 - 出库
    pub stock_qty: f64,
    /// 入库行数
    pub in_rows: i64,
    /// 出库行数
    pub out_rows: i64,
    /// 最近一次入库单价（万分之一元）
    pub last_price_micros: Option<i64>,
    /// 最近一次业务日期
    pub last_date: Option<String>,
}

/// 核对条目：一条待人工处理的异常。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRow {
    /// negative_stock / missing_code / bad_qty
    pub kind: String,
    /// 台账行 id（missing_code / bad_qty 有值；negative_stock 为 null）
    pub ledger_id: Option<i64>,
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub unit: Option<String>,
    pub qty: Option<f64>,
    pub doc_no: Option<String>,
    pub doc_date: Option<String>,
    pub kind_label: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    /// 负库存物料数
    pub negative_items: i64,
    /// 负库存合计缺口（正数表示缺多少）
    pub negative_gap: f64,
    /// 缺物料编码的行数
    pub missing_code_rows: i64,
    /// 数量异常（<=0 或空）的行数
    pub bad_qty_rows: i64,
}

/// 结存报表：只在 `in_stock_only` 或关键字下筛选，排序按结存绝对值降序。
pub fn stock_report(
    conn: &Connection,
    keyword: Option<&str>,
    only_negative: bool,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<StockRow>> {
    let like = keyword
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let limit = limit.clamp(1, 2000);
    let offset = offset.max(0);

    let sql = "
        WITH paged AS (
            SELECT l.item_code,
                   COALESCE(MAX(NULLIF(TRIM(l.item_name), '')), MAX(NULLIF(TRIM(it.item_name), '')), l.item_code) AS item_name,
                   MAX(NULLIF(TRIM(it.location), '')) AS location,
                   COALESCE(MAX(NULLIF(TRIM(l.spec), '')), MAX(NULLIF(TRIM(it.spec), ''))) AS spec,
                   COALESCE(MAX(NULLIF(TRIM(l.unit), '')), MAX(NULLIF(TRIM(it.unit), ''))) AS unit,
                   COALESCE(SUM(CASE WHEN l.kind = 'in' THEN l.qty ELSE 0 END), 0) AS in_qty,
                   COALESCE(SUM(CASE WHEN l.kind = 'out' THEN l.qty ELSE 0 END), 0) AS out_qty,
                   COALESCE(SUM(CASE WHEN l.kind = 'in' THEN l.qty ELSE -l.qty END), 0) AS stock_qty,
                   SUM(CASE WHEN l.kind = 'in' THEN 1 ELSE 0 END) AS in_rows,
                   SUM(CASE WHEN l.kind = 'out' THEN 1 ELSE 0 END) AS out_rows,
                   MAX(l.doc_date) AS last_date
            FROM ledger l
            LEFT JOIN items it ON it.item_code = l.item_code
            WHERE l.item_code IS NOT NULL AND TRIM(l.item_code) <> ''
              AND (?1 IS NULL OR l.item_code LIKE ?1 ESCAPE '\\' OR l.item_name LIKE ?1 ESCAPE '\\'
                   OR it.location LIKE ?1 ESCAPE '\\' OR l.spec LIKE ?1 ESCAPE '\\' OR it.spec LIKE ?1 ESCAPE '\\')
            GROUP BY l.item_code
            HAVING (?2 = 0 OR stock_qty < 0)
            ORDER BY ABS(stock_qty) DESC, l.item_code
            LIMIT ?3 OFFSET ?4
        )
        SELECT p.item_code,
               p.item_name,
               p.location,
               p.spec,
               p.unit,
               p.in_qty,
               p.out_qty,
               p.stock_qty,
               p.in_rows,
               p.out_rows,
               (SELECT l2.price_micros FROM ledger l2
                 WHERE l2.item_code = p.item_code AND l2.kind = 'in'
                   AND l2.price_micros IS NOT NULL AND l2.price_micros > 0
                 ORDER BY l2.doc_date DESC, l2.id DESC LIMIT 1) AS last_price,
               p.last_date
        FROM paged p";

    let mut stmt = conn.prepare(sql).map_err(|e| DbError::from(e).0)?;
    let rows = stmt
        .query_map(
            rusqlite::params![like, if only_negative { 1i64 } else { 0i64 }, limit, offset],
            |r| {
                Ok(StockRow {
                    item_code: r.get(0)?,
                    item_name: r.get(1)?,
                    location: r.get(2)?,
                    spec: r.get(3)?,
                    unit: r.get(4)?,
                    in_qty: r.get(5)?,
                    out_qty: r.get(6)?,
                    stock_qty: r.get(7)?,
                    in_rows: r.get(8)?,
                    out_rows: r.get(9)?,
                    last_price_micros: r.get(10)?,
                    last_date: r.get(11)?,
                })
            },
        )
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(|e| DbError::from(e).0)?;
    Ok(rows)
}

pub fn stock_count(conn: &Connection, keyword: Option<&str>, only_negative: bool) -> DbResult<i64> {
    let like = keyword
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let sql = "
        SELECT COUNT(*) FROM (
          SELECT l.item_code,
                 COALESCE(SUM(CASE WHEN l.kind = 'in' THEN l.qty ELSE -l.qty END), 0) AS stock_qty
          FROM ledger l
          LEFT JOIN items it ON it.item_code = l.item_code
          WHERE l.item_code IS NOT NULL AND TRIM(l.item_code) <> ''
            AND (?1 IS NULL OR l.item_code LIKE ?1 ESCAPE '\\' OR l.item_name LIKE ?1 ESCAPE '\\'
                   OR it.location LIKE ?1 ESCAPE '\\' OR l.spec LIKE ?1 ESCAPE '\\' OR it.spec LIKE ?1 ESCAPE '\\')
          GROUP BY l.item_code
          HAVING (?2 = 0 OR stock_qty < 0)
        )";
    conn.query_row(
        sql,
        rusqlite::params![like, if only_negative { 1i64 } else { 0i64 }],
        |r| r.get(0),
    )
    .map_err(|e| DbError::from(e).0)
}

/// 核对清单：负库存物料、缺编码的行、数量异常的行。
pub fn check_issues(conn: &Connection, limit: i64) -> DbResult<Vec<IssueRow>> {
    let limit = limit.clamp(1, 500);
    let mut out = Vec::new();

    // 1) 负库存物料：只给物料级汇总，具体改哪一行由用户自己判断
    {
        let mut stmt = conn
            .prepare(
                "SELECT item_code,
                        COALESCE(MAX(NULLIF(TRIM(item_name), '')), item_code),
                        MAX(NULLIF(TRIM(unit), '')),
                        COALESCE(SUM(CASE WHEN kind = 'in' THEN qty ELSE -qty END), 0) AS stock,
                        MAX(doc_date)
                 FROM ledger
                 WHERE item_code IS NOT NULL AND TRIM(item_code) <> ''
                 GROUP BY item_code
                 HAVING stock < 0
                 ORDER BY stock ASC
                 LIMIT ?1",
            )
            .map_err(|e| DbError::from(e).0)?;
        let rows = stmt
            .query_map([limit], |r| {
                let code: String = r.get(0)?;
                let stock: f64 = r.get(3)?;
                Ok(IssueRow {
                    kind: "negative_stock".into(),
                    ledger_id: None,
                    item_code: Some(code.clone()),
                    item_name: Some(r.get(1)?),
                    unit: r.get(2)?,
                    qty: Some(stock),
                    doc_no: None,
                    doc_date: r.get(4)?,
                    kind_label: None,
                    detail: format!("出库比入库多 {:.3}，需要补入库或核对出库", -stock),
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| DbError::from(e).0)?;
        out.extend(rows);
    }

    // 2) 缺物料编码的台账行：这类行不进结存，也开不了单
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, item_name, unit, qty, doc_no, doc_date, kind
                 FROM ledger
                 WHERE item_code IS NULL OR TRIM(item_code) = ''
                 ORDER BY doc_date DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|e| DbError::from(e).0)?;
        let rows = stmt
            .query_map([limit], |r| {
                let kind: String = r.get(6)?;
                Ok(IssueRow {
                    kind: "missing_code".into(),
                    ledger_id: Some(r.get(0)?),
                    item_code: None,
                    item_name: r.get(1)?,
                    unit: r.get(2)?,
                    qty: r.get(3)?,
                    doc_no: r.get(4)?,
                    doc_date: r.get(5)?,
                    kind_label: Some(kind_label(&kind)),
                    detail: "没有物料编码，不计入结存，也选不到".into(),
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| DbError::from(e).0)?;
        out.extend(rows);
    }

    // 3) 数量异常：空、0 或负数
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, item_code, item_name, unit, qty, doc_no, doc_date, kind
                 FROM ledger
                 WHERE qty IS NULL OR qty <= 0
                 ORDER BY doc_date DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|e| DbError::from(e).0)?;
        let rows = stmt
            .query_map([limit], |r| {
                let kind: String = r.get(7)?;
                let qty: Option<f64> = r.get(4)?;
                Ok(IssueRow {
                    kind: "bad_qty".into(),
                    ledger_id: Some(r.get(0)?),
                    item_code: r.get(1)?,
                    item_name: r.get(2)?,
                    unit: r.get(3)?,
                    qty,
                    doc_no: r.get(5)?,
                    doc_date: r.get(6)?,
                    kind_label: Some(kind_label(&kind)),
                    detail: match qty {
                        None => "数量为空".to_string(),
                        Some(q) if q == 0.0 => "数量为 0".to_string(),
                        Some(q) => format!("数量为负（{q}）"),
                    },
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| DbError::from(e).0)?;
        out.extend(rows);
    }

    Ok(out)
}

pub fn check_summary(conn: &Connection) -> DbResult<CheckSummary> {
    let (negative_items, negative_gap): (i64, f64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(-SUM(stock), 0) FROM (
               SELECT COALESCE(SUM(CASE WHEN kind = 'in' THEN qty ELSE -qty END), 0) AS stock
               FROM ledger
               WHERE item_code IS NOT NULL AND TRIM(item_code) <> ''
               GROUP BY item_code
             ) WHERE stock < 0",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| DbError::from(e).0)?;
    let missing_code_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ledger WHERE item_code IS NULL OR TRIM(item_code) = ''",
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    let bad_qty_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ledger WHERE qty IS NULL OR qty <= 0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    Ok(CheckSummary {
        negative_items,
        negative_gap,
        missing_code_rows,
        bad_qty_rows,
    })
}

fn kind_label(kind: &str) -> String {
    match kind {
        "in" => "入库".into(),
        "out" => "出库".into(),
        other => other.to_string(),
    }
}

// ---------- Db 包装 ----------

pub fn stock_report_db(
    db: &Db,
    keyword: Option<&str>,
    only_negative: bool,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<StockRow>> {
    db.with(|c| stock_report(c, keyword, only_negative, limit, offset).map_err(DbError))
}

pub fn stock_count_db(db: &Db, keyword: Option<&str>, only_negative: bool) -> DbResult<i64> {
    db.with(|c| stock_count(c, keyword, only_negative).map_err(DbError))
}

pub fn check_issues_db(db: &Db, limit: i64) -> DbResult<Vec<IssueRow>> {
    db.with(|c| check_issues(c, limit).map_err(DbError))
}

pub fn check_summary_db(db: &Db) -> DbResult<CheckSummary> {
    db.with(|c| check_summary(c).map_err(DbError))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE ledger (
                id INTEGER PRIMARY KEY, kind TEXT, doc_date TEXT, doc_no TEXT,
                item_code TEXT, item_name TEXT, spec TEXT, unit TEXT, qty REAL,
                price_micros INTEGER, amount_cents INTEGER, remark TEXT,
                partner TEXT, buyer TEXT, owner TEXT, receiver TEXT, flags TEXT
            );
            CREATE TABLE items (
                id INTEGER PRIMARY KEY, item_code TEXT UNIQUE, item_name TEXT,
                spec TEXT, unit TEXT, location TEXT
            );
            INSERT INTO items (item_code, item_name, spec, unit, location)
            VALUES ('A', '有剩余', '5*5', '个', 'E-01-02-4F');",
        )
        .unwrap();
        let rows = [
            ("in", "2026-01-01", "D1", "A", "有剩余", 10.0),
            ("out", "2026-01-02", "D2", "A", "有剩余", 4.0),
            ("in", "2026-01-01", "D3", "B", "用光了", 2.0),
            ("out", "2026-01-02", "D4", "B", "用光了", 2.0),
            ("in", "2026-01-01", "D5", "C", "负库存", 1.0),
            ("out", "2026-01-02", "D6", "C", "负库存", 3.0),
        ];
        for (kind, date, doc, code, name, qty) in rows {
            conn.execute(
                "INSERT INTO ledger (kind, doc_date, doc_no, item_code, item_name, unit, qty)
                 VALUES (?1,?2,?3,?4,?5,'个',?6)",
                rusqlite::params![kind, date, doc, code, name, qty],
            )
            .unwrap();
        }
        // 缺编码 + 数量异常各一行
        conn.execute(
            "INSERT INTO ledger (kind, doc_date, doc_no, item_code, item_name, qty)
             VALUES ('in','2026-01-03','D7',NULL,'无编码',5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ledger (kind, doc_date, doc_no, item_code, item_name, qty)
             VALUES ('out','2026-01-04','D8','A','有剩余',0)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn stock_report_and_negative_filter() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);

        let all = stock_report(&conn, None, false, 50, 0).unwrap();
        assert_eq!(all.len(), 3);
        let a = all.iter().find(|r| r.item_code == "A").unwrap();
        assert_eq!(a.in_qty, 10.0);
        assert_eq!(a.out_qty, 4.0);
        assert_eq!(a.stock_qty, 6.0);
        assert_eq!(a.location.as_deref(), Some("E-01-02-4F"));
        assert_eq!(a.spec.as_deref(), Some("5*5"));

        let neg = stock_report(&conn, None, true, 50, 0).unwrap();
        assert_eq!(neg.len(), 1);
        assert_eq!(neg[0].item_code, "C");
        assert_eq!(neg[0].stock_qty, -2.0);
    }

    #[test]
    fn check_summary_counts_three_kinds() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let s = check_summary(&conn).unwrap();
        assert_eq!(s.negative_items, 1, "只有 C 是负库存");
        assert_eq!(s.negative_gap, 2.0, "缺 2 个");
        assert_eq!(s.missing_code_rows, 1);
        assert_eq!(s.bad_qty_rows, 1);

        let issues = check_issues(&conn, 100).unwrap();
        assert!(issues.iter().any(|i| i.kind == "negative_stock" && i.item_code.as_deref() == Some("C")));
        assert!(issues.iter().any(|i| i.kind == "missing_code"));
        assert!(issues.iter().any(|i| i.kind == "bad_qty"));
    }
}

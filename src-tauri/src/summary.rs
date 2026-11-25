//! 汇总查询：按月 / 按归属 / 按物料 / 按供应商分组，以及 Top 物料。
//!
//! 全部走 SQL GROUP BY，不把明细拉到前端再算。

use rusqlite::Connection;
use serde::Serialize;

use crate::db::{DbError, DbResult};
use crate::ledger::{compile_where, LedgerFilter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub key: String,
    pub in_rows: i64,
    pub out_rows: i64,
    pub in_qty: f64,
    pub out_qty: f64,
    pub amount_in_cents: i64,
    pub amount_out_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopItem {
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub unit: Option<String>,
    pub amount_cents: i64,
    pub qty: f64,
    pub rows: i64,
}

/// 分组列来自白名单，避免把前端字符串直接拼进 SQL。
fn group_expr(group_by: &str) -> &'static str {
    match group_by {
        "owner" => "COALESCE(NULLIF(TRIM(owner), ''), '未标注')",
        "item" => "COALESCE(NULLIF(TRIM(item_code), ''), NULLIF(TRIM(item_name), ''), '未命名')",
        "partner" => "COALESCE(NULLIF(TRIM(partner), ''), '未标注')",
        _ => "COALESCE(NULLIF(substr(doc_date, 1, 7), ''), '未填日期')",
    }
}

pub fn grouped(conn: &Connection, filter: &LedgerFilter, group_by: &str, limit: i64) -> DbResult<Vec<GroupRow>> {
    let (where_sql, params) = compile_where(filter);
    let expr = group_expr(group_by);
    let limit = limit.clamp(1, 500);
    let order = if group_by == "month" {
        "key ASC"
    } else {
        // 序号列：7 = 出库金额，6 = 入库金额（SQLite 允许按输出列序号排序）
        "7 DESC, 6 DESC"
    };
    let sql = format!(
        "SELECT {expr} AS key,
                COALESCE(SUM(kind = 'in'), 0),
                COALESCE(SUM(kind = 'out'), 0),
                COALESCE(SUM(CASE WHEN kind = 'in' THEN qty END), 0),
                COALESCE(SUM(CASE WHEN kind = 'out' THEN qty END), 0),
                COALESCE(SUM(CASE WHEN kind = 'in' THEN amount_cents END), 0),
                COALESCE(SUM(CASE WHEN kind = 'out' THEN amount_cents END), 0)
         FROM ledger WHERE {where_sql}
         GROUP BY key
         ORDER BY {order}
         LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(GroupRow {
                key: r.get::<_, String>(0)?,
                in_rows: r.get(1)?,
                out_rows: r.get(2)?,
                in_qty: r.get(3)?,
                out_qty: r.get(4)?,
                amount_in_cents: r.get(5)?,
                amount_out_cents: r.get(6)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

/// `kind` 为 `in` / `out`，按金额取前 N。
pub fn top_items(conn: &Connection, filter: &LedgerFilter, kind: &str, limit: i64) -> DbResult<Vec<TopItem>> {
    let kind = if kind == "in" { "in" } else { "out" };
    let (where_sql, mut params) = compile_where(filter);
    let where_sql = format!("{where_sql} AND kind = ?");
    params.push(rusqlite::types::Value::Text(kind.to_string()));
    let limit = limit.clamp(1, 100);
    let sql = format!(
        "SELECT COALESCE(NULLIF(TRIM(item_code), ''), ''),
                COALESCE(NULLIF(TRIM(item_name), ''), item_code, '未命名'),
                MAX(unit),
                COALESCE(SUM(amount_cents), 0),
                COALESCE(SUM(qty), 0),
                COUNT(*)
         FROM ledger WHERE {where_sql}
         GROUP BY item_code, item_name
         ORDER BY 4 DESC
         LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let code: String = r.get(0)?;
            Ok(TopItem {
                item_code: if code.is_empty() { None } else { Some(code) },
                item_name: r.get(1)?,
                unit: r.get(2)?,
                amount_cents: r.get(3)?,
                qty: r.get(4)?,
                rows: r.get(5)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

/// 当前筛选期与上一期（等长往前推）的对比，给统计卡的“对比”。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodCompare {
    /// 序列化名保持 `current`，前端按这个名字读
    #[serde(rename = "current")]
    pub now: GroupRow,
    pub previous: GroupRow,
    pub previous_label: String,
}

pub fn compare_previous(conn: &Connection, filter: &LedgerFilter) -> DbResult<Option<PeriodCompare>> {
    let (Some(from), Some(to)) = (filter.from.as_deref(), filter.to.as_deref()) else {
        return Ok(None);
    };
    let from = crate::ledger::normalize_date(from);
    let to = crate::ledger::normalize_date(to);
    let (Ok(from_d), Ok(to_d)) = (
        chrono::NaiveDate::parse_from_str(&from, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(&to, "%Y-%m-%d"),
    ) else {
        return Ok(None);
    };
    let span = (to_d - from_d).num_days();
    if !(0..=400).contains(&span) {
        return Ok(None);
    }
    let prev_to = from_d - chrono::Days::new(1);
    let prev_from = prev_to - chrono::Days::new(span as u64);

    let mut prev_filter = filter.clone();
    prev_filter.from = Some(prev_from.format("%Y-%m-%d").to_string());
    prev_filter.to = Some(prev_to.format("%Y-%m-%d").to_string());

    let one = |f: &LedgerFilter| -> DbResult<GroupRow> {
        let t = crate::ledger::totals(conn, f)?;
        Ok(GroupRow {
            key: "期".to_string(),
            in_rows: t.in_rows,
            out_rows: t.out_rows,
            in_qty: t.qty_in,
            out_qty: t.qty_out,
            amount_in_cents: t.amount_in_cents,
            amount_out_cents: t.amount_out_cents,
        })
    };
    Ok(Some(PeriodCompare {
        now: one(filter)?,
        previous: one(&prev_filter)?,
        previous_label: format!("{} 至 {}", prev_from.format("%Y-%m-%d"), prev_to.format("%Y-%m-%d")),
    }))
}

/// 按月序列，给折线/柱状图用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthPoint {
    pub month: String,
    pub amount_in_cents: i64,
    pub amount_out_cents: i64,
    pub in_rows: i64,
    pub out_rows: i64,
}

pub fn monthly(conn: &Connection, filter: &LedgerFilter) -> DbResult<Vec<MonthPoint>> {
    let rows = grouped(conn, filter, "month", 240)?;
    Ok(rows
        .into_iter()
        .filter(|r| !r.key.is_empty() && r.key != "未填日期")
        .map(|r| MonthPoint {
            month: r.key,
            amount_in_cents: r.amount_in_cents,
            amount_out_cents: r.amount_out_cents,
            in_rows: r.in_rows,
            out_rows: r.out_rows,
        })
        .collect())
}

/// 带连接封装的入口，给 Tauri 命令用。
pub fn grouped_from(db: &crate::db::Db, filter: &LedgerFilter, group_by: &str, limit: i64) -> DbResult<Vec<GroupRow>> {
    db.with(|c| grouped(c, filter, group_by, limit).map_err(DbError::from))
}

pub fn top_items_from(db: &crate::db::Db, filter: &LedgerFilter, kind: &str, limit: i64) -> DbResult<Vec<TopItem>> {
    db.with(|c| top_items(c, filter, kind, limit).map_err(DbError::from))
}

pub fn monthly_from(db: &crate::db::Db, filter: &LedgerFilter) -> DbResult<Vec<MonthPoint>> {
    db.with(|c| monthly(c, filter).map_err(DbError::from))
}

pub fn compare_from(db: &crate::db::Db, filter: &LedgerFilter) -> DbResult<Option<PeriodCompare>> {
    db.with(|c| compare_previous(c, filter).map_err(DbError::from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::ledger::insert_sample;

    fn seeded() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            insert_sample(c, "in", "2025-01-05", "WG-A", "螺丝", 10.0, 150, "")?;
            insert_sample(c, "in", "2025-02-05", "WG-B", "轴承", 2.0, 1000, "")?;
            insert_sample(c, "out", "2025-02-06", "WG-A", "螺丝", 4.0, 150, "乾力车间")?;
            insert_sample(c, "out", "2025-03-01", "WG-C", "电机", 1.0, 50000, "MQ")?;
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn monthly_series_covers_each_month() {
        let db = seeded();
        let points = db
            .with(|c| monthly(c, &LedgerFilter::default()).map_err(DbError::from))
            .unwrap();
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].month, "2025-01");
        assert_eq!(points[2].amount_out_cents, 50000);
    }

    #[test]
    fn groups_by_owner_with_unlabeled_bucket() {
        let db = seeded();
        let rows = db
            .with(|c| grouped(c, &LedgerFilter::default(), "owner", 10).map_err(DbError::from))
            .unwrap();
        let keys: Vec<_> = rows.iter().map(|r| r.key.as_str()).collect();
        assert!(keys.contains(&"未标注"));
        assert!(keys.contains(&"乾力车间"));
    }

    #[test]
    fn top_out_items_ranked_by_amount() {
        let db = seeded();
        let rows = db
            .with(|c| top_items(c, &LedgerFilter::default(), "out", 5).map_err(DbError::from))
            .unwrap();
        assert_eq!(rows[0].item_name.as_deref(), Some("电机"));
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn compare_uses_equal_length_window() {
        let db = seeded();
        let f = LedgerFilter {
            from: Some("2025-02-01".into()),
            to: Some("2025-02-28".into()),
            ..Default::default()
        };
        let cmp = db
            .with(|c| compare_previous(c, &f).map_err(DbError::from))
            .unwrap()
            .unwrap();
        assert_eq!(cmp.now.in_rows, 1);
        assert_eq!(cmp.now.out_rows, 1);
        assert_eq!(cmp.previous.in_rows, 1);
        assert_eq!(cmp.previous_label, "2025-01-04 至 2025-01-31");
    }

    #[test]
    fn grouped_handles_null_doc_date_and_clamps_limit() {
        let db = seeded();
        db.with(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, doc_date, item_name, qty, amount_cents)
                 VALUES ('t', 99, 'in', NULL, '无日期物料', 1, 100)",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        let grouped_rows = db
            .with(|c| grouped(c, &LedgerFilter::default(), "month", 50).map_err(DbError::from))
            .unwrap();
        assert!(grouped_rows.iter().any(|r| r.key == "未填日期"));

        // 传入非法负 limit 不会退化成 SQLite 的无限返回，被钳制为 1
        let clamped = db
            .with(|c| grouped(c, &LedgerFilter::default(), "month", -1).map_err(DbError::from))
            .unwrap();
        assert_eq!(clamped.len(), 1);

        // 月度图表仍只展示合法 YYYY-MM 桶
        let points = db
            .with(|c| monthly(c, &LedgerFilter::default()).map_err(DbError::from))
            .unwrap();
        assert_eq!(points.len(), 3);
    }
}

//! 本机开单：入库单 / 出库单的表头 + 明细行，写入同一张 `ledger`，
//! 用 `voucher_id` 串回单据头，`sheet` 记成 `voucher:in` / `voucher:out`。
//!
//! 单据编号沿用 Excel 的习惯：`YYYYMMDD` + 3 位当日流水（`20260831206`）。
//! 物料主数据不单独建表，直接从历史台账里按编码聚合出「名称 / 单位 / 最近单价」。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError, DbResult};
use crate::ledger::normalize_date;

/// 一行明细的输入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherLineInput {
    /// 送货单号：纸单上是逐行填的，一张单里可能有多张送货单
    #[serde(default)]
    pub delivery_no: Option<String>,
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub spec: Option<String>,
    pub unit: Option<String>,
    pub qty: Option<f64>,
    /// 单价（分）。出库没有单价，传 None。
    pub price_micros: Option<i64>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherInput {
    /// `in` / `out`
    pub kind: String,
    /// 空则自动取号
    pub doc_no: Option<String>,
    pub doc_date: Option<String>,
    /// 入库：供应商
    pub partner: Option<String>,
    /// 入库：送货单号
    pub delivery_no: Option<String>,
    /// 入库：采购人
    pub buyer: Option<String>,
    /// 出库：归属
    pub owner: Option<String>,
    /// 出库：领用人
    pub receiver: Option<String>,
    pub remark: Option<String>,
    pub lines: Vec<VoucherLineInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherLine {
    pub id: i64,
    pub ledger_id: i64,
    pub delivery_no: Option<String>,
    pub item_code: Option<String>,
    pub item_name: Option<String>,
    pub spec: Option<String>,
    pub unit: Option<String>,
    pub qty: Option<f64>,
    pub price_micros: Option<i64>,
    pub amount_cents: Option<i64>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voucher {
    pub id: i64,
    pub kind: String,
    pub doc_no: String,
    pub doc_date: String,
    pub partner: Option<String>,
    pub delivery_no: Option<String>,
    pub buyer: Option<String>,
    pub owner: Option<String>,
    pub receiver: Option<String>,
    pub remark: Option<String>,
    pub row_count: i64,
    pub amount_cents: i64,
    pub created_at: String,
    /// 明细写入 ledger 时用的来源标记：voucher:in / voucher:out
    pub sheet: String,
    pub lines: Vec<VoucherLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherSummary {
    pub id: i64,
    pub kind: String,
    pub doc_no: String,
    pub doc_date: String,
    pub partner: Option<String>,
    pub owner: Option<String>,
    pub row_count: i64,
    pub amount_cents: i64,
    pub created_at: String,
    /// 第一行明细的物料名：供应商/归属为空时用它撑起列表第二条信息
    pub first_item: Option<String>,
}

/// 物料主数据：从历史台账聚合，用于开单时联动带出单位与单价。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMaster {
    pub item_code: String,
    pub item_name: String,
    pub unit: Option<String>,
    pub spec: Option<String>,
    /// 最近一次入库单价（分）
    pub last_price_micros: Option<i64>,
    /// 历史出现次数，用于排序
    pub hits: i64,
    /// 当前结存数量 = 入库合计 - 出库合计（按同一物料编码聚合）
    pub stock_qty: f64,
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// `20260831206` 的取号：同一仓库、同一天已有的最大流水 +1，没有就从 001 起。
pub fn next_doc_no(conn: &Connection, warehouse_id: i64, kind: &str, date: &str) -> DbResult<String> {
    let compact: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if compact.len() != 8 {
        return Err(format!("日期格式不对: {date}"));
    }
    // 单据编号既可能来自 Excel 导入，也可能是本机开的单，两者都算
    let prefix = format!("{compact}%");
    let max: Option<String> = conn
        .query_row(
            "SELECT doc_no FROM ledger
             WHERE warehouse_id = ?1 AND kind = ?2 AND doc_no LIKE ?3 ESCAPE '\\' AND length(doc_no) = 11
             ORDER BY doc_no DESC LIMIT 1",
            rusqlite::params![warehouse_id, kind, prefix],
            |r| r.get(0),
        )
        .ok();
    let seq = max
        .and_then(|value| value.get(8..).and_then(|tail| tail.parse::<u32>().ok()))
        .unwrap_or(0);
    if seq >= 999 {
        return Err(format!("{date} 的流水号已用完（999）"));
    }
    Ok(format!("{compact}{:03}", seq + 1))
}

/// 物料快速输入的数据源。
///
/// 两个来源合在一起：
/// 1. 台账 `ledger` 按编码聚合——名称/单位取最近值，单价取最近一次入库，带结存与历史次数；
/// 2. 基础资料 `items`——刚建好还没入过库的物料也要能选到，否则新建的编码在开单页永远搜不出来。
///
/// 同一编码两边都有时以台账为准（有真实入库价和结存），基础资料只补台账里没有的编码。
///
/// `inbound_only` 为真时台账只统计 `kind='in'` 的行；基础资料里的物料本身就是
/// 用户主动建的「将要用」的物料，不受这一项限制（它代表的是基础资料，不是出库流水）。
pub fn item_master(
    conn: &Connection,
    warehouse_id: i64,
    keyword: Option<&str>,
    limit: i64,
    inbound_only: bool,
    in_stock_only: bool,
) -> DbResult<Vec<ItemMaster>> {
    let like = keyword
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let limit = limit.clamp(1, 500);
    let (hits_expr, kind_sub) = if inbound_only {
        ("SUM(CASE WHEN kind = 'in' THEN 1 ELSE 0 END)", "AND l2.kind = 'in'")
    } else {
        ("COUNT(*)", "")
    };
    let sql = format!(
        "
        WITH top_items AS (
            SELECT item_code,
                   COALESCE(MAX(NULLIF(TRIM(item_name), '')), '') AS item_name,
                   MAX(NULLIF(TRIM(unit), '')) AS unit,
                   MAX(NULLIF(TRIM(spec), '')) AS spec,
                   {hits_expr} AS hits,
                   COALESCE(SUM(CASE WHEN kind = 'in' THEN qty ELSE -qty END), 0) AS stock_qty,
                   0 AS from_master
            FROM ledger
            WHERE warehouse_id = ?5
              AND item_code IS NOT NULL AND TRIM(item_code) <> ''
              AND (?1 IS NULL OR item_code LIKE ?1 ESCAPE '\\' OR item_name LIKE ?1 ESCAPE '\\'
                   OR spec LIKE ?1 ESCAPE '\\')
            GROUP BY item_code
            HAVING (?3 = 0 OR hits > 0)
               AND (?4 = 0 OR stock_qty > 0)
        ),
        -- 基础资料里新增、但台账还没有记录的物料（并集后由上面的 top_items 优先）
        master_items AS (
            SELECT item_code,
                   COALESCE(NULLIF(TRIM(item_name), ''), item_code) AS item_name,
                   NULLIF(TRIM(unit), '') AS unit,
                   NULLIF(TRIM(spec), '') AS spec,
                   0 AS hits,
                   0 AS stock_qty,
                   1 AS from_master
            FROM items
            WHERE active = 1
              AND TRIM(item_code) NOT IN ('-', '0')
              AND (?1 IS NULL OR item_code LIKE ?1 ESCAPE '\\' OR item_name LIKE ?1 ESCAPE '\\'
                   OR drawing_no LIKE ?1 ESCAPE '\\' OR spec LIKE ?1 ESCAPE '\\')
              -- 只有库存过滤时才排除基础资料项：它们本来就没有结存
              AND ?4 = 0
        ),
        merged AS (
            SELECT item_code, item_name, unit, spec, hits, stock_qty, from_master FROM top_items
            UNION ALL
            SELECT m.item_code, m.item_name, m.unit, m.spec, m.hits, m.stock_qty, m.from_master
            FROM master_items m
            WHERE NOT EXISTS (SELECT 1 FROM top_items t WHERE t.item_code = m.item_code)
        )
        SELECT t.item_code,
               t.item_name,
               t.unit,
               COALESCE(t.spec, (SELECT i.spec FROM items i WHERE i.item_code = t.item_code AND i.spec IS NOT NULL AND TRIM(i.spec) <> '' LIMIT 1)) AS spec,
               t.hits,
               (SELECT l2.price_micros FROM ledger l2
                 WHERE l2.item_code = t.item_code AND l2.price_micros IS NOT NULL AND l2.price_micros > 0
                   AND l2.warehouse_id = ?5
                   {kind_sub}
                 ORDER BY l2.doc_date DESC, l2.id DESC LIMIT 1) AS last_price,
               t.stock_qty,
               -- 台账里没有记录时回落到基础资料的参考单价
               (SELECT i.price_micros FROM items i WHERE i.item_code = t.item_code AND i.price_micros > 0
                 LIMIT 1) AS master_price,
               t.from_master
        FROM merged t
        ORDER BY t.hits DESC, t.item_code
        LIMIT ?2",
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                like,
                limit,
                if inbound_only { 1i64 } else { 0i64 },
                if in_stock_only { 1i64 } else { 0i64 },
                warehouse_id,
            ],
            |r| {
                let name: String = r.get(1)?;
                let code: String = r.get(0)?;
                // 有台账单价就用台账的，没有才用基础资料的参考单价
                let last_price: Option<i64> = r.get(5)?;
                let master_price: Option<i64> = r.get(7)?;
                Ok(ItemMaster {
                    item_name: if name.is_empty() { code.clone() } else { name },
                    item_code: code,
                    unit: r.get(2)?,
                    spec: r.get(3)?,
                    hits: r.get(4)?,
                    last_price_micros: last_price.or(master_price),
                    stock_qty: r.get::<_, f64>(6).unwrap_or(0.0),
                })
            },
        )
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

fn load_lines(conn: &Connection, voucher_id: i64) -> DbResult<Vec<VoucherLine>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, id, delivery_no, item_code, item_name, spec, unit, qty, price_micros, amount_cents, remark
             FROM ledger WHERE voucher_id = ?1 ORDER BY id",
        )
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map([voucher_id], |r| {
            Ok(VoucherLine {
                id: r.get(0)?,
                ledger_id: r.get(1)?,
                delivery_no: r.get(2)?,
                item_code: r.get(3)?,
                item_name: r.get(4)?,
                spec: r.get(5)?,
                unit: r.get(6)?,
                qty: r.get(7)?,
                price_micros: r.get(8)?,
                amount_cents: r.get(9)?,
                remark: r.get(10)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> DbResult<Option<Voucher>> {
    let head = conn.query_row(
        "SELECT id, kind, doc_no, doc_date, partner, delivery_no, buyer, owner, receiver, remark,
                row_count, amount_cents, created_at
         FROM vouchers WHERE id = ?1",
        [id],
        |r| {
            Ok(Voucher {
                id: r.get(0)?,
                kind: r.get(1)?,
                doc_no: r.get(2)?,
                doc_date: r.get(3)?,
                partner: r.get(4)?,
                delivery_no: r.get(5)?,
                buyer: r.get(6)?,
                owner: r.get(7)?,
                receiver: r.get(8)?,
                remark: r.get(9)?,
                row_count: r.get(10)?,
                amount_cents: r.get(11)?,
                created_at: r.get(12)?,
                sheet: format!("voucher:{}", r.get::<_, String>(1)?),
                lines: Vec::new(),
            })
        },
    );
    match head {
        Ok(mut voucher) => {
            voucher.lines = load_lines(conn, id)?;
            Ok(Some(voucher))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(DbError::from(err).0),
    }
}

pub fn list(conn: &Connection, warehouse_id: i64, kind: Option<&str>, limit: i64) -> DbResult<Vec<VoucherSummary>> {
    // 上限跟前端 `HISTORY_CAP` 对齐：前端允许「加载更早」到 500 张，
    // 这里若仍卡在 200，点两次之后按钮就消失，用户会以为系统里只有 200 张单。
    let limit = limit.clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "SELECT v.id, v.kind, v.doc_no, v.doc_date, v.partner, v.owner, v.row_count, v.amount_cents,
                    v.created_at,
                    (SELECT l.item_name FROM ledger l
                      WHERE l.voucher_id = v.id AND TRIM(COALESCE(l.item_name,'')) <> ''
                      ORDER BY l.row_no, l.id LIMIT 1) AS first_item
             FROM vouchers v
             WHERE v.warehouse_id = ?3 AND (?1 IS NULL OR v.kind = ?1)
             ORDER BY v.doc_date DESC, v.id DESC
             LIMIT ?2",
        )
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map(rusqlite::params![kind, limit, warehouse_id], |r| {
            Ok(VoucherSummary {
                id: r.get(0)?,
                kind: r.get(1)?,
                doc_no: r.get(2)?,
                doc_date: r.get(3)?,
                partner: r.get(4)?,
                owner: r.get(5)?,
                row_count: r.get(6)?,
                amount_cents: r.get(7)?,
                created_at: r.get(8)?,
                first_item: r.get(9)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

/// 单据查询结果。覆盖两种来源：
///   - `vouchers` 表：本机开的单（可编辑）
///   - `ledger`：Excel 导入的明细按单据号聚合（只读）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocHit {
    pub doc_no: String,
    pub kind: String,
    pub doc_date: Option<String>,
    pub partner: Option<String>,
    pub owner: Option<String>,
    pub buyer: Option<String>,
    pub delivery_no: Option<String>,
    pub row_count: i64,
    pub amount_cents: i64,
    /// `voucher` = 本机开单，可编辑；`import` = Excel 导入，只读
    pub source: String,
    /// 本机开单时有值，用它打开编辑器
    pub voucher_id: Option<i64>,
}

/// 按单据编号查询。支持：
///   - 完整编号精确命中
///   - 前缀/片段模糊匹配（输入 `0831` 能找出当天所有单）
///   - 同时搜本机开单与导入单据
pub fn search_docs(
    conn: &Connection,
    warehouse_id: i64,
    keyword: &str,
    kind: Option<&str>,
    limit: i64,
) -> DbResult<Vec<DocHit>> {
    let raw = keyword.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 200);
    let exact = raw.to_string();
    let like = crate::ledger::like_pattern(raw);

    // 1) 本机开单
    let mut hits: Vec<DocHit> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, doc_no, kind, doc_date, partner, owner, buyer, delivery_no, row_count, amount_cents
                 FROM vouchers
                 WHERE warehouse_id = ?5
                   AND (?1 IS NULL OR kind = ?1)
                   AND (doc_no = ?2 OR doc_no LIKE ?3 ESCAPE '\\')
                 ORDER BY doc_no DESC
                 LIMIT ?4",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![kind, exact, like, limit, warehouse_id], |r| {
                Ok(DocHit {
                    voucher_id: Some(r.get(0)?),
                    doc_no: r.get(1)?,
                    kind: r.get(2)?,
                    doc_date: r.get(3)?,
                    partner: r.get(4)?,
                    owner: r.get(5)?,
                    buyer: r.get(6)?,
                    delivery_no: r.get(7)?,
                    row_count: r.get(8)?,
                    amount_cents: r.get(9)?,
                    source: "voucher".to_string(),
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(DbError::from)?;
        hits.extend(rows);
    }

    // 2) 导入的单据：按编号聚合
    {
        let mut stmt = conn
            .prepare(
                "SELECT doc_no, kind, MIN(doc_date), COUNT(*),
                        COALESCE(SUM(amount_cents), 0),
                        MAX(partner), MAX(owner), MAX(buyer), MAX(delivery_no)
                 FROM ledger
                 WHERE warehouse_id = ?5
                   AND voucher_id IS NULL
                   AND TRIM(COALESCE(doc_no, '')) <> ''
                   AND (?1 IS NULL OR kind = ?1)
                   AND (doc_no = ?2 OR doc_no LIKE ?3 ESCAPE '\\')
                 GROUP BY doc_no, kind
                 ORDER BY doc_no DESC
                 LIMIT ?4",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![kind, exact, like, limit, warehouse_id], |r| {
                Ok(DocHit {
                    doc_no: r.get(0)?,
                    kind: r.get(1)?,
                    doc_date: r.get(2)?,
                    row_count: r.get(3)?,
                    amount_cents: r.get(4)?,
                    partner: r.get(5)?,
                    owner: r.get(6)?,
                    buyer: r.get(7)?,
                    delivery_no: r.get(8)?,
                    source: "import".to_string(),
                    voucher_id: None,
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(DbError::from)?;
        hits.extend(rows);
    }

    // 精确命中的排前面，其余按编号倒序
    hits.sort_by(|a, b| {
        let a_exact = a.doc_no == raw;
        let b_exact = b.doc_no == raw;
        b_exact.cmp(&a_exact).then_with(|| b.doc_no.cmp(&a.doc_no))
    });
    hits.truncate(limit as usize);
    Ok(hits)
}

/// 取一张导入单据的全部明细（只读查看用）。
pub fn import_doc_lines(
    conn: &Connection,
    warehouse_id: i64,
    doc_no: &str,
    kind: &str,
) -> DbResult<Vec<crate::ledger::LedgerRow>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM ledger
             WHERE warehouse_id = ?3 AND doc_no = ?1 AND kind = ?2 AND voucher_id IS NULL
             ORDER BY row_no, id",
            crate::ledger::SELECT_COLUMNS_PUB
        ))
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map(
            rusqlite::params![doc_no, kind, warehouse_id],
            crate::ledger::bind_row_pub,
        )
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

/// 数量 × 万分之一元单价 → 分。两处金额计算都必须走它，避免单位搞错 100 倍。
fn line_amount_cents(qty: f64, price_micros: i64) -> i64 {
    (qty * price_micros as f64 / 100.0).round() as i64
}

fn validate(input: &VoucherInput) -> Result<(String, String), String> {
    let kind = match input.kind.as_str() {
        "in" | "out" => input.kind.clone(),
        other => return Err(format!("单据类型只能是 in / out，收到 `{other}`")),
    };
    let date = normalize_date(trimmed(&input.doc_date).unwrap_or(""));
    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err("日期不对，需要 YYYY-MM-DD".into());
    }
    if input.lines.is_empty() {
        return Err("至少要有一行明细".into());
    }
    for (index, line) in input.lines.iter().enumerate() {
        let has_code = trimmed(&line.item_code).is_some();
        let has_name = trimmed(&line.item_name).is_some();
        if !has_code && !has_name {
            return Err(format!("第 {} 行既没有物料编码也没有物料名称", index + 1));
        }
        match line.qty {
            Some(q) if q.is_finite() && q != 0.0 => {}
            Some(_) => return Err(format!("第 {} 行数量不能为 0", index + 1)),
            None => return Err(format!("第 {} 行缺数量", index + 1)),
        }
    }
    Ok((kind, date))
}

/// 单号占用检查：`vouchers` 里的单据头 + `ledger` 里 `voucher_id IS NULL`
/// 的 Excel 导入行，都算「已被占用」。
///
/// 只查 `vouchers` 会漏掉导入数据：导入行不建单据头，`doc_search` 又按
/// `doc_no + kind` 把它们聚成一张单，于是手工开一张同号单就会在台账里出现
/// 两张同号单、查询时金额与行数被拆成两截。
fn ensure_doc_no_free(
    conn: &Connection,
    warehouse_id: i64,
    kind: &str,
    doc_no: &str,
    exclude_voucher: Option<i64>,
) -> DbResult<()> {
    let head: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vouchers WHERE warehouse_id = ?1 AND kind = ?2 AND doc_no = ?3 AND id <> ?4",
            rusqlite::params![warehouse_id, kind, doc_no, exclude_voucher.unwrap_or(-1)],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if head > 0 {
        return Err(format!("单据编号 {doc_no} 已经存在"));
    }
    let imported: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ledger
              WHERE warehouse_id = ?1 AND voucher_id IS NULL AND kind = ?2 AND TRIM(COALESCE(doc_no, '')) = ?3",
            rusqlite::params![warehouse_id, kind, doc_no.trim()],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if imported > 0 {
        return Err(format!(
            "单据编号 {doc_no} 已被 {imported} 行 Excel 导入明细占用，请换一个编号或先处理那批数据"
        ));
    }
    Ok(())
}

/// 新建单据。整张单一个事务：表头、明细、编号占用一起成功或一起失败。
pub fn create(conn: &Connection, warehouse_id: i64, input: &VoucherInput) -> DbResult<i64> {
    let (kind, date) = validate(input)?;
    let doc_no = match trimmed(&input.doc_no) {
        Some(no) => no.to_string(),
        None => next_doc_no(conn, warehouse_id, &kind, &date)?,
    };

    ensure_doc_no_free(conn, warehouse_id, &kind, &doc_no, None)?;

    let sheet = format!("voucher:{kind}");
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;

    let mut total_cents: i64 = 0;
    let mut row_count: i64 = 0;
    let voucher_id = {
        tx.execute(
            "INSERT INTO vouchers (warehouse_id, kind, doc_no, doc_date, partner, delivery_no, buyer, owner, receiver, remark)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                warehouse_id,
                kind,
                doc_no,
                date,
                trimmed(&input.partner),
                trimmed(&input.delivery_no),
                trimmed(&input.buyer),
                trimmed(&input.owner),
                trimmed(&input.receiver),
                trimmed(&input.remark),
            ],
        )
        .map_err(DbError::from)?;
        tx.last_insert_rowid()
    };

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO ledger (import_id, voucher_id, sheet, row_no, kind, doc_date, doc_no, delivery_no,
                    item_code, item_name, spec, unit, qty, price_micros, amount_cents, remark,
                    partner, buyer, owner, receiver, flags, warehouse_id)
                 VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, '', ?20)",
            )
            .map_err(DbError::from)?;
        for (index, line) in input.lines.iter().enumerate() {
            let qty = line.qty.unwrap_or(0.0);
            let amount = line.price_micros.map(|price| line_amount_cents(qty, price));
            total_cents += amount.unwrap_or(0);
            row_count += 1;
            stmt.execute(rusqlite::params![
                voucher_id,
                sheet,
                (index + 1) as i64,
                kind,
                date,
                doc_no,
                // 行里有就用行的，没有才回退到单头（兼容旧调用）
                trimmed(&line.delivery_no).or(trimmed(&input.delivery_no)),
                trimmed(&line.item_code),
                trimmed(&line.item_name),
                trimmed(&line.spec),
                trimmed(&line.unit),
                line.qty,
                line.price_micros,
                amount,
                trimmed(&line.remark),
                trimmed(&input.partner),
                trimmed(&input.buyer),
                trimmed(&input.owner),
                trimmed(&input.receiver),
                warehouse_id,
            ])
            .map_err(DbError::from)?;
        }
    }

    tx.execute(
        "UPDATE vouchers SET row_count = ?1, amount_cents = ?2 WHERE id = ?3",
        rusqlite::params![row_count, total_cents, voucher_id],
    )
    .map_err(DbError::from)?;
    // 开单时现输的单位/部门/采购人自动进字典，下次就有候选
    for line in &input.lines {
        crate::dict::touch(&tx, "unit", line.unit.as_deref().unwrap_or(""), 1);
    }
    crate::dict::touch(&tx, "owner", input.owner.as_deref().unwrap_or(""), 1);
    crate::dict::touch(&tx, "buyer", input.buyer.as_deref().unwrap_or(""), 1);
    tx.commit().map_err(DbError::from)?;
    Ok(voucher_id)
}

/// 改单据：替换全部明细（比逐行 diff 简单，且开单场景行数很少）。
///
/// 明细跟随单据原有的 `warehouse_id`，不随当前界面所在的仓库变——否则在二号仓
/// 打开一张一号仓的单据再保存，明细会被搬进二号仓。
pub fn update(conn: &Connection, id: i64, input: &VoucherInput) -> DbResult<()> {
    let (kind, date) = validate(input)?;
    let house: i64 = conn
        .query_row("SELECT warehouse_id FROM vouchers WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| "单据不存在".to_string())?;
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    tx.execute("DELETE FROM ledger WHERE voucher_id = ?1", [id])
        .map_err(DbError::from)?;

    let doc_no: String = match trimmed(&input.doc_no) {
        Some(no) => no.to_string(),
        None => tx
            .query_row("SELECT doc_no FROM vouchers WHERE id = ?1", [id], |r| r.get(0))
            .map_err(DbError::from)?,
    };
    ensure_doc_no_free(&tx, house, &kind, &doc_no, Some(id))?;
    tx.execute(
        "UPDATE vouchers SET kind=?1, doc_no=?2, doc_date=?3, partner=?4, delivery_no=?5, buyer=?6,
                owner=?7, receiver=?8, remark=?9, updated_at=datetime('now','localtime')
         WHERE id=?10",
        rusqlite::params![
            kind,
            doc_no,
            date,
            trimmed(&input.partner),
            trimmed(&input.delivery_no),
            trimmed(&input.buyer),
            trimmed(&input.owner),
            trimmed(&input.receiver),
            trimmed(&input.remark),
            id,
        ],
    )
    .map_err(DbError::from)?;

    let sheet = format!("voucher:{kind}");
    let mut total = 0i64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO ledger (voucher_id, sheet, row_no, kind, doc_date, doc_no, delivery_no,
                    item_code, item_name, spec, unit, qty, price_micros, amount_cents, remark,
                    partner, buyer, owner, receiver, flags, warehouse_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'',?20)",
            )
            .map_err(DbError::from)?;
        for (index, line) in input.lines.iter().enumerate() {
            let qty = line.qty.unwrap_or(0.0);
            let amount = line.price_micros.map(|p| line_amount_cents(qty, p));
            total += amount.unwrap_or(0);
            stmt.execute(rusqlite::params![
                id,
                sheet,
                (index + 1) as i64,
                kind,
                date,
                doc_no,
                // 行里有就用行的，没有才回退到单头（兼容旧调用）
                trimmed(&line.delivery_no).or(trimmed(&input.delivery_no)),
                trimmed(&line.item_code),
                trimmed(&line.item_name),
                trimmed(&line.spec),
                trimmed(&line.unit),
                line.qty,
                line.price_micros,
                amount,
                trimmed(&line.remark),
                trimmed(&input.partner),
                trimmed(&input.buyer),
                trimmed(&input.owner),
                trimmed(&input.receiver),
                house,
            ])
            .map_err(DbError::from)?;
        }
    }
    tx.execute(
        "UPDATE vouchers SET row_count = ?1, amount_cents = ?2 WHERE id = ?3",
        rusqlite::params![input.lines.len() as i64, total, id],
    )
    .map_err(DbError::from)?;
    for line in &input.lines {
        crate::dict::touch(&tx, "unit", line.unit.as_deref().unwrap_or(""), 1);
    }
    crate::dict::touch(&tx, "owner", input.owner.as_deref().unwrap_or(""), 1);
    crate::dict::touch(&tx, "buyer", input.buyer.as_deref().unwrap_or(""), 1);
    tx.commit().map_err(DbError::from)?;
    Ok(())
}

/// 删单据：明细一起删。
pub fn delete(conn: &Connection, id: i64) -> DbResult<usize> {
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    let removed = tx
        .execute("DELETE FROM ledger WHERE voucher_id = ?1", [id])
        .map_err(DbError::from)?;
    tx.execute("DELETE FROM vouchers WHERE id = ?1", [id])
        .map_err(DbError::from)?;
    tx.commit().map_err(DbError::from)?;
    Ok(removed)
}

// ---- 带连接封装的入口 ----

// `Db::with` 的闭包要求 `Result<_, DbError>`，而下面这些函数内部用的是
// `DbResult`（错误是 String）。这里统一加一层 `DbError` 包装。

pub fn search_docs_db(
    db: &Db,
    warehouse_id: i64,
    keyword: &str,
    kind: Option<&str>,
    limit: i64,
) -> DbResult<Vec<DocHit>> {
    db.with(|c| search_docs(c, warehouse_id, keyword, kind, limit).map_err(DbError))
}

pub fn import_doc_lines_db(
    db: &Db,
    warehouse_id: i64,
    doc_no: &str,
    kind: &str,
) -> DbResult<Vec<crate::ledger::LedgerRow>> {
    db.with(|c| import_doc_lines(c, warehouse_id, doc_no, kind).map_err(DbError))
}

pub fn create_db(db: &Db, warehouse_id: i64, input: &VoucherInput) -> DbResult<i64> {
    db.with(|c| create(c, warehouse_id, input).map_err(DbError))
}

pub fn update_db(db: &Db, id: i64, input: &VoucherInput) -> DbResult<()> {
    db.with(|c| update(c, id, input).map_err(DbError))
}

pub fn delete_db(db: &Db, id: i64) -> DbResult<usize> {
    db.with(|c| delete(c, id).map_err(DbError))
}

pub fn get_db(db: &Db, id: i64) -> DbResult<Option<Voucher>> {
    db.with(|c| get(c, id).map_err(DbError))
}

pub fn list_db(db: &Db, warehouse_id: i64, kind: Option<&str>, limit: i64) -> DbResult<Vec<VoucherSummary>> {
    db.with(|c| list(c, warehouse_id, kind, limit).map_err(DbError))
}

pub fn item_master_db(
    db: &Db,
    warehouse_id: i64,
    keyword: Option<&str>,
    limit: i64,
    inbound_only: bool,
    in_stock_only: bool,
) -> DbResult<Vec<ItemMaster>> {
    db.with(|c| item_master(c, warehouse_id, keyword, limit, inbound_only, in_stock_only).map_err(DbError))
}

pub fn next_doc_no_db(db: &Db, warehouse_id: i64, kind: &str, date: &str) -> DbResult<String> {
    db.with(|c| next_doc_no(c, warehouse_id, kind, date).map_err(DbError))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    /// 迁移 014 之后默认就有一个「主仓库」（id = 1），测试统一用它。
    const WH: i64 = 1;

    /// 内部函数返回 `DbResult`（错误是 String），而 `Db::with` 的闭包要求 `DbError`。
    /// 这层包装让测试里可以直接写 `db.with_loose(|c| create(c, &input))`。
    trait WithLoose {
        fn with_loose<T, F>(&self, f: F) -> DbResult<T>
        where
            F: FnOnce(&rusqlite::Connection) -> DbResult<T>;
    }

    impl WithLoose for Db {
        fn with_loose<T, F>(&self, f: F) -> DbResult<T>
        where
            F: FnOnce(&rusqlite::Connection) -> DbResult<T>,
        {
            self.with(|c| f(c).map_err(DbError))
        }
    }

    fn line(code: &str, name: &str, qty: f64, price: Option<i64>) -> VoucherLineInput {
        VoucherLineInput {
            delivery_no: None,
            item_code: Some(code.into()),
            item_name: Some(name.into()),
            spec: None,
            unit: Some("个".into()),
            qty: Some(qty),
            price_micros: price,
            remark: None,
        }
    }

    fn input(kind: &str, date: &str, lines: Vec<VoucherLineInput>) -> VoucherInput {
        VoucherInput {
            kind: kind.into(),
            doc_no: None,
            doc_date: Some(date.into()),
            partner: Some("万杨五金".into()),
            delivery_no: Some("0023378".into()),
            buyer: Some("严兰兰".into()),
            owner: None,
            receiver: None,
            remark: None,
            lines,
        }
    }

    #[test]
    fn doc_no_starts_at_001_and_increments() {
        let db = Db::open_in_memory().unwrap();
        let first = db.with_loose(|c| next_doc_no(c, WH, "in", "2026-08-31")).unwrap();
        assert_eq!(first, "20260831001");
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-31", vec![line("A", "螺丝", 1.0, Some(10_000))]),
            )
        })
        .unwrap();
        let second = db.with_loose(|c| next_doc_no(c, WH, "in", "2026-08-31")).unwrap();
        assert_eq!(second, "20260831002");
    }

    #[test]
    fn kinds_number_independently() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-31", vec![line("A", "螺丝", 1.0, Some(10_000))]),
            )
        })
        .unwrap();
        let out_no = db.with_loose(|c| next_doc_no(c, WH, "out", "2026-08-31")).unwrap();
        assert_eq!(out_no, "20260831001", "出库与入库的流水应各自独立");
    }

    /// 两个仓库各自从 001 起号，互不干扰；单据列表也只看到本仓。
    #[test]
    fn doc_numbers_are_per_warehouse() {
        let db = Db::open_in_memory().unwrap();
        crate::warehouse::create_db(
            &db,
            &crate::warehouse::WarehouseInput {
                name: "二号仓".into(),
                remark: None,
                company_name: None,
                active: None,
                sort_no: None,
            },
        )
        .unwrap();
        let in_one = db
            .with_loose(|c| {
                create(
                    c,
                    WH,
                    &input("in", "2026-08-31", vec![line("A", "螺丝", 1.0, Some(10_000))]),
                )
            })
            .unwrap();
        let in_two = db
            .with_loose(|c| {
                create(
                    c,
                    2,
                    &input("in", "2026-08-31", vec![line("B", "轴承", 2.0, Some(20_000))]),
                )
            })
            .unwrap();
        let one = db.with_loose(|c| get(c, in_one)).unwrap().unwrap();
        let two = db.with_loose(|c| get(c, in_two)).unwrap().unwrap();
        assert_eq!(one.doc_no, "20260831001");
        assert_eq!(two.doc_no, "20260831001", "两个仓同一天各自从 001 起号");

        assert_eq!(db.with_loose(|c| list(c, 1, None, 20)).unwrap().len(), 1);
        assert_eq!(db.with_loose(|c| list(c, 2, None, 20)).unwrap().len(), 1);
        // 单号查询也按仓隔离：同一单号在两个仓里各有一条
        assert_eq!(
            db.with_loose(|c| search_docs(c, 1, "20260831001", None, 20))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.with_loose(|c| search_docs(c, 2, "20260831001", None, 20))
                .unwrap()
                .len(),
            1
        );
        // 台账行确实落在各自的仓
        let wh: Vec<i64> = db
            .with_loose(|c| {
                let mut stmt = c
                    .prepare("SELECT warehouse_id FROM ledger ORDER BY id")
                    .map_err(|e| e.to_string())?;
                stmt.query_map([], |r| r.get(0))
                    .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(wh, vec![1, 2]);
    }

    #[test]
    fn create_computes_amount_and_links_lines() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .with_loose(|c| {
                create(
                    c,
                    WH,
                    &input(
                        "in",
                        "2026-08-31",
                        vec![
                            line("A", "螺丝", 2.5, Some(60_000)),
                            line("B", "轴承", 2.0, Some(100_000)),
                        ],
                    ),
                )
            })
            .unwrap();
        let voucher = db.with_loose(|c| get(c, id)).unwrap().unwrap();
        assert_eq!(voucher.row_count, 2);
        // 2.5 × 600 = 1500 分，2 × 1000 = 2000 分
        assert_eq!(voucher.amount_cents, 1500 + 2000);
        assert_eq!(voucher.lines.len(), 2);
        assert_eq!(voucher.lines[0].amount_cents, Some(1500));
        assert_eq!(voucher.sheet, "voucher:in");
        assert_eq!(voucher.doc_no, "20260831001");
    }

    #[test]
    fn out_voucher_has_no_amount() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .with_loose(|c| create(c, WH, &input("out", "2026-08-31", vec![line("A", "螺丝", 4.0, None)])))
            .unwrap();
        let voucher = db.with_loose(|c| get(c, id)).unwrap().unwrap();
        assert_eq!(voucher.amount_cents, 0);
        assert!(voucher.lines[0].price_micros.is_none());
        assert_eq!(voucher.sheet, "voucher:out");
    }

    #[test]
    fn rejects_bad_input() {
        let db = Db::open_in_memory().unwrap();
        // 类型不对
        assert!(db
            .with_loose(|c| create(c, WH, &input("sideways", "2026-08-31", vec![line("A", "x", 1.0, None)])))
            .is_err());
        // 日期不对
        assert!(db
            .with_loose(|c| create(c, WH, &input("in", "2026/13/45", vec![line("A", "x", 1.0, None)])))
            .is_err());
        // 没有明细
        assert!(db
            .with_loose(|c| create(c, WH, &input("in", "2026-08-31", vec![])))
            .is_err());
        // 数量为 0
        let mut zero = line("A", "x", 1.0, None);
        zero.qty = Some(0.0);
        assert!(db
            .with_loose(|c| create(c, WH, &input("in", "2026-08-31", vec![zero])))
            .is_err());
    }

    #[test]
    fn duplicate_doc_no_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let mut first = input("in", "2026-08-31", vec![line("A", "x", 1.0, Some(10_000))]);
        first.doc_no = Some("20260831999".into());
        db.with_loose(|c| create(c, WH, &first)).unwrap();

        let mut second = input("in", "2026-08-31", vec![line("B", "y", 1.0, Some(10_000))]);
        second.doc_no = Some("20260831999".into());
        assert!(db.with_loose(|c| create(c, WH, &second)).is_err());
    }

    /// Excel 导入行没有 `vouchers` 头，只查 `vouchers` 会漏掉它们，
    /// 手工再开一张同号单就会在台账里出现两张同号单。
    #[test]
    fn imported_doc_no_also_blocks_new_voucher() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, doc_date, doc_no, item_code, item_name, qty, flags)
                 VALUES ('入库明细', 2, 'in', '2026-08-31', '20260831555', 'X', '导入的', 1, '')",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        let mut clash = input("in", "2026-08-31", vec![line("A", "x", 1.0, Some(10_000))]);
        clash.doc_no = Some("20260831555".into());
        let err = db.with_loose(|c| create(c, WH, &clash)).unwrap_err();
        assert!(err.contains("Excel 导入明细"), "实际 {err}");

        // 出库侧不受同号的入库导入行影响（单号按 kind 独立）
        let mut out = input("out", "2026-08-31", vec![line("A", "x", 1.0, None)]);
        out.doc_no = Some("20260831555".into());
        assert!(db.with_loose(|c| create(c, WH, &out)).is_ok());
    }

    /// 改单时不能因为「自己已占用这个号」而失败。
    #[test]
    fn update_may_keep_its_own_doc_no() {
        let db = Db::open_in_memory().unwrap();
        let mut first = input("in", "2026-08-31", vec![line("A", "x", 1.0, Some(10_000))]);
        first.doc_no = Some("20260831777".into());
        let id = db.with_loose(|c| create(c, WH, &first)).unwrap();

        let mut same = input("in", "2026-09-01", vec![line("A", "x", 2.0, Some(10_000))]);
        same.doc_no = Some("20260831777".into());
        assert!(db.with_loose(|c| update(c, id, &same)).is_ok(), "沿用原单号应允许");
    }

    #[test]
    fn update_replaces_lines_and_delete_removes_all() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .with_loose(|c| {
                create(
                    c,
                    WH,
                    &input("in", "2026-08-31", vec![line("A", "x", 1.0, Some(10_000))]),
                )
            })
            .unwrap();

        db.with_loose(|c| {
            update(
                c,
                id,
                &input(
                    "in",
                    "2026-09-01",
                    vec![line("B", "y", 3.0, Some(20_000)), line("C", "z", 1.0, Some(5_000))],
                ),
            )
        })
        .unwrap();

        let voucher = db.with_loose(|c| get(c, id)).unwrap().unwrap();
        assert_eq!(voucher.doc_date, "2026-09-01");
        assert_eq!(voucher.lines.len(), 2);
        assert_eq!(voucher.amount_cents, 3 * 200 + 50);

        let removed = db.with_loose(|c| delete(c, id)).unwrap();
        assert_eq!(removed, 2);
        assert!(db.with_loose(|c| get(c, id)).unwrap().is_none());
    }

    #[test]
    fn search_finds_exact_and_partial_doc_numbers() {
        let db = Db::open_in_memory().unwrap();
        // 本机开两张单
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-09-01", vec![line("A", "x", 1.0, Some(10_000))]),
            )
        })
        .unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-09-01", vec![line("B", "y", 2.0, Some(20_000))]),
            )
        })
        .unwrap();
        // 再造一张"导入"的单（无 voucher_id），验证跨来源
        db.with_loose(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, doc_date, doc_no, item_code, item_name, qty, price_micros, amount_cents, flags)
                 VALUES ('入库明细', 2, 'in', '2026-09-05', '20260905888', 'C', 'z', 3, 30000, 900, '')",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        // 精确命中本机单
        let hits = db.with_loose(|c| search_docs(c, WH, "20260901001", None, 20)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, "voucher");
        assert_eq!(hits[0].doc_no, "20260901001");
        assert!(hits[0].voucher_id.is_some());

        // 精确命中导入单
        let hits = db.with_loose(|c| search_docs(c, WH, "20260905888", None, 20)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, "import");
        assert!(hits[0].voucher_id.is_none());

        // 前缀模糊能同时找出两来源
        let hits = db.with_loose(|c| search_docs(c, WH, "202609", None, 20)).unwrap();
        assert_eq!(hits.len(), 3);

        // 空关键字返回空
        assert!(db
            .with_loose(|c| search_docs(c, WH, "  ", None, 20))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_can_filter_by_kind() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-09-02", vec![line("A", "x", 1.0, Some(10_000))]),
            )
        })
        .unwrap();
        db.with_loose(|c| create(c, WH, &input("out", "2026-09-02", vec![line("A", "x", 2.0, None)])))
            .unwrap();
        assert_eq!(
            db.with_loose(|c| search_docs(c, WH, "20260902", None, 20))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            db.with_loose(|c| search_docs(c, WH, "20260902", Some("in"), 20))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.with_loose(|c| search_docs(c, WH, "20260902", Some("out"), 20))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn import_doc_lines_returns_rows_in_order() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            for (row_no, name) in [(2, "甲"), (3, "乙"), (4, "丙")] {
                c.execute(
                    "INSERT INTO ledger (sheet, row_no, kind, doc_date, doc_no, item_code, item_name, qty, amount_cents, flags)
                     VALUES ('入库明细', ?1, 'in', '2026-09-03', '20260903999', ?2, ?2, 1, 100, '')",
                    rusqlite::params![row_no, name],
                )
                .map_err(DbError::from)?;
            }
            Ok(())
        })
        .unwrap();
        let lines = db.with_loose(|c| import_doc_lines(c, WH, "20260903999", "in")).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].row_no, 2);
        assert_eq!(lines[2].row_no, 4);
    }

    #[test]
    fn item_master_aggregates_from_history() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input(
                    "in",
                    "2026-08-30",
                    vec![
                        line("WG-A", "外卡", 10.0, Some(15_000)),
                        line("WG-B", "轴承", 2.0, Some(100_000)),
                    ],
                ),
            )
        })
        .unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-31", vec![line("WG-A", "外卡（轴）", 5.0, Some(17_000))]),
            )
        })
        .unwrap();

        let items = db
            .with_loose(|c| item_master(c, WH, Some("WG-A"), 10, false, false))
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_code, "WG-A");
        assert_eq!(items[0].hits, 2);
        assert_eq!(items[0].last_price_micros, Some(17_000), "应取最近一次的单价");

        let all = db.with_loose(|c| item_master(c, WH, None, 10, false, false)).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn item_master_inbound_only_skips_outbound_rows() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-30", vec![line("WG-IN", "入库过的", 10.0, Some(15_000))]),
            )
        })
        .unwrap();
        // 只在出库单出现过的物料，不该进开单候选
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("out", "2026-08-31", vec![line("WG-OUT", "只出库过", 3.0, None)]),
            )
        })
        .unwrap();

        let inbound = db.with_loose(|c| item_master(c, WH, None, 10, true, false)).unwrap();
        let codes: Vec<&str> = inbound.iter().map(|i| i.item_code.as_str()).collect();
        assert_eq!(codes, vec!["WG-IN"], "只应列已入库的物料");

        // 不限来源时两者都在
        let all = db.with_loose(|c| item_master(c, WH, None, 10, false, false)).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn item_master_includes_master_data_items() {
        let db = Db::open_in_memory().unwrap();
        // 台账里只有一条入库记录
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-30", vec![line("WG-LED", "台账里的", 5.0, Some(15_000))]),
            )
        })
        .unwrap();
        // 基础资料里四条：一条与台账同码，三条台账没有
        db.with_loose(|c| {
            for (code, name, unit, price) in [
                ("WG-LED", "台账里的", "件", 99_000i64),
                ("WG-NEW", "新建但没入库", "套", 12_500),
                ("WG-NEW2", "另一个新料", "米", 3_000),
                ("WG-OFF", "停用的", "个", 1_000),
            ] {
                c.execute(
                    "INSERT INTO items (item_code, item_name, unit, price_micros, active) VALUES (?1,?2,?3,?4,?5)",
                    rusqlite::params![code, name, unit, price, if code == "WG-OFF" { 0 } else { 1 }],
                )
                .unwrap();
            }
            Ok(())
        })
        .unwrap();

        let all = db.with_loose(|c| item_master(c, WH, None, 50, true, false)).unwrap();
        let codes: Vec<&str> = all.iter().map(|i| i.item_code.as_str()).collect();
        assert!(codes.contains(&"WG-LED"), "台账物料要在: {codes:?}");
        assert!(codes.contains(&"WG-NEW"), "基础资料新物料也要在: {codes:?}");
        assert!(codes.contains(&"WG-NEW2"), "基础资料新物料也要在: {codes:?}");
        assert!(!codes.contains(&"WG-OFF"), "停用的不该出现: {codes:?}");
        // 同码时以台账为准：单价是入库价 15000，不是基础资料的 99000
        let led = all.iter().find(|i| i.item_code == "WG-LED").unwrap();
        assert_eq!(led.last_price_micros, Some(15_000));
        assert_eq!(led.stock_qty, 5.0);

        // 只靠基础资料补进来的，单价回落到参考单价
        let new = all.iter().find(|i| i.item_code == "WG-NEW").unwrap();
        assert_eq!(new.last_price_micros, Some(12_500));
        assert_eq!(new.unit.as_deref(), Some("套"));
        assert_eq!(new.hits, 0);

        // 关键字也能搜到基础资料里的物料（按名称）
        let by_name = db
            .with_loose(|c| item_master(c, WH, Some("新料"), 50, true, false))
            .unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].item_code, "WG-NEW2");
    }

    #[test]
    fn stock_filter_excludes_master_only_items() {
        let db = Db::open_in_memory().unwrap();
        // 账外物料（基础资料有、没库存）
        db.with_loose(|c| {
            c.execute(
                "INSERT INTO items (item_code, item_name, unit, price_micros, active) VALUES ('WG-NOSTOCK','没结存','个',1000,1)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-30", vec![line("WG-HAS", "有结存", 8.0, Some(2_000))]),
            )
        })
        .unwrap();

        // 出库单只看有库存的：基础资料里没结存的物料不能出现
        let in_stock = db.with_loose(|c| item_master(c, WH, None, 50, true, true)).unwrap();
        let codes: Vec<&str> = in_stock.iter().map(|i| i.item_code.as_str()).collect();
        assert_eq!(codes, vec!["WG-HAS"], "只看库存时不该带出没结存的基础资料项");
    }

    #[test]
    fn stock_qty_is_inbound_minus_outbound() {
        let db = Db::open_in_memory().unwrap();
        // 入库 10，出库 4 -> 结存 6
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-30", vec![line("WG-S", "有剩余", 10.0, Some(1_000))]),
            )
        })
        .unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("out", "2026-08-31", vec![line("WG-S", "有剩余", 4.0, None)]),
            )
        })
        .unwrap();
        // 入库 2，出库 2 -> 结存 0，出库时不该再出现
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-30", vec![line("WG-Z", "用光了", 2.0, Some(1_000))]),
            )
        })
        .unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("out", "2026-08-31", vec![line("WG-Z", "用光了", 2.0, None)]),
            )
        })
        .unwrap();

        let all = db.with_loose(|c| item_master(c, WH, None, 10, true, false)).unwrap();
        let mut by_code: Vec<(&str, f64)> = all.iter().map(|i| (i.item_code.as_str(), i.stock_qty)).collect();
        by_code.sort_by(|a, b| a.0.cmp(b.0));
        assert_eq!(by_code, vec![("WG-S", 6.0), ("WG-Z", 0.0)]);

        // 只看有库存：只剩 WG-S
        let in_stock = db.with_loose(|c| item_master(c, WH, None, 10, true, true)).unwrap();
        let codes: Vec<&str> = in_stock.iter().map(|i| i.item_code.as_str()).collect();
        assert_eq!(codes, vec!["WG-S"]);
    }

    #[test]
    fn list_filters_by_kind() {
        let db = Db::open_in_memory().unwrap();
        db.with_loose(|c| {
            create(
                c,
                WH,
                &input("in", "2026-08-31", vec![line("A", "x", 1.0, Some(10_000))]),
            )
        })
        .unwrap();
        db.with_loose(|c| create(c, WH, &input("out", "2026-08-31", vec![line("A", "x", 2.0, None)])))
            .unwrap();

        assert_eq!(db.with_loose(|c| list(c, WH, None, 10)).unwrap().len(), 2);
        assert_eq!(db.with_loose(|c| list(c, WH, Some("in"), 10)).unwrap().len(), 1);
        assert_eq!(db.with_loose(|c| list(c, WH, Some("out"), 10)).unwrap().len(), 1);
    }
}

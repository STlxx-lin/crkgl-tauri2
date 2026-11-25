//! 基础资料：物料主数据与供应商。
//!
//! 这两张表是录入时的「字典」：开单选物料编码能带出名称/单位/参考单价，
//! 供应商可以从下拉里选，不用每次手打。
//!
//! 数据来源有两条：
//!   1. 从工作簿的「物料编号」「供应商名称」表导入（首次启动自动跑一次）
//!   2. 在「基础资料」页手工维护

use calamine::{open_workbook_auto, Data, Reader};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError, DbResult};
use crate::import::to_micros;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub item_code: String,
    pub item_name: String,
    pub category: Option<String>,
    pub unit: Option<String>,
    pub price_micros: Option<i64>,
    pub spec: Option<String>,
    /// 外购件 / 加工件（来自工作簿「基础信息」的类型1）
    pub item_type: Option<String>,
    /// 图号
    pub drawing_no: Option<String>,
    /// 库位（D-01-02-4F），来自月度进销存宽表
    pub location: Option<String>,
    pub owner: Option<String>,
    pub supplier: Option<String>,
    pub remark: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub item_code: String,
    pub item_name: String,
    pub category: Option<String>,
    pub unit: Option<String>,
    /// 参考单价（分）
    pub price_micros: Option<i64>,
    pub spec: Option<String>,
    #[serde(default)]
    pub item_type: Option<String>,
    #[serde(default)]
    pub drawing_no: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub owner: Option<String>,
    pub supplier: Option<String>,
    pub remark: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    pub id: i64,
    pub name: String,
    pub contact: Option<String>,
    pub phone: Option<String>,
    pub remark: Option<String>,
    pub active: bool,
    /// 这个供应商在台账里出现多少次（用于排序与「常用」判断）
    pub hits: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInput {
    pub name: String,
    pub contact: Option<String>,
    pub phone: Option<String>,
    pub remark: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterStats {
    pub items: i64,
    pub items_active: i64,
    pub suppliers: i64,
    pub categories: Vec<CategoryCount>,
    /// 外购件 / 加工件 等类型分布
    pub item_types: Vec<CategoryCount>,
    /// 已填图号的物料数
    pub with_drawing: i64,
    /// 加工件中缺图号的数量（需要补的）
    pub missing_drawing: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

fn trim_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn bind_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    let active: i64 = row.get("active")?;
    Ok(Item {
        id: row.get("id")?,
        item_code: row.get("item_code")?,
        item_name: row.get("item_name")?,
        category: row.get("category")?,
        unit: row.get("unit")?,
        price_micros: row.get("price_micros")?,
        spec: row.get("spec")?,
        item_type: row.get("item_type")?,
        drawing_no: row.get("drawing_no")?,
        location: row.get("location")?,
        owner: row.get("owner")?,
        supplier: row.get("supplier")?,
        remark: row.get("remark")?,
        active: active != 0,
    })
}

const ITEM_COLUMNS: &str = "id, item_code, item_name, category, unit, price_micros, spec, item_type, drawing_no, location, owner, supplier, remark, active";

/// 物料列表：按编码或名称模糊搜，可按类别过滤。
/// 物料列表的排序方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOrder {
    /// 按编码升序（默认，方便按编号找）
    CodeAsc,
    /// 按建档先后倒序（最新建的在最前）
    NewestFirst,
    /// 按建档先后正序（最早建的在最前）
    OldestFirst,
    /// 按名称升序
    NameAsc,
    /// 按编码降序
    CodeDesc,
}

impl ItemOrder {
    /// 解析前端传来的排序键；认不出来就回落到编码升序。
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("newest") => ItemOrder::NewestFirst,
            Some("oldest") => ItemOrder::OldestFirst,
            Some("name") => ItemOrder::NameAsc,
            Some("code_desc") => ItemOrder::CodeDesc,
            _ => ItemOrder::CodeAsc,
        }
    }

    fn clause(self) -> &'static str {
        match self {
            ItemOrder::CodeAsc => "ORDER BY item_code",
            // seq 是自增建档序号：created_at 只到秒，整批导入时分不出先后
            ItemOrder::NewestFirst => "ORDER BY seq DESC",
            ItemOrder::OldestFirst => "ORDER BY seq ASC",
            ItemOrder::NameAsc => "ORDER BY item_name COLLATE NOCASE, item_code",
            ItemOrder::CodeDesc => "ORDER BY item_code DESC",
        }
    }
}

pub fn list_items(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<Item>> {
    list_items_ordered(conn, keyword, category, item_type, only_active, with_drawing, limit, offset, false)
}

/// `recent` 为真时按建档时间倒序（最新建的排最前），用于「新增物料」时挑刚建的那几条；
/// 基础资料列表仍按编码排，方便按编号找。
pub fn list_items_ordered(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    limit: i64,
    offset: i64,
    recent: bool,
) -> DbResult<Vec<Item>> {
    let order = if recent { ItemOrder::NewestFirst } else { ItemOrder::CodeAsc };
    list_items_sorted(conn, keyword, category, item_type, only_active, with_drawing, limit, offset, order)
}

/// 物料列表的过滤条件（列表、计数、导出三处共用同一套语义）。
///
/// 参数位固定为：?1 关键字、?2 类别、?3 只看在用、?4 分页条数、?5 偏移、
/// ?6 类型、?7 图号（1 有 / 0 无）。
/// 物料行的有效性判据：只有 `-` / `0` 的编码是粘贴残留，不是真物料。
///
/// 列表、计数、导出、概览统计必须用同一套——概览卡片写 3,900、列表底部写
/// 3,856 时，用户会以为丢数据或重复导入，排查成本全落在使用者身上。
const ITEM_VALID_SQL: &str = "TRIM(item_code) NOT IN ('-', '0')";

/// 物料列表的过滤条件（列表、计数、导出三处共用同一套语义）。
///
/// 参数位固定为：?1 关键字、?2 类别、?3 只看在用、?4 分页条数、?5 偏移、
/// ?6 类型、?7 图号（1 有 / 0 无）。
///
/// 关键字用 `LIKE ?1 ESCAPE '\'`：`%` / `_` 由 `ledger::like_pattern` 转义，
/// 否则输入一个 `%` 会匹配全表。
const ITEM_FILTER_SQL: &str = "WHERE (?1 IS NULL OR item_code LIKE ?1 ESCAPE '\\' OR item_name LIKE ?1 ESCAPE '\\'
                OR drawing_no LIKE ?1 ESCAPE '\\' OR spec LIKE ?1 ESCAPE '\\' OR location LIKE ?1 ESCAPE '\\')
           AND (?2 IS NULL OR category = ?2)
           AND (?6 IS NULL OR item_type = ?6)
           AND (?3 = 0 OR active = 1)
           -- 过滤只有 '-' / '0' 的粘贴残留，它们不是真编码（与 ITEM_VALID_SQL 同义，
           -- 这里写死是因为 const 之间没法互相插值）
           AND TRIM(item_code) NOT IN ('-', '0')
           -- ?7 = 1 只看有图号，0 只看没图号的
           AND (
             ?7 IS NULL
             OR (?7 = 1 AND TRIM(COALESCE(drawing_no,'')) <> '')
             OR (?7 = 0 AND TRIM(COALESCE(drawing_no,'')) = '')
           )";

/// 按过滤条件取物料行。`limit` 传负数表示不限条数（SQLite 的 LIMIT -1）。
fn query_items(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    limit: i64,
    offset: i64,
    order: ItemOrder,
) -> DbResult<Vec<Item>> {
    let like = keyword
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let category = category.map(str::trim).filter(|c| !c.is_empty());
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items {ITEM_FILTER_SQL} {} LIMIT ?4 OFFSET ?5",
        order.clause()
    );
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                like,
                category,
                only_active as i64,
                limit,
                offset.max(0),
                item_type.map(str::trim).filter(|t| !t.is_empty()),
                with_drawing.map(|v| v as i64),
            ],
            bind_item,
        )
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

/// 带排序的版本：基础资料列表的列头排序走这里。
pub fn list_items_sorted(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    limit: i64,
    offset: i64,
    order: ItemOrder,
) -> DbResult<Vec<Item>> {
    query_items(
        conn,
        keyword,
        category,
        item_type,
        only_active,
        with_drawing,
        limit.clamp(1, 500),
        offset,
        order,
    )
}

pub fn count_items(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
) -> DbResult<i64> {
    let like = keyword
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let category = category.map(str::trim).filter(|c| !c.is_empty());
    let item_type = item_type.map(str::trim).filter(|t| !t.is_empty());
    conn.query_row(
        // 与列表共用同一段 WHERE，保证「共 N 条」和翻出来的行始终对得上
        &format!("SELECT COUNT(*) FROM items {ITEM_FILTER_SQL}"),
        rusqlite::params![
            like,
            category,
            only_active as i64,
            0i64,
            0i64,
            item_type,
            with_drawing.map(|v| v as i64),
        ],
        |r| r.get(0),
    )
    .map_err(|e| DbError::from(e).0)
}

pub fn get_item(conn: &Connection, id: i64) -> DbResult<Option<Item>> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE id = ?1");
    match conn.query_row(&sql, [id], bind_item) {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(DbError::from(err).0),
    }
}

/// 按编码查一条：开单联动用。
pub fn find_item_by_code(conn: &Connection, code: &str) -> DbResult<Option<Item>> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE item_code = ?1");
    match conn.query_row(&sql, [code.trim()], bind_item) {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(DbError::from(err).0),
    }
}

fn register_item_dict(conn: &Connection, input: &ItemInput) {
    for (kind, raw) in [
        ("unit", &input.unit),
        ("category", &input.category),
        ("item_type", &input.item_type),
    ] {
        if let Some(val) = trim_opt(raw) {
            if val != "未分类" && val != "旧版基础信息" {
                let _ = conn.execute(
                    "INSERT INTO dict (kind, value, hits) VALUES (?1, ?2, 1)
                     ON CONFLICT(kind, value) DO NOTHING",
                    rusqlite::params![kind, val],
                );
            }
        }
    }
}

pub fn create_item(conn: &Connection, input: &ItemInput) -> DbResult<i64> {
    let code = input.item_code.trim();
    let name = input.item_name.trim();
    if code.is_empty() {
        return Err("物料编码不能为空".into());
    }
    if name.is_empty() {
        return Err("物料名称不能为空".into());
    }
    let dup: i64 = conn
        .query_row("SELECT COUNT(*) FROM items WHERE item_code = ?1", [code], |r| r.get(0))
        .map_err(|e| DbError::from(e).0)?;
    if dup > 0 {
        return Err(format!("物料编码 {code} 已存在"));
    }
    conn.execute(
        "INSERT INTO items (item_code, item_name, category, unit, price_micros, spec, item_type, drawing_no, location, owner, supplier, remark, active)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            code,
            name,
            trim_opt(&input.category),
            trim_opt(&input.unit),
            input.price_micros,
            trim_opt(&input.spec),
            trim_opt(&input.item_type),
            trim_opt(&input.drawing_no),
            trim_opt(&input.location),
            trim_opt(&input.owner),
            trim_opt(&input.supplier),
            trim_opt(&input.remark),
            input.active as i64,
        ],
    )
    .map_err(|e| DbError::from(e).0)?;
    let id = conn.last_insert_rowid();
    register_item_dict(conn, input);
    Ok(id)
}

pub fn update_item(conn: &Connection, id: i64, input: &ItemInput) -> DbResult<()> {
    let code = input.item_code.trim();
    let name = input.item_name.trim();
    if code.is_empty() || name.is_empty() {
        return Err("物料编码与名称都不能为空".into());
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM items WHERE item_code = ?1 AND id <> ?2",
            rusqlite::params![code, id],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    if dup > 0 {
        return Err(format!("物料编码 {code} 已被其它物料占用"));
    }
    let changed = conn
        .execute(
            "UPDATE items SET item_code=?1, item_name=?2, category=?3, unit=?4, price_micros=?5,
                    spec=?6, item_type=?7, drawing_no=?8, location=?9, owner=?10, supplier=?11,
                    remark=?12, active=?13,
                    updated_at=datetime('now','localtime')
             WHERE id=?14",
            rusqlite::params![
                code,
                name,
                trim_opt(&input.category),
                trim_opt(&input.unit),
                input.price_micros,
                trim_opt(&input.spec),
                trim_opt(&input.item_type),
                trim_opt(&input.drawing_no),
                trim_opt(&input.location),
                trim_opt(&input.owner),
                trim_opt(&input.supplier),
                trim_opt(&input.remark),
                input.active as i64,
                id,
            ],
        )
        .map_err(|e| DbError::from(e).0)?;
    if changed == 0 {
        return Err("物料不存在".into());
    }
    register_item_dict(conn, input);
    Ok(())
}

pub fn delete_item(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM items WHERE id = ?1", [id])
        .map_err(|e| DbError::from(e).0)?;
    Ok(())
}

pub fn list_suppliers(conn: &Connection, keyword: Option<&str>) -> DbResult<Vec<Supplier>> {
    let like = keyword
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(crate::ledger::like_pattern);
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.name, s.contact, s.phone, s.remark, s.active,
                    (SELECT COUNT(*) FROM ledger l WHERE l.partner = s.name) AS hits
             FROM suppliers s
             WHERE (?1 IS NULL OR s.name LIKE ?1 ESCAPE '\\')
             ORDER BY CASE s.active WHEN 1 THEN 0 ELSE 1 END, hits DESC, s.name",
        )
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map(rusqlite::params![like], |r| {
            let active: i64 = r.get(5)?;
            Ok(Supplier {
                id: r.get(0)?,
                name: r.get(1)?,
                contact: r.get(2)?,
                phone: r.get(3)?,
                remark: r.get(4)?,
                active: active != 0,
                hits: r.get(6)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    Ok(rows)
}

pub fn create_supplier(conn: &Connection, input: &SupplierInput) -> DbResult<i64> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("供应商名称不能为空".into());
    }
    let dup: i64 = conn
        .query_row("SELECT COUNT(*) FROM suppliers WHERE name = ?1", [name], |r| r.get(0))
        .map_err(|e| DbError::from(e).0)?;
    if dup > 0 {
        return Err(format!("供应商「{name}」已存在"));
    }
    conn.execute(
        "INSERT INTO suppliers (name, contact, phone, remark, active) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![
            name,
            trim_opt(&input.contact),
            trim_opt(&input.phone),
            trim_opt(&input.remark),
            input.active as i64,
        ],
    )
    .map_err(|e| DbError::from(e).0)?;
    Ok(conn.last_insert_rowid())
}

pub fn update_supplier(conn: &Connection, id: i64, input: &SupplierInput) -> DbResult<()> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("供应商名称不能为空".into());
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM suppliers WHERE name = ?1 AND id <> ?2",
            rusqlite::params![name, id],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    if dup > 0 {
        return Err(format!("供应商「{name}」已存在"));
    }
    let changed = conn
        .execute(
            "UPDATE suppliers SET name=?1, contact=?2, phone=?3, remark=?4, active=?5 WHERE id=?6",
            rusqlite::params![
                name,
                trim_opt(&input.contact),
                trim_opt(&input.phone),
                trim_opt(&input.remark),
                input.active as i64,
                id
            ],
        )
        .map_err(|e| DbError::from(e).0)?;
    if changed == 0 {
        return Err("供应商不存在".into());
    }
    Ok(())
}

pub fn delete_supplier(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM suppliers WHERE id = ?1", [id])
        .map_err(|e| DbError::from(e).0)?;
    Ok(())
}

pub fn stats(conn: &Connection) -> DbResult<MasterStats> {
    // 口径与列表/导出一致：先排掉粘贴残留的 '-' / '0' 行，
    // 否则概览卡片的物料数会比列表底部多几十条，用户以为丢了数据
    let items: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM items WHERE {ITEM_VALID_SQL}"),
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    let items_active: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM items WHERE active = 1 AND {ITEM_VALID_SQL}"),
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    let suppliers: i64 = conn
        .query_row("SELECT COUNT(*) FROM suppliers", [], |r| r.get(0))
        .map_err(|e| DbError::from(e).0)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT COALESCE(NULLIF(TRIM(category),''),'未分类') AS c, COUNT(*)
             FROM items WHERE {ITEM_VALID_SQL} GROUP BY c ORDER BY 2 DESC"
        ))
        .map_err(DbError::from)?;
    let categories = stmt
        .query_map([], |r| {
            Ok(CategoryCount {
                category: r.get(0)?,
                count: r.get(1)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    let mut type_stmt = conn
        .prepare(&format!(
            "SELECT COALESCE(NULLIF(TRIM(item_type),''),'未分类') AS t, COUNT(*)
             FROM items WHERE {ITEM_VALID_SQL} GROUP BY t ORDER BY 2 DESC"
        ))
        .map_err(DbError::from)?;
    let item_types = type_stmt
        .query_map([], |r| {
            Ok(CategoryCount {
                category: r.get(0)?,
                count: r.get(1)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;

    let with_drawing: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM items
                 WHERE TRIM(COALESCE(drawing_no,'')) <> '' AND {ITEM_VALID_SQL}"
            ),
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;
    let missing_drawing: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM items
                 WHERE item_type = '加工件' AND TRIM(COALESCE(drawing_no,'')) = ''
                   AND {ITEM_VALID_SQL}"
            ),
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::from(e).0)?;

    Ok(MasterStats {
        items,
        items_active,
        suppliers,
        categories,
        item_types,
        with_drawing,
        missing_drawing,
    })
}

// ---------- 从工作簿导入 ----------

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => crate::ledger::trim_float(*f),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => crate::import::excel_date(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.trim().to_string(),
        Data::Error(_) => String::new(),
    }
}

fn cell_f64(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(f) => Some(*f),
        Data::Int(i) => Some(*i as f64),
        Data::String(s) => crate::import::parse_number(s),
        _ => None,
    }
}

/// 「基础信息」表占位编码的下一个可用序号。
///
/// 占位编码形如 `基础-12`，只用于没有真实编码的老物料。必须接着库里已有的最大值往后排：
/// 若每次从 1 重数，第二遍导入时新行会撞上上一遍的占位号，被 `ON CONFLICT` 忽略后
/// 静默丢失，用户看到的就是「导入了但物料没变多」。
fn next_placeholder_seq(tx: &rusqlite::Transaction<'_>) -> DbResult<usize> {
    let max: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(CAST(SUBSTR(item_code, 4) AS INTEGER)), 0)
             FROM items WHERE item_code GLOB '基础-[0-9]*'",
            [],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    Ok(max.max(0) as usize + 1)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterImportOutcome {
    pub items_added: usize,
    pub items_updated: usize,
    pub suppliers_added: usize,
    pub suppliers_skipped: usize,
    pub sheets_found: Vec<String>,
    pub message: String,
}

/// 在表头里找一个字段对应的列号。
///
/// 两轮匹配：先整列名精确相等，再退化成「包含」。只用包含会踩坑：表头是
/// 「编码 / 供应商名称 / 物料名称」时，`index_of(["物料名称","名称"])` 会先
/// 命中「供应商名称」，整列物料名被写成供应商名，而且导入不报错，用户要到
/// 对账时才发现基础资料被污染。
///
/// `used` 是已经被别的字段占掉的列号，第二轮跳过它们，避免同一个「名称」
/// 列被两个字段各认领一次。
fn index_of_column(header: &[String], candidates: &[&str], used: &[usize]) -> Option<usize> {
    let trim = |h: &String| h.trim().to_string();
    for candidate in candidates {
        if let Some(i) = header.iter().position(|h| trim(h) == *candidate) {
            if !used.contains(&i) {
                return Some(i);
            }
        }
    }
    for candidate in candidates {
        if let Some((i, _)) = header
            .iter()
            .enumerate()
            .find(|(i, h)| h.trim().contains(candidate) && !used.contains(i))
        {
            return Some(i);
        }
    }
    None
}

/// 从工作簿里找「物料编号」「供应商名称」或「月度进销存宽表」并导入。
/// 表头按列名认，不依赖 sheet 顺序；已有编码则更新价格/单位，不覆盖手填的备注。
pub fn import_from_workbook(conn: &Connection, path: &std::path::Path) -> DbResult<MasterImportOutcome> {
    let mut outcome = MasterImportOutcome::default();
    if let Ok((report, pivot_sheets)) = crate::import::inspect_and_collect_cached(path) {
        let has_master_sheet = report.sheets.iter().any(|s| s.master);
        if !has_master_sheet && !pivot_sheets.is_empty() {
            let built = crate::pivot::build_with_hint(
                &pivot_sheets,
                crate::import::current_year(),
                Some(&report.file_name),
            );
            if !built.items.is_empty() {
                let (added, updated) = crate::pivot::upsert_items(conn, &built.items)?;
                let located = built
                    .items
                    .iter()
                    .filter(|i| i.location.as_deref().is_some_and(|l| !l.trim().is_empty()))
                    .count();
                outcome.items_added = added;
                outcome.items_updated = updated;
                outcome.sheets_found.push(format!(
                    "月度进销存 {} 个月（物料 {} 个，含库位 {} 个）",
                    built.months.len(),
                    built.items.len(),
                    located
                ));
                outcome.message = format!(
                    "物料 +{} 更新{}，供应商 +0 跳过0",
                    outcome.items_added, outcome.items_updated
                );
                return Ok(outcome);
            }
        }
    }

    let mut master_entries: Vec<(String, calamine::Range<Data>)> =
        if let Some(cached) = crate::import::get_cached_master_sheets(path) {
            log::debug!("master_from_workbook: 命中缓存 master_sheets，包含 {} 张表", cached.len());
            cached
        } else {
            log::debug!("master_from_workbook: 未命中缓存，重新打开文件");
            let mut book = open_workbook_auto(path).map_err(|e| format!("不是可读的 Excel 文件: {e}"))?;
            let mut list = Vec::new();
            for name in book.sheet_names() {
                if let Ok(r) = book.worksheet_range(&name) {
                    list.push((name.clone(), r));
                }
            }
            list
        };

    // 排序：带「物料编码」的表先处理，只有名称的旧表（基础信息）后处理，
    // 这样旧表能按名称给已有物料回填类型/图号，而不是造出重复行。
    master_entries.sort_by_key(|(n, _)| {
        let has_code_sheet = n.contains("物料编号") || n.contains("编号");
        (if has_code_sheet { 0 } else { 1 }, n.clone())
    });

    let mut pivot_sheets = Vec::new();
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;

    for (name, range) in &master_entries {
        let rows_ref: Vec<&[Data]> = range.rows().collect();
        if rows_ref.is_empty() {
            continue;
        }
        // 月度「库存进销存报表」宽表（表头通常在第 2 行）：
        // 若用户在「基础资料」页直接选了进销存宽表工作簿，收集起来统一按跨月字典导入物料与库位。
        if let Some(parsed) = crate::pivot::read_sheet(name, &rows_ref) {
            pivot_sheets.push(parsed);
            continue;
        }

        let header: Vec<String> = rows_ref[0].iter().map(cell_text).collect();
        if header.is_empty() {
            continue;
        }
        let index_of = |candidates: &[&str], used: &[usize]| -> Option<usize> {
            index_of_column(&header, candidates, used)
        };

        // 出入库明细表也带「物料名称 / 物料编码」，以前会被当成物料表再导一遍，
        // 把台账流水（5802 + 1265 行）反复写回主数据，且不带类型。
        // 主数据只认台账之外的字典表；判据用「流水专有列」，不能看数量/金额——
        // 物料编号表自己也有「数量 / 单价 / 金额」三列。
        let flow_only = ["送货单号", "入库时间", "出库时间", "领用人", "采购人", "单号"];
        if flow_only.iter().any(|c| index_of(&[c], &[]).is_some())
            || ["明细", "单据", "库存"].iter().any(|k| name.contains(k))
        {
            continue;
        }

        // ---- 旧版「基础信息」表：只有名称、没有编码 ----
        // 这类行的物料在物料编号表里没有，但有类型（外购件/加工件）和单价，
        // 且其中一部分台账里真的在用，所以要补进主数据。
        // 没有编码时用「基础-<序号>」占位，避免和真实编码撞。
        let name_only = index_of(&["物料名称", "名称"], &[]);
        let has_code_col = index_of(&["物料编码序号", "物料编码", "编码"], &[]).is_some();
        // 「供应商名称」表也带「名称」列，不能走这个分支
        let looks_like_supplier_sheet =
            name.contains("供应商") || index_of(&["供应商名称"], &[]).is_some();
        if !has_code_col && !looks_like_supplier_sheet {
            if let Some(name_col) = name_only {
                let mut used = vec![name_col];
                let type_col = index_of(&["类型1", "类型"], &used);
                used.extend(type_col);
                let unit_col = index_of(&["单位"], &used);
                used.extend(unit_col);
                let price_col = index_of(&["单价"], &used);
                used.extend(price_col);
                let drawing_col = index_of(&["图号"], &used);
                let mut touched = 0usize;
                // 占位编码从库里已有的最大编号往后接，不能从 1 重数：
                // 从 1 重数会和上一轮导入占下的「基础-N」撞号，ON CONFLICT 一忽略，
                // 这一行就既没建出来、也没算进统计，重跑还会继续错位。
                let mut placeholder_seq = next_placeholder_seq(&tx)?;
                let mut stmt_find = tx
                    .prepare(
                        "SELECT id FROM items WHERE TRIM(item_name) = ?1
                         ORDER BY (item_type IS NULL) DESC, id LIMIT 1",
                    )
                    .map_err(DbError::from)?;
                let mut stmt_update = tx
                    .prepare(
                        "UPDATE items SET
                            item_type = COALESCE(NULLIF(?1,''), item_type),
                            drawing_no = COALESCE(NULLIF(?2,''), drawing_no),
                            unit = COALESCE(NULLIF(unit,''), NULLIF(?3,'')),
                            price_micros = COALESCE(price_micros, ?4)
                         WHERE id = ?5",
                    )
                    .map_err(DbError::from)?;
                let mut stmt_insert = tx
                    .prepare(
                        "INSERT INTO items (item_code, item_name, category, unit, price_micros, item_type, drawing_no)
                         VALUES (?1,?2,NULL,?3,?4,?5,?6)",
                    )
                    .map_err(DbError::from)?;

                for (row_index, row) in range.rows().enumerate() {
                    if row_index == 0 {
                        continue;
                    }
                    let get = |c: Option<usize>| -> String {
                        c.and_then(|i| row.get(i)).map(cell_text).unwrap_or_default()
                    };
                    // 这张表的布局是：B 列「图号」装外购件名称，C 列「名称」只填加工件。
                    // 所以名称取 C，C 空则回退 B；图号只在 C 有值时才另存。
                    let name_c = get(Some(name_col));
                    let name_b = get(drawing_col);
                    let (item_name, drawing) = if name_c.is_empty() {
                        (name_b.clone(), String::new())
                    } else {
                        (name_c.clone(), name_b.clone())
                    };
                    if item_name.is_empty() {
                        continue;
                    }
                    let item_type = get(type_col);
                    let unit = get(unit_col);
                    let price = price_col
                        .and_then(|i| row.get(i))
                        .and_then(cell_f64)
                        .map(to_micros);
                    // 先按同名找；同名有多条时优先补最缺类型的那条（通常是上一轮占位出来的）
                    let existing: Option<i64> = stmt_find
                        .query_row([&item_name], |r| r.get(0))
                        .ok();
                    match existing {
                        Some(id) => {
                            stmt_update
                                .execute(rusqlite::params![item_type, drawing, unit, price, id])
                                .map_err(DbError::from)?;
                            outcome.items_updated += 1;
                        }
                        None => {
                            let placeholder_code = format!("基础-{placeholder_seq}");
                            placeholder_seq += 1;
                            stmt_insert
                                .execute(rusqlite::params![
                                    placeholder_code,
                                    item_name,
                                    if unit.is_empty() { None } else { Some(unit) },
                                    price,
                                    if item_type.is_empty() { None } else { Some(item_type) },
                                    if drawing.is_empty() { None } else { Some(drawing) },
                                ])
                                .map_err(DbError::from)?;
                            outcome.items_added += 1;
                        }
                    }
                    touched += 1;
                }
                if touched > 0 && !outcome.sheets_found.iter().any(|n| n.starts_with(name)) {
                    outcome.sheets_found.push(format!("{name}（基础资料 {touched} 行）"));
                }
                continue;
            }
        }

        // ---- 物料表：需要有编码列 + 名称列 ----
        let code_col = index_of(&["物料编码序号", "物料编码", "编码"], &[]);
        let name_col = index_of(&["物料名称", "名称"], &[]);
        if let (Some(code_col), Some(name_col)) = (code_col, name_col) {
            let mut used = vec![code_col, name_col];
            let category_col = index_of(&["物料类别", "类别"], &used);
            used.extend(category_col);
            let unit_col = index_of(&["单位"], &used);
            used.extend(unit_col);
            let price_col = index_of(&["单价"], &used);
            used.extend(price_col);
            let owner_col = index_of(&["归属"], &used);
            used.extend(owner_col);
            let supplier_col = index_of(&["供应商名称", "供应商"], &used);
            used.extend(supplier_col);
            let remark_col = index_of(&["备注"], &used);

            let mut existing_map: std::collections::HashMap<String, i64> = {
                let mut stmt = tx
                    .prepare("SELECT item_code, id FROM items")
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                    .map_err(DbError::from)?;
                rows.filter_map(Result::ok).collect()
            };
            let mut stmt_update = tx
                .prepare(
                    "UPDATE items SET item_name=?1,
                        category=COALESCE(NULLIF(?2,''), category),
                        unit=COALESCE(NULLIF(?3,''), unit),
                        price_micros=COALESCE(?4, price_micros),
                        owner=COALESCE(NULLIF(?5,''), owner),
                        supplier=COALESCE(NULLIF(?6,''), supplier),
                        remark=COALESCE(NULLIF(remark,''), NULLIF(?7,'')),
                        updated_at=datetime('now','localtime')
                     WHERE id=?8",
                )
                .map_err(DbError::from)?;
            let mut stmt_insert = tx
                .prepare(
                    "INSERT INTO items (item_code, item_name, category, unit, price_micros, owner, supplier, remark)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                )
                .map_err(DbError::from)?;

            let mut touched = 0usize;
            for (row_index, row) in range.rows().enumerate() {
                if row_index == 0 {
                    continue;
                }
                let get = |c: Option<usize>| -> String { c.and_then(|i| row.get(i)).map(cell_text).unwrap_or_default() };
                let code = get(Some(code_col));
                let item_name = get(Some(name_col));
                if code.is_empty() || item_name.is_empty() {
                    continue;
                }
                let price = price_col
                    .and_then(|i| row.get(i))
                    .and_then(cell_f64)
                    .map(to_micros);
                let category = get(category_col);
                let unit = get(unit_col);
                let owner = get(owner_col);
                let supplier = get(supplier_col);
                let remark = get(remark_col);

                match existing_map.get(&code) {
                    Some(&id) => {
                        // 更新「字典」字段；备注保留用户填过的
                        stmt_update
                            .execute(rusqlite::params![
                                item_name,
                                category,
                                unit,
                                price,
                                owner,
                                supplier,
                                remark,
                                id
                            ])
                            .map_err(DbError::from)?;
                        outcome.items_updated += 1;
                    }
                    None => {
                        stmt_insert
                            .execute(rusqlite::params![
                                code,
                                item_name,
                                if category.is_empty() { None } else { Some(category) },
                                if unit.is_empty() { None } else { Some(unit) },
                                price,
                                if owner.is_empty() { None } else { Some(owner) },
                                if supplier.is_empty() { None } else { Some(supplier) },
                                if remark.is_empty() { None } else { Some(remark) },
                            ])
                            .map_err(DbError::from)?;
                        let new_id = tx.last_insert_rowid();
                        existing_map.insert(code, new_id);
                        outcome.items_added += 1;
                    }
                }
                touched += 1;
            }
            if touched > 0 && !outcome.sheets_found.contains(name) {
                // 这一表里编码重复的 12 行会落到同一行上，所以「新增 + 更新」可能小于 touched，属正常
                outcome.sheets_found.push(format!("{name}（表内 {touched} 行）"));
            }
            continue;
        }

        // ---- 供应商表：只有一列名称也能认 ----
        let supplier_col = index_of(&["供应商名称", "供应商"], &[]);
        if let Some(supplier_col) = supplier_col {
            let mut existing_suppliers: std::collections::HashSet<String> = {
                let mut stmt = tx
                    .prepare("SELECT name FROM suppliers")
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(DbError::from)?;
                rows.filter_map(Result::ok).collect()
            };
            let mut stmt_insert_supplier = tx
                .prepare("INSERT INTO suppliers (name) VALUES (?1)")
                .map_err(DbError::from)?;

            let mut touched = 0usize;
            for (row_index, row) in range.rows().enumerate() {
                if row_index == 0 {
                    continue;
                }
                let name = row.get(supplier_col).map(cell_text).unwrap_or_default();
                if name.is_empty() {
                    outcome.suppliers_skipped += 1;
                    continue;
                }
                if existing_suppliers.insert(name.clone()) {
                    stmt_insert_supplier
                        .execute([&name])
                        .map_err(DbError::from)?;
                    outcome.suppliers_added += 1;
                } else {
                    outcome.suppliers_skipped += 1;
                }
                touched += 1;
            }
            if touched > 0 && !outcome.sheets_found.contains(name) {
                outcome.sheets_found.push(format!("{name}（供应商 {touched} 行）"));
            }
        }
    }

    // 宽表物料与上面的物料/供应商写入同事务提交：
    // 以前先 commit 主表、再单独 upsert 宽表物料，后者失败会留下
    // 「物料编号表进来了，库位/规格却缺一半」的中间状态。
    if !pivot_sheets.is_empty() {
        let file_hint = path.file_name().and_then(|n| n.to_str());
        let built = crate::pivot::build_with_hint(
            &pivot_sheets,
            crate::import::current_year(),
            file_hint,
        );
        if !built.items.is_empty() {
            let (added, updated) = crate::pivot::upsert_items_tx(&tx, &built.items)?;
            let located = built
                .items
                .iter()
                .filter(|i| i.location.as_deref().is_some_and(|l| !l.trim().is_empty()))
                .count();
            outcome.items_added += added;
            outcome.items_updated += updated;
            outcome.sheets_found.push(format!(
                "月度进销存 {} 个月（物料 {} 个，含库位 {} 个）",
                built.months.len(),
                built.items.len(),
                located
            ));
        }
    }

    outcome.message = if outcome.sheets_found.is_empty() {
        "工作簿里没有找到物料编号/供应商名称表".to_string()
    } else {
        format!(
            "物料 +{} 更新{}，供应商 +{} 跳过{}",
            outcome.items_added, outcome.items_updated, outcome.suppliers_added, outcome.suppliers_skipped
        )
    };
    Ok(outcome)
}

// ---------- 导出 ----------

/// 物料导出：按当前筛选条件导出全部命中行（不分页），UTF-8 BOM 便于 Excel 直接打开。
///
/// 复用 `query_items`，`limit` 传 -1 表示 SQLite 不限条数——导出的必须和屏幕上
/// 筛出来的是同一批行，否则用户会以为漏数据。
pub fn export_items_csv(
    conn: &Connection,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    order: ItemOrder,
) -> DbResult<(String, i64)> {
    let rows = query_items(conn, keyword, category, item_type, only_active, with_drawing, -1, 0, order)?;
    let mut out = String::from("\u{feff}");
    out.push_str("物料编码,物料名称,库位,规格型号,单位,类型,类别,图号,参考单价,默认供应商,负责人,备注,状态\n");
    for item in &rows {
        let fields = [
            item.item_code.clone(),
            item.item_name.clone(),
            item.location.clone().unwrap_or_default(),
            item.spec.clone().unwrap_or_default(),
            item.unit.clone().unwrap_or_default(),
            item.item_type.clone().unwrap_or_default(),
            item.category.clone().unwrap_or_default(),
            item.drawing_no.clone().unwrap_or_default(),
            // 单价按万分之一元还原成元，Excel 里能直接当数字算
            item.price_micros.map(crate::ledger::micros_text).unwrap_or_default(),
            item.supplier.clone().unwrap_or_default(),
            item.owner.clone().unwrap_or_default(),
            item.remark.clone().unwrap_or_default(),
            if item.active { "在用" } else { "停用" }.to_string(),
        ];
        out.push_str(&crate::ledger::csv_row(&fields));
    }
    Ok((out, rows.len() as i64))
}

/// 供应商导出：带关键字过滤，和列表口径一致。
pub fn export_suppliers_csv(conn: &Connection, keyword: Option<&str>) -> DbResult<(String, i64)> {
    let rows = list_suppliers(conn, keyword)?;
    let mut out = String::from("\u{feff}");
    out.push_str("供应商名称,联系人,电话,台账行数,状态,备注\n");
    for s in &rows {
        let fields = [
            s.name.clone(),
            s.contact.clone().unwrap_or_default(),
            s.phone.clone().unwrap_or_default(),
            s.hits.to_string(),
            if s.active { "在用" } else { "停用" }.to_string(),
            s.remark.clone().unwrap_or_default(),
        ];
        out.push_str(&crate::ledger::csv_row(&fields));
    }
    Ok((out, rows.len() as i64))
}

/// 台账里出现过但主数据里没有的供应商，补进去（让下拉不漏）。
pub fn backfill_suppliers_from_ledger(conn: &Connection) -> DbResult<usize> {
    let added = conn
        .execute(
            "INSERT INTO suppliers (name)
             SELECT DISTINCT TRIM(partner) FROM ledger
             WHERE TRIM(COALESCE(partner,'')) <> ''
               AND TRIM(partner) NOT IN (SELECT name FROM suppliers)",
            [],
        )
        .map_err(|e| DbError::from(e).0)?;
    Ok(added)
}

/// 台账里出现过但主数据里没有的物料，补进去。
pub fn backfill_items_from_ledger(conn: &Connection) -> DbResult<usize> {
    let added = conn
        .execute(
            // 台账里有些行只有编码没有名称（老数据），用编码兜底，
            // 否则 item_name NOT NULL 会让整批补漏失败。
            "INSERT INTO items (item_code, item_name, spec, unit, price_micros)
             SELECT item_code,
                    COALESCE(NULLIF(TRIM(MAX(item_name)), ''), item_code),
                    MAX(spec),
                    MAX(unit),
                    (SELECT price_micros FROM ledger l2
                      WHERE l2.item_code = l.item_code AND l2.price_micros > 0
                      ORDER BY l2.doc_date DESC LIMIT 1)
             FROM ledger l
             WHERE TRIM(COALESCE(item_code,'')) <> ''
               AND item_code NOT IN (SELECT item_code FROM items)
             GROUP BY item_code",
            [],
        )
        .map_err(|e| DbError::from(e).0)?;
    Ok(added)
}

// ---------- 连接封装 ----------

pub fn list_items_db(
    db: &Db,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    limit: i64,
    offset: i64,
    recent: bool,
    order: ItemOrder,
) -> DbResult<Vec<Item>> {
    db.with(|c| {
        // 显式排序优先；没给就用 recent 决定默认顺序
        let pick = if order == ItemOrder::CodeAsc && recent {
            ItemOrder::NewestFirst
        } else {
            order
        };
        list_items_sorted(c, keyword, category, item_type, only_active, with_drawing, limit, offset, pick)
            .map_err(DbError)
    })
}

pub fn count_items_db(
    db: &Db,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
) -> DbResult<i64> {
    db.with(|c| count_items(c, keyword, category, item_type, only_active, with_drawing).map_err(DbError))
}

pub fn create_item_db(db: &Db, input: &ItemInput) -> DbResult<i64> {
    db.with(|c| create_item(c, input).map_err(DbError))
}

pub fn update_item_db(db: &Db, id: i64, input: &ItemInput) -> DbResult<()> {
    db.with(|c| update_item(c, id, input).map_err(DbError))
}

pub fn delete_item_db(db: &Db, id: i64) -> DbResult<()> {
    db.with(|c| delete_item(c, id).map_err(DbError))
}

pub fn find_item_db(db: &Db, code: &str) -> DbResult<Option<Item>> {
    db.with(|c| find_item_by_code(c, code).map_err(DbError))
}

pub fn list_suppliers_db(db: &Db, keyword: Option<&str>) -> DbResult<Vec<Supplier>> {
    db.with(|c| list_suppliers(c, keyword).map_err(DbError))
}

pub fn create_supplier_db(db: &Db, input: &SupplierInput) -> DbResult<i64> {
    db.with(|c| create_supplier(c, input).map_err(DbError))
}

pub fn update_supplier_db(db: &Db, id: i64, input: &SupplierInput) -> DbResult<()> {
    db.with(|c| update_supplier(c, id, input).map_err(DbError))
}

pub fn delete_supplier_db(db: &Db, id: i64) -> DbResult<()> {
    db.with(|c| delete_supplier(c, id).map_err(DbError))
}

pub fn stats_db(db: &Db) -> DbResult<MasterStats> {
    db.with(|c| stats(c).map_err(DbError))
}

pub fn import_workbook_db(db: &Db, path: &std::path::Path) -> DbResult<MasterImportOutcome> {
    db.with(|c| import_from_workbook(c, path).map_err(DbError))
}

pub fn backfill_db(db: &Db) -> DbResult<(usize, usize)> {
    db.with(|c| {
        let items = backfill_items_from_ledger(c).map_err(DbError)?;
        let suppliers = backfill_suppliers_from_ledger(c).map_err(DbError)?;
        Ok((items, suppliers))
    })
}

/// 物料导出（连接封装版）：桌面端命令直接用。
pub fn export_items_db(
    db: &Db,
    keyword: Option<&str>,
    category: Option<&str>,
    item_type: Option<&str>,
    only_active: bool,
    with_drawing: Option<bool>,
    order: ItemOrder,
) -> DbResult<(String, i64)> {
    db.with(|c| {
        export_items_csv(c, keyword, category, item_type, only_active, with_drawing, order)
            .map_err(DbError)
    })
}

/// 供应商导出（连接封装版）。
pub fn export_suppliers_db(db: &Db, keyword: Option<&str>) -> DbResult<(String, i64)> {
    db.with(|c| export_suppliers_csv(c, keyword).map_err(DbError))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn item(code: &str, name: &str) -> ItemInput {
        ItemInput {
            item_code: code.into(),
            item_name: name.into(),
            category: Some("五金类".into()),
            unit: Some("个".into()),
            price_micros: Some(1500000),
            spec: None,
            item_type: None,
            drawing_no: None,
            location: None,
            owner: None,
            supplier: None,
            remark: None,
            active: true,
        }
    }

    #[test]
    fn recent_order_puts_newest_first() {
        let db = db();
        // 编码故意与建立顺序无关，确认排的是建档先后不是编码
        for (code, name) in [("WG-Z-001", "最后建"), ("WG-A-001", "最先建"), ("WG-M-001", "中间建")] {
            db.with(|c| create_item(c, &item(code, name)).map_err(DbError)).unwrap();
        }
        // created_at 只到秒，这批全在同一秒内——正好验证 seq 能分先后
        let recent = db
            .with(|c| list_items_ordered(c, None, None, None, true, None, 50, 0, true).map_err(DbError))
            .unwrap();
        let codes: Vec<&str> = recent.iter().map(|i| i.item_code.as_str()).collect();
        assert_eq!(
            codes,
            vec!["WG-M-001", "WG-A-001", "WG-Z-001"],
            "应按建档先后倒序（最后建的 WG-M-001 在最前）"
        );

        // 再加一条，必须排到最前
        db.with(|c| create_item(c, &item("WG-B-002", "刚建的")).map_err(DbError)).unwrap();
        let recent = db
            .with(|c| list_items_ordered(c, None, None, None, true, None, 50, 0, true).map_err(DbError))
            .unwrap();
        assert_eq!(recent[0].item_code, "WG-B-002", "最新建的要在第一条");

        // 默认仍按编码排，基础资料列表不受影响
        let by_code = db
            .with(|c| list_items_ordered(c, None, None, None, true, None, 50, 0, false).map_err(DbError))
            .unwrap();
        let codes: Vec<&str> = by_code.iter().map(|i| i.item_code.as_str()).collect();
        assert_eq!(codes, vec!["WG-A-001", "WG-B-002", "WG-M-001", "WG-Z-001"]);
    }

    #[test]
    fn migration_backfills_seq_for_existing_rows() {
        let db = db();
        // 模拟老数据：三条 created_at 完全相同（同一批导入），seq 为空
        db.with(|c| {
            c.execute(
                "INSERT INTO items (item_code, item_name, created_at) VALUES
                 ('OLD-1','最早','2026-01-01 09:00:00'),
                 ('OLD-2','其次','2026-01-01 09:00:00'),
                 ('OLD-3','最晚','2026-01-01 09:00:00')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::from)
        })
        .unwrap();
        db.with(|c| {
            c.execute(
                "UPDATE items SET seq = (
                    SELECT COUNT(*) FROM items AS earlier
                    WHERE earlier.created_at < items.created_at
                       OR (earlier.created_at = items.created_at AND earlier.id <= items.id)
                 )",
                [],
            )
            .map(|_| ())
            .map_err(DbError::from)
        })
        .unwrap();

        // 回填后同秒的三条按 id 定先后，seq 必须互不相同
        let seqs: Vec<i64> = db
            .with(|c| {
                let mut stmt = c
                    .prepare("SELECT seq FROM items ORDER BY id")
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, i64>(0))
                    .map_err(DbError::from)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(DbError::from)?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(seqs, vec![1, 2, 3], "老数据回填成 1 2 3");
    }

    #[test]
    fn sort_orders_cover_all_modes() {
        let db = db();
        for (code, name) in [("WG-C", "丙"), ("WG-A", "甲"), ("WG-B", "乙")] {
            db.with(|c| create_item(c, &item(code, name)).map_err(DbError)).unwrap();
        }
        let codes = |order: ItemOrder| -> Vec<String> {
            db.with(|c| {
                list_items_sorted(c, None, None, None, true, None, 50, 0, order).map_err(DbError)
            })
            .unwrap()
            .into_iter()
            .map(|i| i.item_code)
            .collect()
        };

        assert_eq!(codes(ItemOrder::CodeAsc), vec!["WG-A", "WG-B", "WG-C"]);
        assert_eq!(codes(ItemOrder::CodeDesc), vec!["WG-C", "WG-B", "WG-A"]);
        // 建档顺序就是插入顺序 WG-C → WG-A → WG-B
        assert_eq!(codes(ItemOrder::NewestFirst), vec!["WG-B", "WG-A", "WG-C"]);
        assert_eq!(codes(ItemOrder::OldestFirst), vec!["WG-C", "WG-A", "WG-B"]);
        // 按名称：丙 乙 甲 的码位顺序
        assert_eq!(codes(ItemOrder::NameAsc), vec!["WG-C", "WG-B", "WG-A"]);
    }

    #[test]
    fn sort_key_parsing_falls_back_to_code() {
        assert_eq!(ItemOrder::parse(Some("newest")), ItemOrder::NewestFirst);
        assert_eq!(ItemOrder::parse(Some("oldest")), ItemOrder::OldestFirst);
        assert_eq!(ItemOrder::parse(Some("name")), ItemOrder::NameAsc);
        assert_eq!(ItemOrder::parse(Some("code_desc")), ItemOrder::CodeDesc);
        // 认不出来的值不能乱排，回落到编码升序
        assert_eq!(ItemOrder::parse(Some("bogus")), ItemOrder::CodeAsc);
        assert_eq!(ItemOrder::parse(None), ItemOrder::CodeAsc);
    }

    #[test]
    fn item_crud_round_trip() {
        let db = db();
        let id = db
            .with(|c| create_item(c, &item("WG-A", "外卡")).map_err(DbError))
            .unwrap();
        let found = db.with(|c| find_item_by_code(c, "WG-A").map_err(DbError)).unwrap().unwrap();
        assert_eq!(found.item_name, "外卡");
        assert_eq!(found.price_micros, Some(1_500_000));

        let mut patch = item("WG-A", "外卡（轴）");
        patch.price_micros = Some(1_700_000);
        db.with(|c| update_item(c, id, &patch).map_err(DbError)).unwrap();
        let found = db.with(|c| find_item_by_code(c, "WG-A").map_err(DbError)).unwrap().unwrap();
        assert_eq!(found.item_name, "外卡（轴）");
        assert_eq!(found.price_micros, Some(1_700_000));

        db.with(|c| delete_item(c, id).map_err(DbError)).unwrap();
        assert!(db.with(|c| find_item_by_code(c, "WG-A").map_err(DbError)).unwrap().is_none());
    }

#[test]
    fn item_type_and_drawing_round_trip() {
        let db = db();
        let mut with_type = item("WG-T-1", "轴承6204");
        with_type.item_type = Some("外购件".into());
        with_type.drawing_no = Some("QLKJ480-002.110".into());
        let id = db.with(|c| create_item(c, &with_type).map_err(DbError)).unwrap();

        let found = db.with(|c| find_item_by_code(c, "WG-T-1").map_err(DbError)).unwrap().unwrap();
        assert_eq!(found.item_type.as_deref(), Some("外购件"));
        assert_eq!(found.drawing_no.as_deref(), Some("QLKJ480-002.110"));

        let mut changed = with_type.clone();
        changed.item_type = Some("加工件".into());
        db.with(|c| update_item(c, id, &changed).map_err(DbError)).unwrap();
        let found = db.with(|c| find_item_by_code(c, "WG-T-1").map_err(DbError)).unwrap().unwrap();
        assert_eq!(found.item_type.as_deref(), Some("加工件"));
    }

    #[test]
    fn placeholder_seq_continues_after_existing_rows() {
        let db = db();
        for (code, name) in [("基础-1", "甲"), ("基础-7", "乙"), ("WG-A", "丙")] {
            db.with(|c| create_item(c, &item(code, name)).map_err(DbError))
                .unwrap();
        }
        // 已有 基础-1 / 基础-7，下一个必须是 8：从 1 重数会覆盖掉「基础-1」后面的行
        let next = db
            .with(|c| {
                let tx = c.unchecked_transaction().map_err(DbError::from)?;
                let n = next_placeholder_seq(&tx)?;
                drop(tx);
                Ok(n)
            })
            .unwrap();
        assert_eq!(next, 8);
    }

    #[test]
    fn duplicate_code_rejected() {        let db = db();
        db.with(|c| create_item(c, &item("WG-A", "x")).map_err(DbError)).unwrap();
        assert!(db.with(|c| create_item(c, &item("WG-A", "y")).map_err(DbError)).is_err());
    }

    #[test]
    fn search_and_category_filter() {
        let db = db();
        db.with(|c| {
            create_item(c, &item("WG-A-1", "螺丝"))?;
            create_item(c, &item("WG-B-1", "轴承"))?;
            let mut other = item("WG-C-1", "电机");
            other.category = Some("电机类".into());
            create_item(c, &other)?;
            Ok(())
        })
        .unwrap();

        let all = db.with(|c| list_items(c, None, None, None, true, None, 50, 0).map_err(DbError)).unwrap();
        assert_eq!(all.len(), 3);

        let by_name = db.with(|c| list_items(c, Some("轴"), None, None, true, None, 50, 0).map_err(DbError)).unwrap();
        assert_eq!(by_name.len(), 1);

        let by_cat = db.with(|c| list_items(c, None, Some("电机类"), None, true, None, 50, 0).map_err(DbError)).unwrap();
        assert_eq!(by_cat.len(), 1);
        assert_eq!(by_cat[0].item_code, "WG-C-1");
    }

    #[test]
    fn inactive_items_hidden_when_asked() {
        let db = db();
        db.with(|c| {
            let mut off = item("WG-OFF", "停用件");
            off.active = false;
            create_item(c, &off)?;
            create_item(c, &item("WG-ON", "在用品"))?;
            Ok(())
        })
        .unwrap();
        let active_only = db.with(|c| list_items(c, None, None, None, true, None, 50, 0).map_err(DbError)).unwrap();
        assert_eq!(active_only.len(), 1);
        let all = db.with(|c| list_items(c, None, None, None, false, None, 50, 0).map_err(DbError)).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn export_is_not_capped_at_page_size() {
        let db = db();
        // 列表单页上限 500，导出必须不受它限制，否则用户会以为数据被截断
        db.with(|c| {
            for i in 0..520 {
                c.execute(
                    "INSERT INTO items (item_code, item_name) VALUES (?1, ?2)",
                    rusqlite::params![format!("X-{i:04}"), format!("批量件{i}")],
                )
                .map_err(DbError::from)?;
            }
            Ok(())
        })
        .unwrap();
        let (_, n) = db
            .with(|c| export_items_csv(c, None, None, None, false, None, ItemOrder::CodeAsc).map_err(DbError))
            .unwrap();
        assert_eq!(n, 520);
    }

    #[test]
    fn supplier_crud_and_stats() {
        let db = db();
        db.with(|c| {
            create_supplier(
                c,
                &SupplierInput {
                    name: "万杨五金".into(),
                    contact: Some("王".into()),
                    phone: None,
                    remark: None,
                    active: true,
                },
            )
            .map_err(DbError)
        })
        .unwrap();
        assert!(db
            .with(|c| create_supplier(
                c,
                &SupplierInput {
                    name: "万杨五金".into(),
                    contact: None,
                    phone: None,
                    remark: None,
                    active: true
                }
            )
            .map_err(DbError))
            .is_err());

        db.with(|c| create_item(c, &item("WG-A", "x")).map_err(DbError)).unwrap();
        let stats = db.with(|c| stats(c).map_err(DbError)).unwrap();
        assert_eq!(stats.items, 1);
        assert_eq!(stats.suppliers, 1);
        assert_eq!(stats.categories.len(), 1);
        assert_eq!(stats.categories[0].category, "五金类");
        assert_eq!(stats.item_types.len(), 1);
        assert_eq!(stats.item_types[0].category, "未分类");
    }

    #[test]
    fn stats_uses_same_filter_as_list() {
        let db = db();
        db.with(|c| {
            create_item(c, &item("WG-A", "真物料")).map_err(DbError)?;
            // 粘贴残留：只有 '-' / '0' 的编码，列表里不显示，统计也不能算
            c.execute(
                "INSERT INTO items (item_code, item_name) VALUES ('-','残留'), ('0','残留')",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();
        let stats = db.with(|c| stats(c).map_err(DbError)).unwrap();
        let listed = db
            .with(|c| list_items_ordered(c, None, None, None, false, None, 50, 0, false).map_err(DbError))
            .unwrap();
        assert_eq!(stats.items, 1, "概览的物料总数必须和列表一致");
        assert_eq!(stats.items, listed.len() as i64);
    }

    #[test]
    fn header_guess_prefers_exact_and_skips_used_columns() {
        // 表头顺序会让「名称」先命中「供应商名称」
        let header: Vec<String> = ["编码", "供应商名称", "物料名称", "单位"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let code = index_of_column(&header, &["物料编码序号", "物料编码", "编码"], &[]);
        let name = index_of_column(&header, &["物料名称", "名称"], &[]);
        assert_eq!(code, Some(0));
        assert_eq!(name, Some(2), "必须命中「物料名称」而不是「供应商名称」");

        // 已被占用的列不能再被第二个字段认领
        let reused = index_of_column(&header, &["名称"], &[2]);
        assert_eq!(reused, Some(1), "去掉已占用列后应退到「供应商名称」");
    }

    #[test]
    fn export_items_respects_filters_and_escapes() {
        let db = db();
        db.with(|c| {
            let mut a = item("WG-A", "外卡,含逗号");
            a.location = Some("D-01".into());
            a.price_micros = Some(2_020);
            create_item(c, &a)?;
            let mut off = item("WG-B", "停用件");
            off.active = false;
            create_item(c, &off)?;
            let mut drawn = item("WG-C", "加工件");
            drawn.item_type = Some("加工件".into());
            drawn.drawing_no = Some("QLKJ480-002.110".into());
            create_item(c, &drawn)?;
            Ok(())
        })
        .unwrap();

        // 全部（含停用）：3 行 + 1 行列头
        let (csv, n) = db
            .with(|c| export_items_csv(c, None, None, None, false, None, ItemOrder::CodeAsc).map_err(DbError))
            .unwrap();
        assert_eq!(n, 3);
        assert!(csv.starts_with('\u{feff}'), "Excel 打开不能乱码");
        assert!(csv.contains("\"外卡,含逗号\""), "逗号字段要加引号");
        assert!(csv.contains("0.202"), "单价按元输出，保留厘级精度");

        // 只看在用 + 有图号：只剩加工件那条
        let (csv, n) = db
            .with(|c| export_items_csv(c, None, None, None, true, Some(true), ItemOrder::CodeAsc).map_err(DbError))
            .unwrap();
        assert_eq!(n, 1);
        assert!(csv.contains("QLKJ480-002.110"));
        assert!(!csv.contains("WG-A"));

        // 关键字过滤与列表口径一致
        let (_, n) = db
            .with(|c| export_items_csv(c, Some("WG-B"), None, None, false, None, ItemOrder::CodeAsc).map_err(DbError))
            .unwrap();
        assert_eq!(n, 1, "停用的也应当被关键字筛出来");
    }

    #[test]
    fn export_suppliers_uses_live_hits() {
        let db = db();
        db.with(|c| {
            create_supplier(
                c,
                &SupplierInput {
                    name: "万杨五金".into(),
                    contact: Some("王".into()),
                    phone: None,
                    remark: None,
                    active: true,
                },
            )?;
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, partner) VALUES ('t',1,'in','万杨五金'),('t',2,'in','万杨五金')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::from)
        })
        .unwrap();
        let (csv, n) = db.with(|c| export_suppliers_csv(c, None).map_err(DbError)).unwrap();
        assert_eq!(n, 1);
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("万杨五金"));
        assert!(csv.contains(",2,"), "台账行数应实时统计");
    }
}

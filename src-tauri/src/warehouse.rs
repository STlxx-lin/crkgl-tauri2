//! 多仓库：仓库档案与当前仓库解析。
//!
//! 边界：
//! - 业务数据（`ledger` / `vouchers` / `imports`）按 `warehouse_id` 隔离；
//! - 基础资料（`items` / `suppliers` / `dict`）全库通用，不按仓库分；
//! - 删除仓库会连同它的业务数据一起删，有数据时必须显式 `force`，
//!   并且始终至少保留一个仓库。
//!
//! 仓库名只用来给人看和排序，单据编号格式仍是 `YYYYMMDD` + 3 位流水，
//! 不掺仓库前缀——两个仓同号靠 `(warehouse_id, kind, doc_no)` 唯一索引分开。

use rusqlite::Connection;

use crate::db::{DbError, DbResult};

/// 设置表里保存「当前仓库」的键。
const ACTIVE_KEY: &str = "active_warehouse";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warehouse {
    pub id: i64,
    pub name: String,
    pub remark: Option<String>,
    /// 打印抬头（公司名，可带地址/电话，最多 3 行）；空表示纸面上不打这一行
    pub company_name: Option<String>,
    pub active: bool,
    pub sort_no: i64,
    /// 该仓库的台账行数（切仓库时给用户一个体量参考）
    pub ledger_rows: i64,
    /// 该仓库的单据张数
    pub vouchers: i64,
    /// 该仓库的导入批次
    pub imports: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseInput {
    pub name: String,
    #[serde(default)]
    pub remark: Option<String>,
    /// 打印抬头。`None` 表示「不改」（改名时前端只传改动的字段也无妨）；
    /// `Some("")` 表示清空。
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub sort_no: Option<i64>,
}

fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("仓库名称不能为空".into());
    }
    if name.chars().count() > 40 {
        return Err("仓库名称太长（最多 40 个字）".into());
    }
    Ok(name.to_string())
}

fn trim_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 打印抬头：允许换行（公司名 + 地址/电话），但拒绝空行挤在一起和超长。
///
/// 空字符串表示「不打这一行」，返回 `Ok(None)`。
fn clean_company(raw: &str) -> DbResult<Option<String>> {
    let lines: Vec<&str> = raw.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    if lines.is_empty() {
        return Ok(None);
    }
    if lines.len() > 3 {
        return Err("打印抬头最多 3 行".into());
    }
    if lines.iter().any(|line| line.chars().count() > 60) {
        return Err("打印抬头每行最多 60 个字".into());
    }
    Ok(Some(lines.join("\n")))
}

pub fn list(conn: &Connection) -> DbResult<Vec<Warehouse>> {
    let mut stmt = conn
        .prepare(
            "SELECT w.id, w.name, w.remark, w.company_name, w.active, w.sort_no, w.created_at,
                    (SELECT COUNT(*) FROM ledger   l WHERE l.warehouse_id = w.id),
                    (SELECT COUNT(*) FROM vouchers v WHERE v.warehouse_id = w.id),
                    (SELECT COUNT(*) FROM imports  i WHERE i.warehouse_id = w.id)
             FROM warehouses w
             ORDER BY w.sort_no, w.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Warehouse {
                id: r.get(0)?,
                name: r.get(1)?,
                remark: r.get(2)?,
                company_name: r.get(3)?,
                active: r.get::<_, i64>(4)? != 0,
                sort_no: r.get(5)?,
                created_at: r.get(6)?,
                ledger_rows: r.get(7)?,
                vouchers: r.get(8)?,
                imports: r.get(9)?,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> DbResult<Option<Warehouse>> {
    Ok(list(conn)?.into_iter().find(|w| w.id == id))
}

/// 当前仓库：读 `settings.active_warehouse`，失效或没设置时回落到第一个启用仓。
///
/// 只读、不写库——被删掉的仓库在这里自然回退，不会因为并发写入互相打断。
pub fn current_id(conn: &Connection) -> DbResult<i64> {
    let saved = get_setting_from(conn, ACTIVE_KEY).and_then(|v| v.parse::<i64>().ok());
    if let Some(id) = saved {
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM warehouses WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if exists > 0 {
            return Ok(id);
        }
    }
    conn.query_row(
        "SELECT id FROM warehouses ORDER BY active DESC, sort_no, id LIMIT 1",
        [],
        |r| r.get(0),
    )
    .map_err(|_| "还没有任何仓库，请先新建一个".to_string())
}

/// 写进 `settings`，下次启动仍停在同一个仓库。
pub fn set_current(conn: &Connection, id: i64) -> DbResult<()> {
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM warehouses WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("仓库不存在".into());
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![ACTIVE_KEY, id.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn create(conn: &Connection, input: &WarehouseInput) -> DbResult<i64> {
    let name = clean_name(&input.name)?;
    let dup: i64 = conn
        .query_row("SELECT COUNT(*) FROM warehouses WHERE name = ?1", [&name], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!("仓库「{name}」已经存在"));
    }
    let sort_no = match input.sort_no {
        Some(n) => n,
        None => conn
            .query_row("SELECT COALESCE(MAX(sort_no), 0) + 1 FROM warehouses", [], |r| r.get(0))
            .map_err(|e| e.to_string())?,
    };
    let company_name = match input.company_name.as_deref() {
        Some(raw) => clean_company(raw)?,
        None => None,
    };
    conn.execute(
        "INSERT INTO warehouses (name, remark, company_name, active, sort_no) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            name,
            trim_opt(&input.remark),
            company_name,
            if input.active.unwrap_or(true) { 1i64 } else { 0i64 },
            sort_no,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: &WarehouseInput) -> DbResult<()> {
    let name = clean_name(&input.name)?;
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM warehouses WHERE name = ?1 AND id <> ?2",
            rusqlite::params![name, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!("仓库「{name}」已经存在"));
    }
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM warehouses WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if before == 0 {
        return Err("仓库不存在".into());
    }
    // 停用最后一个启用仓会让界面没有落点，直接挡住
    if input.active == Some(false) {
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM warehouses WHERE active = 1 AND id <> ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if others == 0 {
            return Err("至少要保留一个启用的仓库".into());
        }
    }
    // 抬头：`None` 表示这次没传（保留原值），`Some("")` 表示清空。
    // 用一个 0/1 标志区分，避免 COALESCE 把「清空」当成「没传」。
    let (company_set, company_value) = match input.company_name.as_deref() {
        Some(raw) => (1i64, clean_company(raw)?),
        None => (0i64, None),
    };
    conn.execute(
        "UPDATE warehouses SET name = ?1, remark = ?2,
                company_name = CASE WHEN ?3 = 1 THEN ?4 ELSE company_name END,
                active = COALESCE(?5, active), sort_no = COALESCE(?6, sort_no)
         WHERE id = ?7",
        rusqlite::params![
            name,
            trim_opt(&input.remark),
            company_set,
            company_value,
            input.active.map(|v| if v { 1i64 } else { 0i64 }),
            input.sort_no,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub ledger_rows: usize,
    pub vouchers: usize,
    pub imports: usize,
}

/// 删仓库。有业务数据时必须 `force`，否则只报数量让用户确认。
///
/// 基础资料不动：物料/供应商/字典是共用档案，删一个仓库不该连带把另一个仓
/// 正在用的物料删掉。
pub fn delete(conn: &Connection, id: i64, force: bool) -> DbResult<DeleteOutcome> {
    let counts = get(conn, id)?.ok_or_else(|| "仓库不存在".to_string())?;
    let total = counts.ledger_rows + counts.vouchers + counts.imports;
    if total > 0 && !force {
        return Err(format!(
            "仓库「{}」还有 {} 行台账、{} 张单据、{} 次导入；确认要连数据一起删就再点一次",
            counts.name, counts.ledger_rows, counts.vouchers, counts.imports
        ));
    }
    // 至少保留一个仓库：不管删的是哪一个，最后一个都不许删
    let others: i64 = conn
        .query_row("SELECT COUNT(*) FROM warehouses WHERE id <> ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if others == 0 {
        return Err("至少要保留一个仓库".into());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let voucher_ids: Vec<i64> = {
        let mut stmt = tx
            .prepare("SELECT id FROM vouchers WHERE warehouse_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| r.get(0))
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| e.to_string())?;
        rows
    };
    for voucher_id in &voucher_ids {
        tx.execute("DELETE FROM ledger WHERE voucher_id = ?1", [voucher_id])
            .map_err(|e| e.to_string())?;
    }
    let ledger_rows = tx
        .execute("DELETE FROM ledger WHERE warehouse_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let vouchers = tx
        .execute("DELETE FROM vouchers WHERE warehouse_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let imports = tx
        .execute("DELETE FROM imports WHERE warehouse_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM warehouses WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // 删掉的正好是当前仓库：落回第一个
    if get_setting_from(conn, ACTIVE_KEY).and_then(|v| v.parse::<i64>().ok()) == Some(id) {
        if let Ok(next) = current_id(conn) {
            let _ = set_current(conn, next);
        }
    }
    Ok(DeleteOutcome {
        ledger_rows,
        vouchers,
        imports,
    })
}

// `db::get_setting` 需要 `&Db`，这里只有连接，直接读同一张表。
fn get_setting_from(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

// ---------- Db 包装 ----------

pub fn list_db(db: &crate::db::Db) -> DbResult<Vec<Warehouse>> {
    db.with(|c| list(c).map_err(DbError))
}

pub fn current_id_db(db: &crate::db::Db) -> DbResult<i64> {
    db.with(|c| current_id(c).map_err(DbError))
}

pub fn set_current_db(db: &crate::db::Db, id: i64) -> DbResult<()> {
    db.with(|c| set_current(c, id).map_err(DbError))
}

pub fn create_db(db: &crate::db::Db, input: &WarehouseInput) -> DbResult<i64> {
    db.with(|c| create(c, input).map_err(DbError))
}

pub fn update_db(db: &crate::db::Db, id: i64, input: &WarehouseInput) -> DbResult<()> {
    db.with(|c| update(c, id, input).map_err(DbError))
}

pub fn delete_db(db: &crate::db::Db, id: i64, force: bool) -> DbResult<DeleteOutcome> {
    db.with(|c| delete(c, id, force).map_err(DbError))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn mem() -> Db {
        Db::open_in_memory().expect("open")
    }

    #[test]
    fn migration_seeds_main_warehouse() {
        let db = mem();
        let rows = list_db(&db).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "主仓库");
        // 迁移 015 把原来写死在打印页上的公司名落到主仓库，升级后纸面不变
        assert_eq!(rows[0].company_name.as_deref(), Some("温州乾力机械有限公司"));
        assert_eq!(current_id_db(&db).unwrap(), rows[0].id);
    }

    #[test]
    fn create_rename_and_switch() {
        let db = mem();
        let id = create_db(
            &db,
            &WarehouseInput {
                name: " 二号仓 ".into(),
                remark: Some("备件".into()),
                company_name: Some("乾力机械 · 二号仓".into()),
                active: None,
                sort_no: None,
            },
        )
        .unwrap();
        assert_eq!(get_db_name(&db, id).as_deref(), Some("二号仓"));
        assert_eq!(get_db_company(&db, id).as_deref(), Some("乾力机械 · 二号仓"));
        set_current_db(&db, id).unwrap();
        assert_eq!(current_id_db(&db).unwrap(), id);

        update_db(
            &db,
            id,
            &WarehouseInput {
                name: "备件仓".into(),
                remark: None,
                company_name: None,
                active: Some(true),
                sort_no: Some(5),
            },
        )
        .unwrap();
        assert_eq!(get_db_name(&db, id).as_deref(), Some("备件仓"));
        // 没传 company_name 就是「不改」，不是清空
        assert_eq!(get_db_company(&db, id).as_deref(), Some("乾力机械 · 二号仓"));
    }

    /// 抬头可换行（公司名 + 地址/电话），空串表示清空，超过 3 行则拒绝。
    #[test]
    fn company_name_is_optional_multiline_and_clearable() {
        let db = mem();
        let id = create_db(
            &db,
            &WarehouseInput {
                name: "客户仓".into(),
                remark: None,
                company_name: Some("  某某贸易有限公司 \n  地址：温州 \n\n 电话：0577-1 \n".into()),
                active: None,
                sort_no: None,
            },
        )
        .unwrap();
        assert_eq!(
            get_db_company(&db, id).as_deref(),
            Some("某某贸易有限公司\n地址：温州\n电话：0577-1"),
            "空行要挤掉，前后空格要去掉"
        );

        // 清空
        update_db(
            &db,
            id,
            &WarehouseInput {
                name: "客户仓".into(),
                remark: None,
                company_name: Some("   ".into()),
                active: None,
                sort_no: None,
            },
        )
        .unwrap();
        assert_eq!(get_db_company(&db, id), None);

        // 超过 3 行
        assert!(update_db(
            &db,
            id,
            &WarehouseInput {
                name: "客户仓".into(),
                remark: None,
                company_name: Some("一\n二\n三\n四".into()),
                active: None,
                sort_no: None,
            },
        )
        .is_err());
    }

    #[test]
    fn rejects_duplicate_and_empty_names() {
        let db = mem();
        assert!(create_db(
            &db,
            &WarehouseInput {
                name: "主仓库".into(),
                remark: None,
                company_name: None,
                active: None,
                sort_no: None,
            }
        )
        .is_err());
        assert!(create_db(
            &db,
            &WarehouseInput {
                name: "   ".into(),
                remark: None,
                company_name: None,
                active: None,
                sort_no: None,
            }
        )
        .is_err());
    }

    #[test]
    fn delete_needs_force_and_keeps_master_data() {
        let db = mem();
        let id = create_db(
            &db,
            &WarehouseInput {
                name: "临时仓".into(),
                remark: None,
                company_name: None,
                active: None,
                sort_no: None,
            },
        )
        .unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, item_name, qty, warehouse_id)
                 VALUES ('t', 1, 'in', '螺丝', 10, ?1)",
                [id],
            )
            .map_err(DbError::from)?;
            c.execute("INSERT INTO items (item_code, item_name) VALUES ('WG-001', '螺丝')", [])
                .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        // 有数据不让删
        assert!(delete_db(&db, id, false).is_err());
        let out = delete_db(&db, id, true).unwrap();
        assert_eq!(out.ledger_rows, 1);
        // 基础资料保留
        let items: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(items, 1);
    }

    #[test]
    fn cannot_delete_last_warehouse() {
        let db = mem();
        let only = current_id_db(&db).unwrap();
        assert!(delete_db(&db, only, true).is_err());
    }

    #[test]
    fn current_id_falls_back_when_saved_is_gone() {
        let db = mem();
        db.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES ('active_warehouse', '999')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::from)
        })
        .unwrap();
        let id = current_id_db(&db).unwrap();
        assert!(id > 0);
        assert_eq!(list_db(&db).unwrap().iter().filter(|w| w.id == id).count(), 1);
    }

    fn get_db_name(db: &Db, id: i64) -> Option<String> {
        list_db(db).ok()?.into_iter().find(|w| w.id == id).map(|w| w.name)
    }

    fn get_db_company(db: &Db, id: i64) -> Option<String> {
        list_db(db)
            .ok()?
            .into_iter()
            .find(|w| w.id == id)
            .and_then(|w| w.company_name)
    }
}

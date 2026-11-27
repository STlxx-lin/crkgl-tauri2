//! SQLite 打开、迁移与连接封装。
//!
//! 数据库路径 `<app_data_dir>/ledger.db`，WAL 模式。迁移用 `user_version`
//! 记版本，每个迁移文件在 `MIGRATIONS` 里登记，新文件只允许往后追加。
//!
//! 连接模型：`Db` 持有一个 `Mutex<Connection>`。台账页一次查询是毫秒级，
//! 串行化足够；读多写少，不引连接池免得 Tauri 命令与 80 端口服务各拿一个
//! 写锁互相等。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

static MIGRATIONS: [(&str, &str); 16] = [
    ("001_init", include_str!("../migrations/001_init.sql")),
    ("002_voucher", include_str!("../migrations/002_voucher.sql")),
    ("003_master_data", include_str!("../migrations/003_master_data.sql")),
    (
        "004_price_precision",
        include_str!("../migrations/004_price_precision.sql"),
    ),
    ("005_item_type", include_str!("../migrations/005_item_type.sql")),
    ("006_cleanup", include_str!("../migrations/006_cleanup.sql")),
    ("007_cleanup_junk", include_str!("../migrations/007_cleanup_junk.sql")),
    ("008_item_location", include_str!("../migrations/008_item_location.sql")),
    ("009_dict", include_str!("../migrations/009_dict.sql")),
    ("010_stock_perf", include_str!("../migrations/010_stock_perf.sql")),
    ("011_import_perf", include_str!("../migrations/011_import_perf.sql")),
    ("012_item_seq", include_str!("../migrations/012_item_seq.sql")),
    ("013_ledger_perf", include_str!("../migrations/013_ledger_perf.sql")),
    ("014_warehouse", include_str!("../migrations/014_warehouse.sql")),
    (
        "015_warehouse_company",
        include_str!("../migrations/015_warehouse_company.sql"),
    ),
    ("016_return", include_str!("../migrations/016_return.sql")),
];

pub struct Db {
    conn: Mutex<Connection>,
    pub path: PathBuf,
}

/// 数据库层的错误。对外统一塌成 String，这里做内部中转，
/// 好处是 `?` 在 rusqlite::Error 与 DbError 之间都能直接用。
#[derive(Debug)]
pub struct DbError(pub String);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(err: rusqlite::Error) -> Self {
        DbError(format!("数据库错误: {err}"))
    }
}

impl From<String> for DbError {
    fn from(err: String) -> Self {
        DbError(err)
    }
}

impl From<DbError> for String {
    fn from(err: DbError) -> Self {
        err.0
    }
}

pub type DbResult<T> = Result<T, String>;

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        tune(&conn).map_err(|e| format!("初始化数据库失败: {e}"))?;
        backup_before_migrate(path, &conn);
        migrate(&conn).map_err(|e| format!("数据库迁移失败: {e}"))?;
        Ok(Db {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    /// 测试用：内存库，跑完整迁移。
    pub fn open_in_memory() -> Result<Db, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        tune(&conn).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        Ok(Db {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    /// 借出连接执行一段同步逻辑，返回值统一是 `Result<_, String>`。
    pub fn with<T, F>(&self, f: F) -> DbResult<T>
    where
        F: FnOnce(&Connection) -> Result<T, DbError>,
    {
        let guard = self
            .conn
            .lock()
            .map_err(|_| "数据库连接正忙（上一次操作未结束）".to_string())?;
        f(&guard).map_err(|e| e.0)
    }
}

fn tune(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "cache_size", -64000)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

/// 迁移前留一份快照，迁移失败也能手工回退。
///
/// 用 `VACUUM INTO` 而不是复制文件：WAL 模式下 `.db` 里可能缺最近的提交，
/// 直接复制会得到一份「旧但看起来正常」的库，比没有备份更危险。
fn backup_before_migrate(path: &Path, conn: &Connection) {
    if path == Path::new(":memory:") || !path.is_file() {
        return;
    }
    let backup = path.with_extension("db.bak");
    // 只保留最近一次「迁移前」快照，避免每次升级堆一个文件
    let _ = std::fs::remove_file(&backup);
    match conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().to_string()]) {
        Ok(_) => log::info!("迁移前已备份数据库到 {}", backup.display()),
        Err(err) => log::warn!("迁移前备份失败（继续迁移）: {err}"),
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name.eq_ignore_ascii_case(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn object_exists(conn: &Connection, kind: &str, name: &str) -> rusqlite::Result<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
        [kind, name],
        |r| r.get(0),
    )?;
    Ok(found > 0)
}

/// 该迁移带来的结构是否已经在库里。
///
/// `user_version` 只是「我们的记账」，可能落后于真实结构（历史中断、手工改库、
/// 只恢复了 `.db` 没恢复 `-wal`）。靠 `PRAGMA table_info` 看实际结构，才不会在
/// 已经存在的列上再 `ADD COLUMN` 撞出 `duplicate column name` 而彻底起不来。
///
/// 只对「纯结构」迁移返回真；006/007 这类数据订正每次都重跑（本身幂等）。
fn structure_already_applied(conn: &Connection, index: usize) -> rusqlite::Result<bool> {
    let has = |table: &str, column: &str| column_exists(conn, table, column);
    match index {
        // 001 建表
        0 => Ok(object_exists(conn, "table", "ledger")?
            && object_exists(conn, "table", "imports")?
            && object_exists(conn, "table", "settings")?
            && object_exists(conn, "table", "header_alias")?
            && object_exists(conn, "table", "access_log")?),
        // 002 单据
        1 => has("ledger", "voucher_id"),
        // 003 基础资料
        2 => Ok(object_exists(conn, "table", "items")? && object_exists(conn, "table", "suppliers")?),
        // 004 单价精度：新列已加、旧列已删才算完整
        3 => Ok(has("ledger", "price_micros")?
            && has("items", "price_micros")?
            && !has("ledger", "price_cents")?
            && !has("items", "price_cents")?),
        // 005 物料类型
        4 => Ok(has("items", "item_type")? && has("items", "drawing_no")?),
        // 006/007 是数据订正，不参与探测
        5 | 6 => Ok(false),
        // 008 库位
        7 => has("items", "location"),
        // 009 字典
        8 => object_exists(conn, "table", "dict"),
        // 010-013 索引（014 把其中几条换成了仓库前缀版，任一在即视作已生效）
        9 => {
            Ok(object_exists(conn, "index", "ix_ledger_stock_perf")?
                || object_exists(conn, "index", "ix_ledger_wh_item")?)
        }
        10 => Ok(object_exists(conn, "index", "ix_ledger_import_id")?
            || object_exists(conn, "index", "ix_ledger_wh_import")?),
        11 => Ok(has("items", "seq")? && object_exists(conn, "trigger", "trg_items_seq_ai")?),
        12 => {
            // 014 会把这两条旧索引换成仓库前缀版；两者任一在都算 013 已生效，
            // 免得版本号回退时又把旧索引建回来
            Ok((object_exists(conn, "index", "ix_ledger_date_id")?
                || object_exists(conn, "index", "ix_ledger_wh_date_id")?)
                && (object_exists(conn, "index", "ix_ledger_buyer")?
                    || object_exists(conn, "index", "ix_ledger_wh_buyer")?))
        }
        // 014 多仓库：仓库表在、三张业务表都有 warehouse_id 才算完整
        13 => Ok(object_exists(conn, "table", "warehouses")?
            && has("ledger", "warehouse_id")?
            && has("vouchers", "warehouse_id")?
            && has("imports", "warehouse_id")?),
        // 015 每仓打印抬头
        14 => has("warehouses", "company_name"),
        // 016 退货单：单据头与台账都要有 is_return 才算完整
        15 => Ok(has("vouchers", "is_return")? && has("ledger", "is_return")?),
        _ => Ok(false),
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let target = MIGRATIONS.len() as i64;
    if current > target {
        // 旧程序打开新版本数据库：继续读写未知结构只会写坏数据，直接拒绝启动，
        // 让用户看到「请升级程序」而不是后面某次查询莫名失败。
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!(
                "数据库版本 {current} 高于当前程序支持的 {target}，请升级到新版程序再打开"
            )),
        ));
    }
    for (index, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let next = (index + 1) as i64;
        if next <= current {
            continue;
        }
        if structure_already_applied(conn, index)? {
            // 结构已在、版本号没跟上：只补版本号，绝不重跑 DDL
            log::warn!("迁移 {name} 的结构已存在于库中，只补记版本号 {next}");
            conn.pragma_update(None, "user_version", next)?;
            continue;
        }
        // 迁移整体放进事务：要么结构和版本号一起落地，要么都不留痕迹。
        // 之前的写法先改结构再写 user_version，中断后会重复执行并撞上
        // "duplicate column name" —— 那正是升级一次就再也起不来的来源。
        let tx = conn.unchecked_transaction()?;
        if let Err(err) = tx.execute_batch(sql) {
            let hint = if err.to_string().contains("duplicate column") {
                "（库里已有该列但缺少其它结构，属于更新中断留下的半套结构；请用同目录下的 ledger.db.bak 恢复后重试）"
            } else {
                ""
            };
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(format!("迁移 {name} 失败: {err}{hint}")),
            ));
        }
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
        log::info!("已应用迁移 {name}");
    }
    Ok(())
}

/// 版本号给前端显示，方便排查“为什么字段没有”。
pub fn schema_version(db: &Db) -> i64 {
    db.with(|c| {
        c.query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(DbError::from)
    })
    .unwrap_or(0)
}

pub fn get_setting(db: &Db, key: &str) -> Option<String> {
    db.with(|c| {
        c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .map_err(DbError::from)
    })
    .ok()
}

pub fn set_setting(db: &Db, key: &str, value: &str) -> DbResult<()> {
    db.with(|c| {
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map(|_| ())
        .map_err(DbError::from)
    })
}

/// 访问日志先攒在内存里，再一次性写库。
///
/// 只读站每翻一页原本要起两个写事务（INSERT + 全表裁剪），而 `Db` 只有一条
/// `Mutex<Connection>`，局域网刷页面会跟本机开单抢锁。改成攒批：满 50 条或
/// 距上次落库超过 3 秒才写一次，`recent_access` 读之前强制刷一次，界面照样即时。
const ACCESS_BUFFER_MAX: usize = 50;
const ACCESS_FLUSH_SECS: f64 = 3.0;
const ACCESS_KEEP_ROWS: i64 = 500;

#[derive(Default)]
struct AccessBuffer {
    pending: Vec<(String, String, u16)>,
    last_flush: Option<std::time::Instant>,
}

static ACCESS_BUFFER: Mutex<Option<AccessBuffer>> = Mutex::new(None);

fn access_due(now: std::time::Instant, buf: &AccessBuffer) -> bool {
    if buf.pending.len() >= ACCESS_BUFFER_MAX {
        return true;
    }
    match buf.last_flush {
        Some(at) => now.duration_since(at).as_secs_f64() >= ACCESS_FLUSH_SECS,
        None => false,
    }
}

pub fn record_access(db: &Db, ip: &str, path: &str, status: u16) {
    let drained = {
        let mut guard = match ACCESS_BUFFER.lock() {
            Ok(guard) => guard,
            // 缓冲锁中毒：丢掉旧状态重新开始，访问日志不值得拖垮请求处理
            Err(poisoned) => poisoned.into_inner(),
        };
        let buf = guard.get_or_insert_with(AccessBuffer::default);
        buf.pending.push((ip.to_string(), path.to_string(), status));
        let now = std::time::Instant::now();
        if access_due(now, buf) {
            buf.last_flush = Some(now);
            std::mem::take(&mut buf.pending)
        } else {
            Vec::new()
        }
    };
    if drained.is_empty() {
        return;
    }
    write_access_batch(db, &drained);
}

/// 把缓冲里剩下的条目立刻落库（读取前 / 退出前调用）。
pub fn flush_access(db: &Db) {
    let pending = {
        let mut guard = match ACCESS_BUFFER.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let buf = guard.get_or_insert_with(AccessBuffer::default);
        buf.last_flush = Some(std::time::Instant::now());
        std::mem::take(&mut buf.pending)
    };
    if !pending.is_empty() {
        write_access_batch(db, &pending);
    }
}

fn write_access_batch(db: &Db, entries: &[(String, String, u16)]) {
    let _ = db.with(|c| {
        let tx = c.unchecked_transaction().map_err(DbError::from)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO access_log (at, ip, path, status)
                     VALUES (datetime('now', 'localtime'), ?1, ?2, ?3)",
                )
                .map_err(DbError::from)?;
            for (ip, path, status) in entries {
                stmt.execute(rusqlite::params![ip, path, status])
                    .map_err(DbError::from)?;
            }
        }
        // 只保留最近 500 条：用 `MIN(id)` 定位边界，避免每次都对全表排序再比较
        tx.execute(
            "DELETE FROM access_log WHERE id < (
                 SELECT MIN(id) FROM (SELECT id FROM access_log ORDER BY id DESC LIMIT ?1)
             )",
            [ACCESS_KEEP_ROWS],
        )
        .map_err(DbError::from)?;
        tx.commit().map_err(DbError::from)?;
        Ok(())
    });
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    pub at: String,
    pub ip: String,
    pub path: String,
    pub status: u16,
}

pub fn recent_access(db: &Db, limit: i64) -> DbResult<Vec<AccessEntry>> {
    // 缓冲里的条目还没落库，直接查会「刚访问的看不到」
    flush_access(db);
    db.with(|c| {
        let mut stmt = c
            .prepare("SELECT at, ip, path, status FROM access_log ORDER BY id DESC LIMIT ?1")
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([limit.clamp(1, 500)], |r| {
                Ok(AccessEntry {
                    at: r.get(0)?,
                    ip: r.get(1)?,
                    path: r.get(2)?,
                    status: r.get(3)?,
                })
            })
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(DbError::from)?;
        Ok(rows)
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutcome {
    pub ledger_rows: usize,
    pub vouchers: usize,
    pub imports: usize,
    pub items: usize,
    pub suppliers: usize,
    pub dict: usize,
}

/// 清空业务数据（按仓库）。
/// - 默认清空当前仓库的 `ledger`、`vouchers`、`imports`；
/// - `include_master` 为真时一并清空 `items`、`suppliers`、`dict`（这三张是**全库通用**的，
///   清的是所有仓库共用的档案，不是单个仓库的数据）；
/// - 写入 `settings.manual_clear = "1"`，防止下次启动自动回灌示例工作簿。
pub fn clear_data(db: &Db, include_master: bool, warehouse_id: i64) -> DbResult<ClearOutcome> {
    db.with(|c| {
        let tx = c.unchecked_transaction().map_err(DbError::from)?;
        let ledger_rows = tx
            .execute("DELETE FROM ledger WHERE warehouse_id = ?1", [warehouse_id])
            .map_err(DbError::from)?;
        let vouchers = tx
            .execute("DELETE FROM vouchers WHERE warehouse_id = ?1", [warehouse_id])
            .map_err(DbError::from)?;
        let imports = tx
            .execute("DELETE FROM imports WHERE warehouse_id = ?1", [warehouse_id])
            .map_err(DbError::from)?;
        let (items, suppliers, dict) = if include_master {
            let i = tx.execute("DELETE FROM items", []).map_err(DbError::from)?;
            let s = tx.execute("DELETE FROM suppliers", []).map_err(DbError::from)?;
            let d = tx.execute("DELETE FROM dict", []).map_err(DbError::from)?;
            (i, s, d)
        } else {
            (0, 0, 0)
        };
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('manual_clear', '1')
             ON CONFLICT(key) DO UPDATE SET value = '1'",
            [],
        )
        .map_err(DbError::from)?;
        tx.commit().map_err(DbError::from)?;
        Ok(ClearOutcome {
            ledger_rows,
            vouchers,
            imports,
            items,
            suppliers,
            dict,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_data_removes_ledger_and_optionally_master() {
        let db = Db::open_in_memory().expect("open");
        db.with(|c| {
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, item_name, qty) VALUES ('入库明细', 2, 'in', '螺丝', 10)",
                [],
            )
            .map_err(DbError::from)?;
            c.execute("INSERT INTO items (item_code, item_name) VALUES ('WG-001', '螺丝')", [])
                .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        let out1 = clear_data(&db, false, 1).unwrap();
        assert_eq!(out1.ledger_rows, 1);
        assert_eq!(out1.items, 0);
        assert_eq!(get_setting(&db, "manual_clear").as_deref(), Some("1"));

        let out2 = clear_data(&db, true, 1).unwrap();
        assert_eq!(out2.items, 1);
    }

    #[test]
    fn migration_is_idempotent_and_registers_version() {
        let db = Db::open_in_memory().expect("open");
        assert_eq!(schema_version(&db), MIGRATIONS.len() as i64);
        db.with(|c| migrate(c).map_err(DbError::from)).expect("re-migrate");
        let tables: i64 = db
            .with(|c| {
                c.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('ledger','imports','settings','header_alias','access_log')",
                    [],
                    |r| r.get(0),
                )
                .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(tables, 5);
    }

    /// 旧程序打开新版本数据库：必须明确报错，不能继续读写未知结构。
    #[test]
    fn newer_database_version_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        tune(&conn).unwrap();
        migrate(&conn).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        let err = migrate(&conn).unwrap_err();
        assert!(err.to_string().contains("请升级"), "实际 {err}");
    }

    /// `user_version` 落后于真实结构（中断/手工改库）时只补版本号，
    /// 不重跑 DDL —— 否则 002 的 ALTER 会撞 duplicate column 让程序起不来。
    #[test]
    fn lagging_version_with_complete_structure_only_bumps_version() {
        let conn = Connection::open_in_memory().unwrap();
        tune(&conn).unwrap();
        migrate(&conn).unwrap();
        // 假装只是版本号丢了：结构与最高版本一致
        conn.pragma_update(None, "user_version", 11).unwrap();
        migrate(&conn).expect("结构已完整时不该重跑 DDL");
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn settings_round_trip() {
        let db = Db::open_in_memory().unwrap();
        assert!(get_setting(&db, "port").is_none());
        set_setting(&db, "port", "8080").unwrap();
        set_setting(&db, "port", "80").unwrap();
        assert_eq!(get_setting(&db, "port").as_deref(), Some("80"));
    }

    #[test]
    fn access_log_keeps_newest_and_caps_rows() {
        let db = Db::open_in_memory().unwrap();
        for _ in 0..510 {
            record_access(&db, "192.168.1.5", "/api/ledger/page", 200);
        }
        let rows = recent_access(&db, 5).unwrap();
        assert_eq!(rows.len(), 5);
        let total: i64 = db
            .with(|c| {
                c.query_row("SELECT COUNT(*) FROM access_log", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(total, 500);
    }
}

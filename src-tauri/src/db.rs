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

static MIGRATIONS: [(&str, &str); 11] = [
    ("001_init", include_str!("../migrations/001_init.sql")),
    ("002_voucher", include_str!("../migrations/002_voucher.sql")),
    ("003_master_data", include_str!("../migrations/003_master_data.sql")),
    ("004_price_precision", include_str!("../migrations/004_price_precision.sql")),
    ("005_item_type", include_str!("../migrations/005_item_type.sql")),
    ("006_cleanup", include_str!("../migrations/006_cleanup.sql")),
    ("007_cleanup_junk", include_str!("../migrations/007_cleanup_junk.sql")),
    ("008_item_location", include_str!("../migrations/008_item_location.sql")),
    ("009_dict", include_str!("../migrations/009_dict.sql")),
    ("010_stock_perf", include_str!("../migrations/010_stock_perf.sql")),
    ("011_import_perf", include_str!("../migrations/011_import_perf.sql")),
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

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let target = MIGRATIONS.len() as i64;
    if current > target {
        // 老版本程序打开了新版本数据库：不静默降级，只在日志里提示
        log::warn!("数据库版本 {current} 高于当前程序支持的 {target}");
        return Ok(());
    }
    for (index, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let next = (index + 1) as i64;
        if next <= current {
            continue;
        }
        // 迁移整体放进事务：要么结构和版本号一起落地，要么都不留痕迹。
        // 之前的写法先改结构再写 user_version，中断后会重复执行并撞上
        // "duplicate column name" —— 那正是升级一次就再也起不来的来源。
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
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

pub fn record_access(db: &Db, ip: &str, path: &str, status: u16) {
    let _ = db.with(|c| {
        c.execute(
            "INSERT INTO access_log (at, ip, path, status)
             VALUES (datetime('now', 'localtime'), ?1, ?2, ?3)",
            rusqlite::params![ip, path, status],
        )
        .map_err(DbError::from)?;
        c.execute(
            "DELETE FROM access_log WHERE id NOT IN (SELECT id FROM access_log ORDER BY id DESC LIMIT 500)",
            [],
        )
        .map_err(DbError::from)?;
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

/// 清空业务数据。
/// - 默认清空 `ledger`、`vouchers`、`imports`；
/// - `include_master` 为真时一并清空 `items`、`suppliers`、`dict`；
/// - 写入 `settings.manual_clear = "1"`，防止下次启动自动回灌示例工作簿。
pub fn clear_data(db: &Db, include_master: bool) -> DbResult<ClearOutcome> {
    db.with(|c| {
        let tx = c.unchecked_transaction().map_err(DbError::from)?;
        let ledger_rows = tx.execute("DELETE FROM ledger", []).map_err(DbError::from)?;
        let vouchers = tx.execute("DELETE FROM vouchers", []).map_err(DbError::from)?;
        let imports = tx.execute("DELETE FROM imports", []).map_err(DbError::from)?;
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
            c.execute(
                "INSERT INTO items (item_code, item_name) VALUES ('WG-001', '螺丝')",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();

        let out1 = clear_data(&db, false).unwrap();
        assert_eq!(out1.ledger_rows, 1);
        assert_eq!(out1.items, 0);
        assert_eq!(get_setting(&db, "manual_clear").as_deref(), Some("1"));

        let out2 = clear_data(&db, true).unwrap();
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

//! 字典：单位 / 类别 / 类型 / 出库部门 / 采购人。
//!
//! 这五类是录入时反复要填的文字字段，散在 `items` 与 `ledger` 两张表里。
//! 原来每次都得现查一遍历史值拼下拉，同一个部门「470FQ/1台」和「470FQ/一台」
//! 各存一份，统计时被拆成两组。现在统一收在 `dict` 表：
//!   · 开单 / 物料表单从字典取候选，选不到可以现输（输完自动补进字典）；
//!   · 基础资料页可以改名、停用、删除、排序；
//!   · 改名会同步改写台账与物料里用到该值的行，把错别字一次修干净。

use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError, DbResult};

/// 支持的字典类别。顺序就是界面上的显示顺序。
pub const KINDS: [&str; 5] = ["unit", "category", "item_type", "owner", "buyer"];

pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "unit" => "单位",
        "category" => "类别",
        "item_type" => "类型",
        "owner" => "出库部门",
        "buyer" => "采购人",
        _ => "字典",
    }
}

fn check_kind(kind: &str) -> DbResult<()> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("不支持的字典类别: {kind}"))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub id: i64,
    pub kind: String,
    pub value: String,
    pub sort_no: i64,
    pub hits: i64,
    pub remark: Option<String>,
    pub active: bool,
    /// 台账/物料里实际用到这个值的行数（实时算，用于「停用前先看影响」）
    pub used: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictInput {
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub sort_no: Option<i64>,
    pub remark: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictKindCount {
    pub kind: String,
    pub label: String,
    pub total: i64,
    pub active: i64,
}

fn trim_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 某个值在业务表里出现在哪一列。改字典值时按这张表回写。
fn usage_sql(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "unit" => Some(("items", "unit")),
        "category" => Some(("items", "category")),
        "item_type" => Some(("items", "item_type")),
        "owner" => Some(("ledger", "owner")),
        "buyer" => Some(("ledger", "buyer")),
        _ => None,
    }
}

fn usage_count(conn: &Connection, kind: &str, value: &str) -> i64 {
    let Some((table, column)) = usage_sql(kind) else {
        return 0;
    };
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE TRIM({column}) = ?1"),
        [value],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 字典列表。`hit` 记过的使用次数和实时统计各算一份，取大的那个展示。
pub fn list(conn: &Connection, kind: &str, keyword: Option<&str>, only_active: bool) -> DbResult<Vec<DictEntry>> {
    check_kind(kind)?;
    let like = keyword
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|k| format!("%{k}%"));
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, value, sort_no, hits, remark, active
             FROM dict
             WHERE kind = ?1
               AND (?2 IS NULL OR value LIKE ?2)
               AND (?3 = 0 OR active = 1)
             ORDER BY sort_no, hits DESC, value",
        )
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map(rusqlite::params![kind, like, only_active as i64], |r| {
            let active: i64 = r.get(6)?;
            Ok(DictEntry {
                id: r.get(0)?,
                kind: r.get(1)?,
                value: r.get(2)?,
                sort_no: r.get(3)?,
                hits: r.get(4)?,
                remark: r.get(5)?,
                active: active != 0,
                used: 0,
            })
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(DbError::from)?;
    // 使用次数单独算：这里量不大（几百条），一条一条查比写子查询清楚
    Ok(rows
        .into_iter()
        .map(|mut entry| {
            entry.used = usage_count(conn, kind, &entry.value);
            entry.hits = entry.hits.max(entry.used);
            entry
        })
        .collect())
}

pub fn kind_counts(conn: &Connection) -> DbResult<Vec<DictKindCount>> {
    let mut out = Vec::with_capacity(KINDS.len());
    for kind in KINDS {
        let (total, active): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(active),0) FROM dict WHERE kind = ?1",
                [kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(DbError::from)?;
        out.push(DictKindCount {
            kind: kind.to_string(),
            label: kind_label(kind).to_string(),
            total,
            active,
        });
    }
    Ok(out)
}

pub fn create(conn: &Connection, input: &DictInput) -> DbResult<i64> {
    let kind = input.kind.trim();
    check_kind(kind)?;
    let value = input.value.trim();
    if value.is_empty() {
        return Err("字典值不能为空".into());
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM dict WHERE kind = ?1 AND value = ?2",
            rusqlite::params![kind, value],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if dup > 0 {
        return Err(format!("{}里已经有「{value}」", kind_label(kind)));
    }
    conn.execute(
        "INSERT INTO dict (kind, value, sort_no, remark, active) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![
            kind,
            value,
            input.sort_no.unwrap_or(0),
            trim_opt(&input.remark),
            input.active as i64,
        ],
    )
    .map_err(DbError::from)?;
    Ok(conn.last_insert_rowid())
}

/// 改字典值。改了文字就把台账/物料里用到旧值的行一起改掉，
/// 否则「改名」只是把一个没人用的新词加进候选，旧数据还散着。
pub fn update(conn: &Connection, id: i64, input: &DictInput) -> DbResult<usize> {
    let kind = input.kind.trim();
    check_kind(kind)?;
    let value = input.value.trim();
    if value.is_empty() {
        return Err("字典值不能为空".into());
    }
    let old: (String, String) = conn
        .query_row("SELECT kind, value FROM dict WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError("字典项不存在".into()),
            other => DbError::from(other),
        })?;
    if old.0 != kind {
        return Err("不能把字典项改成别的类别".into());
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM dict WHERE kind = ?1 AND value = ?2 AND id <> ?3",
            rusqlite::params![kind, value, id],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if dup > 0 {
        return Err(format!("{}里已经有「{value}」", kind_label(kind)));
    }

    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    tx.execute(
        "UPDATE dict SET value=?1, sort_no=?2, remark=?3, active=?4,
                updated_at=datetime('now','localtime')
         WHERE id=?5",
        rusqlite::params![
            value,
            input.sort_no.unwrap_or(0),
            trim_opt(&input.remark),
            input.active as i64,
            id,
        ],
    )
    .map_err(DbError::from)?;

    let mut touched = 0usize;
    if old.1 != value {
        if let Some((table, column)) = usage_sql(kind) {
            touched = tx
                .execute(
                    &format!("UPDATE {table} SET {column} = ?1 WHERE TRIM({column}) = ?2"),
                    rusqlite::params![value, old.1],
                )
                .map_err(DbError::from)?;
        }
    }
    tx.commit().map_err(DbError::from)?;
    Ok(touched)
}

pub fn delete(conn: &Connection, id: i64) -> DbResult<()> {
    let (kind, value): (String, String) = conn
        .query_row("SELECT kind, value FROM dict WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError("字典项不存在".into()),
            other => DbError::from(other),
        })?;
    let used = usage_count(conn, &kind, &value);
    if used > 0 {
        return Err(format!(
            "「{value}」还有 {used} 行在用，先停用或改名，别直接删"
        ));
    }
    conn.execute("DELETE FROM dict WHERE id = ?1", [id])
        .map_err(DbError::from)?;
    Ok(())
}

/// 批量写：给台账导入 / 主数据导入后补登记用。已存在就把 hits 累加。
pub fn touch(tx: &Transaction<'_>, kind: &str, value: &str, extra_hits: i64) {
    let value = value.trim();
    if value.is_empty() || !KINDS.contains(&kind) {
        return;
    }
    let _ = tx.execute(
        "INSERT INTO dict (kind, value, hits) VALUES (?1, ?2, ?3)
         ON CONFLICT(kind, value) DO UPDATE SET hits = hits + ?3, updated_at = datetime('now','localtime')",
        rusqlite::params![kind, value, extra_hits.max(0)],
    );
}

/// 批量登记字典：接受按 (kind, value) 聚合好的计数映射，使用预编译语句一次性完成更新。
pub fn touch_many<'a, I>(tx: &Transaction<'_>, items: I)
where
    I: IntoIterator<Item = (&'a str, &'a str, i64)>,
{
    let mut stmt = match tx.prepare_cached(
        "INSERT INTO dict (kind, value, hits) VALUES (?1, ?2, ?3)
         ON CONFLICT(kind, value) DO UPDATE SET hits = hits + ?3, updated_at = datetime('now','localtime')",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };

    for (kind, value, hits) in items {
        let value = value.trim();
        if value.is_empty() || !KINDS.contains(&kind) || hits <= 0 {
            continue;
        }
        let _ = stmt.execute(rusqlite::params![kind, value, hits]);
    }
}

/// 从现有物料与台账重新扫一遍，把字典里缺的值补上。
/// 手工改过专有名词之后跑一次，能立刻看到还差哪些写法。
pub fn sync_from_data(conn: &Connection) -> DbResult<usize> {
    let tx = conn.unchecked_transaction().map_err(DbError::from)?;
    let before: i64 = tx
        .query_row("SELECT COUNT(*) FROM dict", [], |r| r.get(0))
        .map_err(DbError::from)?;

    let sources: [(&str, &str, &str); 5] = [
        ("unit", "items", "unit"),
        ("category", "items", "category"),
        ("item_type", "items", "item_type"),
        ("owner", "ledger", "owner"),
        ("buyer", "ledger", "buyer"),
    ];
    for (kind, table, column) in sources {
        tx.execute(
            &format!(
                "INSERT INTO dict (kind, value, hits)
                 SELECT ?1, TRIM({column}), COUNT(*)
                 FROM {table}
                 WHERE TRIM(COALESCE({column}, '')) NOT IN ('', '0', '旧版基础信息')
                 GROUP BY TRIM({column})
                 ON CONFLICT(kind, value) DO UPDATE SET hits = MAX(hits, excluded.hits)"
            ),
            [kind],
        )
        .map_err(DbError::from)?;
    }
    let after: i64 = tx
        .query_row("SELECT COUNT(*) FROM dict", [], |r| r.get(0))
        .map_err(DbError::from)?;
    tx.commit().map_err(DbError::from)?;
    Ok((after - before).max(0) as usize)
}

// ---------- Db 包装 ----------

pub fn list_db(db: &Db, kind: &str, keyword: Option<&str>, only_active: bool) -> DbResult<Vec<DictEntry>> {
    db.with(|c| list(c, kind, keyword, only_active).map_err(DbError))
}

pub fn kind_counts_db(db: &Db) -> DbResult<Vec<DictKindCount>> {
    db.with(|c| kind_counts(c).map_err(DbError))
}

pub fn create_db(db: &Db, input: &DictInput) -> DbResult<i64> {
    db.with(|c| create(c, input).map_err(DbError))
}

pub fn update_db(db: &Db, id: i64, input: &DictInput) -> DbResult<usize> {
    db.with(|c| update(c, id, input).map_err(DbError))
}

pub fn delete_db(db: &Db, id: i64) -> DbResult<()> {
    db.with(|c| delete(c, id).map_err(DbError))
}

pub fn sync_db(db: &Db) -> DbResult<usize> {
    db.with(|c| sync_from_data(c).map_err(DbError))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed(db: &Db) {
        db.with(|c| {
            c.execute(
                "INSERT INTO items (item_code, item_name, unit, category, item_type)
                 VALUES ('WG-1','外卡','个','五金类','外购件'),
                        ('WG-2','轴承','只','轴承类','外购件')",
                [],
            )
            .map_err(DbError::from)?;
            c.execute(
                "INSERT INTO ledger (sheet, row_no, kind, owner, buyer) VALUES
                 ('t',1,'out','乾力车间','严兰兰'), ('t',2,'out','乾力车间','周梓棋')",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn sync_picks_up_existing_values() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        let added = sync_db(&db).unwrap();
        assert!(added >= 5, "五个类别都应有值，实际 {added}");
        let units = list_db(&db, "unit", None, false).unwrap();
        let values: Vec<_> = units.iter().map(|u| u.value.as_str()).collect();
        assert!(values.contains(&"个") && values.contains(&"只"));
        let owners = list_db(&db, "owner", None, false).unwrap();
        assert_eq!(owners[0].value, "乾力车间");
        assert_eq!(owners[0].used, 2);
    }

    #[test]
    fn rename_propagates_to_business_rows() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        sync_db(&db).unwrap();
        let owner = list_db(&db, "owner", Some("乾力"), false).unwrap().remove(0);
        let touched = update_db(
            &db,
            owner.id,
            &DictInput {
                kind: "owner".into(),
                value: "乾力总装车间".into(),
                sort_no: None,
                remark: None,
                active: true,
            },
        )
        .unwrap();
        assert_eq!(touched, 2);
        let after = list_db(&db, "owner", None, false).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].value, "乾力总装车间");
    }

    #[test]
    fn delete_refuses_when_in_use() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        sync_db(&db).unwrap();
        let unit = list_db(&db, "unit", Some("个"), false).unwrap().remove(0);
        assert!(delete_db(&db, unit.id).is_err());
    }

    #[test]
    fn create_rejects_duplicates_and_unknown_kind() {
        let db = Db::open_in_memory().unwrap();
        let ok = DictInput {
            kind: "unit".into(),
            value: "卷".into(),
            sort_no: None,
            remark: None,
            active: true,
        };
        create_db(&db, &ok).unwrap();
        assert!(create_db(&db, &ok).is_err());
        let bad = DictInput {
            kind: "nope".into(),
            ..ok
        };
        assert!(create_db(&db, &bad).is_err());
    }

    #[test]
    fn kind_counts_covers_all_five() {
        let db = Db::open_in_memory().unwrap();
        seed(&db);
        sync_db(&db).unwrap();
        let counts = kind_counts_db(&db).unwrap();
        assert_eq!(counts.len(), 5);
        assert_eq!(counts[0].kind, "unit");
        assert!(counts.iter().all(|c| c.total >= 1));
    }
}

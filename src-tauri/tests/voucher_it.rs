//! 开单与批量的端到端测试：直接跑在临时数据库上，验证
//! 迁移 → 开单 → 台账可见 → 批量改 → 批量删 → 单据头清理 这条完整链路。
//!
//! 用临时文件库而不是内存库，确保 001/002 两个迁移都在真实文件上跑过。

use std::sync::Arc;

use warehouse_ledger_lib::db::Db;
use warehouse_ledger_lib::ledger::{self, BulkPatch, LedgerFilter};
use warehouse_ledger_lib::voucher::{self, VoucherInput, VoucherLineInput};

fn temp_db() -> (Db, std::path::PathBuf) {
    // 用随机数而不是时间戳：cargo test 并行时同一毫秒内会撞名，
    // 第二个测试就会打开已经迁移过的库并撞上 "duplicate column"。
    let nonce: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let dir = std::env::temp_dir().join(format!("ledger-it-{nonce}"));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("ledger.db");
    let db = Db::open(&path).expect("open db");
    (db, dir)
}

fn line(code: &str, name: &str, qty: f64, price: Option<i64>) -> VoucherLineInput {
    VoucherLineInput {
        delivery_no: None,
        item_code: Some(code.into()),
        item_name: Some(name.into()),
        unit: Some("个".into()),
        qty: Some(qty),
        price_micros: price,
        remark: None,
    }
}

fn line_with_delivery(code: &str, qty: f64, delivery: Option<&str>) -> VoucherLineInput {
    VoucherLineInput {
        delivery_no: delivery.map(str::to_string),
        ..line(code, code, qty, None)
    }
}

fn voucher(kind: &str, date: &str, lines: Vec<VoucherLineInput>) -> VoucherInput {
    VoucherInput {
        kind: kind.into(),
        doc_no: None,
        doc_date: Some(date.into()),
        partner: Some("万杨五金".into()),
        delivery_no: Some("0023378".into()),
        buyer: Some("严兰兰".into()),
        owner: if kind == "out" { Some("乾力车间".into()) } else { None },
        receiver: None,
        remark: None,
        lines,
    }
}

#[test]
fn voucher_round_trip_appears_in_ledger() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    // 1) 开一张入库单
    let id = voucher::create_db(&db, &voucher("in", "2026-09-01", vec![
        line("WG-A", "外卡", 10.0, Some(15_000)),
        line("WG-B", "轴承", 2.0, Some(100_000)),
    ]))
    .expect("create voucher");
    assert!(id > 0);

    // 2) 单头与明细
    let saved = voucher::get_db(&db, id).expect("get").expect("exists");
    assert_eq!(saved.doc_no, "20260901001");
    assert_eq!(saved.row_count, 2);
    assert_eq!(saved.amount_cents, 10 * 150 + 2 * 1000);
    assert_eq!(saved.sheet, "voucher:in");

    // 3) 台账里能查到这两行
    let page = db
        .with(|c| ledger::page(c, &LedgerFilter::default(), 1, 50).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("page");
    assert_eq!(page.total, 2, "开单产生的行应出现在台账");
    assert!(page.rows.iter().all(|r| r.sheet == "voucher:in"));
    let ids: Vec<i64> = page.rows.iter().map(|r| r.id).collect();

    // 4) 批量改归属
    let changed = db
        .with(|c| {
            ledger::bulk_update(c, &ids, &BulkPatch {
                owner: Some("批量归属".into()),
                ..Default::default()
            })
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .expect("bulk update");
    assert_eq!(changed, 2);
    let page = db
        .with(|c| ledger::page(c, &LedgerFilter::default(), 1, 50).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("page2");
    assert!(page.rows.iter().all(|r| r.owner.as_deref() == Some("批量归属")));

    // 5) 批量删掉这两行 → 单据头应被一起清掉
    let removed = db
        .with(|c| ledger::bulk_delete(c, &ids).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("bulk delete");
    assert_eq!(removed, 2);
    assert!(
        voucher::get_db(&db, id).expect("get after delete").is_none(),
        "明细删空后单据头也要清掉"
    );

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn out_voucher_and_in_voucher_number_independently() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    let in_id = voucher::create_db(&db, &voucher("in", "2026-09-02", vec![line("A", "x", 1.0, Some(10_000))]))
        .expect("in");
    let out_id = voucher::create_db(&db, &voucher("out", "2026-09-02", vec![line("A", "x", 3.0, None)]))
        .expect("out");

    let in_v = voucher::get_db(&db, in_id).expect("get in").expect("in exists");
    let out_v = voucher::get_db(&db, out_id).expect("get out").expect("out exists");
    assert_eq!(in_v.doc_no, "20260902001");
    assert_eq!(out_v.doc_no, "20260902001", "出库与入库流水各自独立");
    assert_eq!(out_v.amount_cents, 0, "出库没有单价，金额为 0");

    // 台账里两种类型都在
    let facets = db
        .with(|c| ledger::facets(c).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("facets");
    assert_eq!(facets.in_rows, 1);
    assert_eq!(facets.out_rows, 1);

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn deleting_voucher_removes_its_rows() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    let id = voucher::create_db(&db, &voucher("in", "2026-09-03", vec![
        line("A", "x", 1.0, Some(10_000)),
        line("B", "y", 2.0, Some(20_000)),
    ]))
    .expect("create");

    let removed = voucher::delete_db(&db, id).expect("delete");
    assert_eq!(removed, 2);
    assert!(voucher::get_db(&db, id).expect("get").is_none());
    let count = db
        .with(|c| {
            c.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get::<_, i64>(0))
                .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .expect("count");
    assert_eq!(count, 0);

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn item_master_feeds_autofill() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    voucher::create_db(&db, &voucher("in", "2026-09-04", vec![line("WG-A", "外卡（轴）", 5.0, Some(17_000))]))
        .expect("create");

    let items = voucher::item_master_db(&db, Some("WG-A"), 10).expect("master");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].unit.as_deref(), Some("个"));
    assert_eq!(items[0].last_price_micros, Some(17_000));

    let _ = std::fs::remove_dir_all(dir);
}

/// 回归：已经到最新版本的库再启动一次，不能再执行迁移。
/// 之前 migrate 先改结构后写 user_version，中断后会撞 "duplicate column"，
/// 结果就是升级一次以后程序再也起不来。
#[test]
fn reopening_migrated_database_is_safe() {
    let (db, dir) = temp_db();
    let path = db.path.clone();
    drop(db);

    // 反复打开同一路径：每次都跑一遍 tune + migrate
    for round in 0..3 {
        let reopened = Db::open(&path).unwrap_or_else(|e| panic!("第 {round} 次打开失败: {e}"));
        let version: i64 = reopened
            .with(|c| {
                c.query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(warehouse_ledger_lib::db::DbError::from)
            })
            .expect("user_version");
        // 跟随迁移数量，不写死：以后加迁移不会假失败
        assert!(version >= 2, "版本应至少到 2，实际 {version}");
        let has_column: i64 = reopened
            .with(|c| {
                let mut stmt = c
                    .prepare("SELECT COUNT(*) FROM pragma_table_info('ledger') WHERE name='voucher_id'")
                    .map_err(warehouse_ledger_lib::db::DbError::from)?;
                stmt.query_row([], |r| r.get(0))
                    .map_err(warehouse_ledger_lib::db::DbError::from)
            })
            .expect("column check");
        assert_eq!(has_column, 1, "voucher_id 只应存在一列");
    }

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn each_line_keeps_its_own_delivery_no() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    let id = voucher::create_db(&db, &voucher("in", "2026-09-02", vec![
        line_with_delivery("WG-D1", 3.0, Some("0023378")),
        line_with_delivery("WG-D2", 4.0, Some("  0023401 ")),
        line_with_delivery("WG-D3", 5.0, None),
    ]))
    .expect("create voucher");

    let saved = voucher::get_db(&db, id).expect("get").expect("exists");
    let nos: Vec<Option<String>> = saved.lines.iter().map(|l| l.delivery_no.clone()).collect();
    assert_eq!(
        nos,
        vec![
            Some("0023378".to_string()),
            Some("0023401".to_string()),
            // 行里没填就回退到单头（旧调用兼容）
            Some("0023378".to_string()),
        ]
    );

    // 台账行也跟着带上，读台账能看到送货单号
    let page = db
        .with(|c| ledger::page(c, &LedgerFilter::default(), 1, 50).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("page");
    let mut seen: Vec<String> = page
        .rows
        .iter()
        .filter_map(|r| r.delivery_no.clone())
        .collect();
    seen.sort();
    assert_eq!(seen, vec!["0023378".to_string(), "0023378".to_string(), "0023401".to_string()]);

    let _ = std::fs::remove_dir_all(dir);
}

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
        spec: None,
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
        owner: if kind == "out" {
            Some("乾力车间".into())
        } else {
            None
        },
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
    let id = voucher::create_db(
        &db,
        1,
        &voucher(
            "in",
            "2026-09-01",
            vec![
                line("WG-A", "外卡", 10.0, Some(15_000)),
                line("WG-B", "轴承", 2.0, Some(100_000)),
            ],
        ),
    )
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
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: Some(1),
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .expect("page");
    assert_eq!(page.total, 2, "开单产生的行应出现在台账");
    assert!(page.rows.iter().all(|r| r.sheet == "voucher:in"));
    let ids: Vec<i64> = page.rows.iter().map(|r| r.id).collect();

    // 4) 批量改归属
    let changed = db
        .with(|c| {
            ledger::bulk_update(
                c,
                &ids,
                &BulkPatch {
                    owner: Some("批量归属".into()),
                    ..Default::default()
                },
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .expect("bulk update");
    assert_eq!(changed, 2);
    let page = db
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: Some(1),
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
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

    let in_id = voucher::create_db(
        &db,
        1,
        &voucher("in", "2026-09-02", vec![line("A", "x", 1.0, Some(10_000))]),
    )
    .expect("in");
    let out_id =
        voucher::create_db(&db, 1, &voucher("out", "2026-09-02", vec![line("A", "x", 3.0, None)])).expect("out");

    let in_v = voucher::get_db(&db, in_id).expect("get in").expect("in exists");
    let out_v = voucher::get_db(&db, out_id).expect("get out").expect("out exists");
    assert_eq!(in_v.doc_no, "20260902001");
    assert_eq!(out_v.doc_no, "20260902001", "出库与入库流水各自独立");
    assert_eq!(out_v.amount_cents, 0, "出库没有单价，金额为 0");

    // 台账里两种类型都在
    let facets = db
        .with(|c| ledger::facets(c, 1).map_err(warehouse_ledger_lib::db::DbError::from))
        .expect("facets");
    assert_eq!(facets.in_rows, 1);
    assert_eq!(facets.out_rows, 1);

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn deleting_voucher_removes_its_rows() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    let id = voucher::create_db(
        &db,
        1,
        &voucher(
            "in",
            "2026-09-03",
            vec![line("A", "x", 1.0, Some(10_000)), line("B", "y", 2.0, Some(20_000))],
        ),
    )
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

    voucher::create_db(
        &db,
        1,
        &voucher("in", "2026-09-04", vec![line("WG-A", "外卡（轴）", 5.0, Some(17_000))]),
    )
    .expect("create");

    let items = voucher::item_master_db(&db, 1, Some("WG-A"), 10, true, false).expect("master");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].unit.as_deref(), Some("个"));
    assert_eq!(items[0].last_price_micros, Some(17_000));

    let _ = std::fs::remove_dir_all(dir);
}

/// 跨仓隔离：同一个库里的两个仓各有各的台账、单据与流水号，
/// 汇总页的「全部仓库」才看得到两边加起来的数。
#[test]
fn warehouses_are_isolated_and_merge_on_demand() {
    let (db, dir) = temp_db();
    let db = Arc::new(db);

    // 主仓库（迁移自带）开一张入库单
    let one = voucher::create_db(
        &db,
        1,
        &voucher("in", "2026-09-05", vec![line("WG-A", "外卡", 10.0, Some(15_000))]),
    )
    .expect("in wh 1");

    // 新建二号仓，同一张单、同一天，编号也应从 001 重新起
    let wh2 = warehouse_ledger_lib::warehouse::create_db(
        &db,
        &warehouse_ledger_lib::warehouse::WarehouseInput {
            name: "二号仓".into(),
            remark: None,
            company_name: Some("测试二号公司".into()),
            active: None,
            sort_no: None,
        },
    )
    .expect("create wh");
    let two = voucher::create_db(
        &db,
        wh2,
        &voucher("out", "2026-09-05", vec![line("WG-B", "轴承", 3.0, None)]),
    )
    .expect("out wh 2");

    let v1 = voucher::get_db(&db, one).unwrap().unwrap();
    let v2 = voucher::get_db(&db, two).unwrap().unwrap();
    assert_eq!(v1.doc_no, "20260905001");
    assert_eq!(v2.doc_no, "20260905001", "每个仓自己从 001 起号");

    // 打印抬头跟着仓库走：主仓库沿用老公司名，二号仓用自己配的
    let houses = warehouse_ledger_lib::warehouse::list_db(&db).unwrap();
    let main = houses.iter().find(|w| w.id == 1).unwrap();
    let second = houses.iter().find(|w| w.id == wh2).unwrap();
    assert_eq!(main.company_name.as_deref(), Some("温州乾力机械有限公司"));
    assert_eq!(second.company_name.as_deref(), Some("测试二号公司"));

    // 单据列表按仓：各自只看得到自己那一张
    assert_eq!(voucher::list_db(&db, 1, None, 50).unwrap().len(), 1);
    assert_eq!(voucher::list_db(&db, wh2, None, 50).unwrap().len(), 1);

    // 台账按仓：一进一出，互不可见
    let page1 = db
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: Some(1),
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .unwrap();
    let page2 = db
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: Some(wh2),
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .unwrap();
    assert_eq!(page1.total, 1);
    assert_eq!(page2.total, 1);
    assert!(page1.rows.iter().all(|r| r.kind == "in"));
    assert!(page2.rows.iter().all(|r| r.kind == "out"));

    // 汇总页的「全部仓库」：warehouse_id = None 才是跨仓合并
    let merged = db
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: None,
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .unwrap();
    assert_eq!(merged.total, 2, "只有合并视图能看到两个仓");

    // 删掉二号仓的数据，主仓库不受影响
    let out = warehouse_ledger_lib::warehouse::delete_db(&db, wh2, true).expect("delete wh2");
    assert_eq!(out.vouchers, 1);
    assert_eq!(
        db.with(|c| {
            c.query_row("SELECT COUNT(*) FROM ledger WHERE warehouse_id = 1", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .unwrap(),
        1,
        "另一个仓的台账应当原样保留"
    );

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

    let id = voucher::create_db(
        &db,
        1,
        &voucher(
            "in",
            "2026-09-02",
            vec![
                line_with_delivery("WG-D1", 3.0, Some("0023378")),
                line_with_delivery("WG-D2", 4.0, Some("  0023401 ")),
                line_with_delivery("WG-D3", 5.0, None),
            ],
        ),
    )
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
        .with(|c| {
            ledger::page(
                c,
                &LedgerFilter {
                    warehouse_id: Some(1),
                    ..Default::default()
                },
                1,
                50,
            )
            .map_err(warehouse_ledger_lib::db::DbError::from)
        })
        .expect("page");
    let mut seen: Vec<String> = page.rows.iter().filter_map(|r| r.delivery_no.clone()).collect();
    seen.sort();
    assert_eq!(
        seen,
        vec!["0023378".to_string(), "0023378".to_string(), "0023401".to_string()]
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// 「开单记录」页的分页命令：走真实文件库，验证
/// 分页顺序、筛选、以及**整份命中集**的汇总都和列表页一致。
#[test]
fn voucher_list_page_filters_and_counts() {
    use warehouse_ledger_lib::voucher::VoucherFilter;

    let (db, dir) = temp_db();
    let db = Arc::new(db);

    // 两张入库（不同日期、不同供应商）、一张出库
    let in1 = voucher::create_db(
        &db,
        1,
        &voucher("in", "2026-09-01", vec![line("WG-A", "外卡", 2.0, Some(10_000))]),
    )
    .expect("in1");
    let in2 = voucher::create_db(
        &db,
        1,
        &voucher("in", "2026-09-03", vec![line("WG-B", "轴承", 1.0, Some(50_000))]),
    )
    .expect("in2");
    let out1 = voucher::create_db(
        &db,
        1,
        &voucher("out", "2026-09-02", vec![line("WG-A", "外卡", 1.0, None)]),
    )
    .expect("out1");
    assert!(in1 != in2 && in2 != out1);

    // 第一页只放一张：应按日期倒序，最新的在前
    let first = voucher::list_page_db(&db, 1, &VoucherFilter::default(), 1, 1).expect("page1");
    assert_eq!(first.total, 3);
    assert_eq!(first.in_count, 2);
    assert_eq!(first.out_count, 1);
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].id, in2);
    assert_eq!(first.page, 1);
    assert_eq!(first.page_size, 1);
    // 汇总按整份命中集算，不是当前页：2 件 × 1.00 元 + 1 件 × 5.00 元
    assert_eq!(first.amount_cents, 2 * 100 + 500);

    let second = voucher::list_page_db(&db, 1, &VoucherFilter::default(), 2, 1).expect("page2");
    assert_eq!(second.rows[0].id, out1);

    // 越界页返回空行，但汇总仍是整份
    let beyond = voucher::list_page_db(&db, 1, &VoucherFilter::default(), 9, 10).expect("page9");
    assert!(beyond.rows.is_empty());
    assert_eq!(beyond.total, 3);

    // 类型筛选：汇总跟着筛选变
    let only_out = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            kind: Some("out".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("only out");
    assert_eq!(only_out.total, 1);
    assert_eq!(only_out.in_count, 0);
    assert_eq!(only_out.out_count, 1);
    assert_eq!(only_out.rows[0].id, out1);

    // 关键字命中单号片段
    let by_no = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            keyword: Some("0901".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by no");
    assert_eq!(by_no.total, 1);
    assert_eq!(by_no.rows[0].id, in1);

    // 关键字命中明细物料名（单头里没有这两个字）
    let by_item = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            keyword: Some("轴承".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by item");
    assert_eq!(by_item.total, 1);
    assert_eq!(by_item.rows[0].id, in2);

    // 日期区间闭区间
    let ranged = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            from: Some("2026-09-02".into()),
            to: Some("2026-09-03".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("ranged");
    assert_eq!(ranged.total, 2);

    // 归属（出库单才有）
    let by_owner = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            owner: Some("乾力车间".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by owner");
    assert_eq!(by_owner.total, 1);
    assert_eq!(by_owner.rows[0].id, out1);

    // 采购人（三张单都是严兰兰）
    let by_buyer = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            buyer: Some("严兰兰".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by buyer");
    assert_eq!(by_buyer.total, 3);

    // 另一个仓看不到这些单
    let other_wh = voucher::list_page_db(&db, 2, &VoucherFilter::default(), 1, 10).expect("other wh");
    assert_eq!(other_wh.total, 0);
    assert!(other_wh.rows.is_empty());

    let _ = std::fs::remove_dir_all(dir);
}

/// 送货单号既要能搜，也要在列表里显示出来：
/// 新单据记在单头，老单据只写在明细行上，两种都得能搜到、能显示。
#[test]
fn voucher_list_page_delivery_no_search_and_fallback() {
    use warehouse_ledger_lib::voucher::VoucherFilter;

    let (db, dir) = temp_db();
    let db = Arc::new(db);

    // 甲：送货单号只在单头
    let mut head_only = voucher("in", "2026-10-01", vec![line("WG-A", "外卡", 1.0, Some(10_000))]);
    head_only.delivery_no = Some("SD-HEAD-1".into());
    let head_id = voucher::create_db(&db, 1, &head_only).expect("head only");

    // 乙：单头不填，只写在明细行上（老单据的存法）
    let mut line_only = voucher(
        "in",
        "2026-10-02",
        vec![line_with_delivery("WG-B", 1.0, Some("SD-LINE-2"))],
    );
    line_only.delivery_no = None;
    let line_id = voucher::create_db(&db, 1, &line_only).expect("line only");

    // 列表里两种都要显示出来（单头为空时回落到第一行明细）
    let all = voucher::list_page_db(&db, 1, &VoucherFilter::default(), 1, 10).expect("all");
    assert_eq!(all.total, 2);
    let by_id = |id: i64| all.rows.iter().find(|r| r.id == id).expect("row");
    assert_eq!(by_id(head_id).delivery_no.as_deref(), Some("SD-HEAD-1"));
    assert_eq!(by_id(line_id).delivery_no.as_deref(), Some("SD-LINE-2"));

    // 搜索命中单头送货单号
    let by_head = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            keyword: Some("SD-HEAD".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by head delivery");
    assert_eq!(by_head.total, 1);
    assert_eq!(by_head.rows[0].id, head_id);

    // 搜索命中明细行送货单号
    let by_line = voucher::list_page_db(
        &db,
        1,
        &VoucherFilter {
            keyword: Some("SD-LINE".into()),
            ..Default::default()
        },
        1,
        10,
    )
    .expect("by line delivery");
    assert_eq!(by_line.total, 1);
    assert_eq!(by_line.rows[0].id, line_id);

    let _ = std::fs::remove_dir_all(dir);
}

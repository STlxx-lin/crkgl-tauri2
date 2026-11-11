// 端到端验证：用真实的「仓库进销存-外购件.xlsx」跑一遍 pivot 导入，
// 然后把每个物料的台账结存与源表 12 月「现结存」逐行比对。
//
// 跑法：cargo test --lib pivot_real -- --ignored --nocapture

#[test]
#[ignore]
fn e2e_real_workbook() {
    use crate::db::Db;
    use std::path::Path;

    let path = Path::new(r"E:\2025\Trae2\crkgl-tauri2\仓库进销存-外购件.xlsx");
    assert!(path.is_file(), "找不到测试工作簿: {}", path.display());

    let report = crate::import::inspect(path).expect("inspect");
    let pivots: Vec<_> = report.sheets.iter().filter(|s| s.pivot).collect();
    println!("宽表数: {}", pivots.len());
    for sheet in &pivots {
        if let Some(info) = &sheet.pivot_info {
            println!(
                "  {} → 月 {:?} 天{} 物料{} 填充行{} 进出{} 期初{} 结存{}",
                sheet.name, info.month, info.days, info.items, info.filler_rows,
                info.flow_cells, info.opening_items, info.closing_items
            );
        }
    }
    assert_eq!(pivots.len(), 12, "应该认出 12 张月度表");

    let db = Db::open_in_memory().expect("db");
    let outcome = crate::import::run_with_year(&db, path, None, true, 2026).expect("run");
    println!(
        "导入 {} 行，跳过 {}，提醒 {}",
        outcome.rows, outcome.skipped, outcome.flagged
    );

    // 按单据类型统计，方便核对期初/逐日/补差/盘点/校正各落了多少行
    let by_doc: Vec<(String, i64)> = db
        .with(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT COALESCE(doc_no,''), COUNT(*) FROM ledger GROUP BY doc_no ORDER BY 1",
                )
                .map_err(crate::db::DbError::from)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .map_err(crate::db::DbError::from)?;
            Ok(rows)
        })
        .unwrap();
    println!("单据分布（{} 种）:", by_doc.len());
    for (doc, n) in by_doc.iter().take(40) {
        println!("  {doc} → {n}");
    }
    for issue in outcome.issues.iter().take(10) {
        println!("  问题: {} {}", issue.row_no, issue.message);
    }

    // 每个物料的结存应当与源表 12 月现结存一致
    let computed: Vec<(String, f64)> = db
        .with(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT item_code,
                            COALESCE(SUM(CASE WHEN kind='in' THEN qty ELSE -qty END), 0)
                     FROM ledger WHERE item_code IS NOT NULL GROUP BY item_code",
                )
                .map_err(crate::db::DbError::from)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .map_err(crate::db::DbError::from)?;
            Ok(rows)
        })
        .unwrap();

    // 源表 12 月现结存，从缓存宽表读回来
    let (_, pivot_sheets) = crate::import::inspect_and_collect_cached(path).expect("cached");
    let parsed = pivot_sheets
        .iter()
        .find(|s| s.month == Some(12))
        .expect("parse 12月");
    let expected: std::collections::BTreeMap<String, f64> = parsed
        .items
        .iter()
        .map(|i| (i.code.clone(), i.closing.unwrap_or(0.0)))
        .collect();

    let mut bad = Vec::new();
    for (code, qty) in &computed {
        let want = expected.get(code).copied().unwrap_or(0.0);
        if (qty - want).abs() > 1e-6 {
            bad.push((code.clone(), *qty, want));
        }
    }
    println!("物料数 {} / 源表 {}", computed.len(), expected.len());
    println!("结存不符 {} 个", bad.len());
    for item in bad.iter().take(20) {
        println!("  不符: {item:?}");
    }
    assert!(bad.is_empty(), "台台账存应与源表现结存完全一致");

    // 合计也要对上（源表 12 月现结存合计 5216）
    let total: f64 = computed.iter().map(|(_, q)| *q).sum();
    println!("台账结存合计 {total}");
    assert!((total - 5216.0).abs() < 1e-6, "合计应为 5216，实际 {total}");

    // 预览验证（命中缓存，带 pivot_summary）
    let preview = crate::import::preview_with_year(path, None, 12, 2026).expect("preview");
    let ps = preview.sheets[0].pivot_summary.as_ref().expect("pivot_summary");
    assert_eq!(ps.opening_rows, 322);
    assert_eq!(ps.correction_rows, 8);
    assert_eq!(ps.total_items, 1316);

    // 基础资料：物料、库位、类型与 WG00002 规格单位
    let (items, located, typed, wg00002): (i64, i64, i64, (Option<String>, Option<String>)) = db
        .with(|c| {
            let items: i64 = c
                .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
                .map_err(crate::db::DbError::from)?;
            let located: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM items WHERE TRIM(COALESCE(location,'')) <> ''",
                    [],
                    |r| r.get(0),
                )
                .map_err(crate::db::DbError::from)?;
            let typed: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM items WHERE item_type = '外购件'",
                    [],
                    |r| r.get(0),
                )
                .map_err(crate::db::DbError::from)?;
            let wg00002: (Option<String>, Option<String>) = c
                .query_row(
                    "SELECT unit, spec FROM items WHERE item_code = 'WG00002'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(crate::db::DbError::from)?;
            Ok((items, located, typed, wg00002))
        })
        .unwrap();
    println!(
        "基础资料物料 {items}（外购件 {typed}），带库位 {located}，WG00002 单位={:?} 规格={:?}",
        wg00002.0, wg00002.1
    );
    assert_eq!(items, 1316, "应写入 1316 个物料");
    assert_eq!(typed, 1316, "应全部识别为外购件");
    assert!(located > 300, "应有三百多个物料带库位，实际 {located}");
    assert_eq!(wg00002.0.as_deref(), Some("个"));
    assert_eq!(wg00002.1.as_deref(), Some("5*5"));
    let master = outcome.master.expect("outcome.master 应包含宽表主数据结果");
    assert_eq!(master.items_added, 1316);
}

#[test]
#[ignore]
fn benchmark_all_imports() {
    use crate::db::Db;
    use std::path::Path;
    use std::time::Instant;

    let path_flow = Path::new(r"E:\2025\Trae2\crkgl-tauri2\仓库出入库明细_5611_Modified.xlsm");
    let path_pivot = Path::new(r"E:\2025\Trae2\crkgl-tauri2\仓库进销存-外购件.xlsx");

    println!("\n=== 基准测试：常规流水表 (5611_Modified.xlsm) ===");
    if path_flow.is_file() {
        let t0 = Instant::now();
        let rep = crate::import::inspect(path_flow).expect("inspect");
        let t_inspect = t0.elapsed();
        println!("inspect 耗时: {:?}", t_inspect);
        for s in &rep.sheets {
            println!("  sheet: {} detail={} master={} pivot={}", s.name, s.detail, s.master, s.pivot);
        }

        let t1 = Instant::now();
        let _prev = crate::import::preview(path_flow, None, 10).expect("preview");
        let t_prev = t1.elapsed();
        println!("preview 耗时: {:?}", t_prev);

        let db = Db::open_in_memory().expect("db");
        let t2 = Instant::now();
        let out = crate::import::run(&db, path_flow, None, true).expect("run");
        let t_run = t2.elapsed();
        println!("run 写入台账耗时: {:?} (导入 {} 行)", t_run, out.rows);

        let t3 = Instant::now();
        let ms = db.with(|c| crate::master::import_from_workbook(c, path_flow).map_err(crate::db::DbError)).expect("master");
        let t_master = t3.elapsed();
        println!("master 导入主数据耗时: {:?} (物料 +{} 更新{})", t_master, ms.items_added, ms.items_updated);
    }

    println!("\n=== 基准测试：月度进销存宽表 (仓库进销存-外购件.xlsx) ===");
    if path_pivot.is_file() {
        // 先清空缓存以测冷启动
        let t0 = Instant::now();
        let _rep = crate::import::inspect(path_pivot).expect("inspect");
        let t_inspect = t0.elapsed();
        println!("inspect (冷启动) 耗时: {:?}", t_inspect);

        // 清理变量告警并聚焦核心流程
        let t1 = Instant::now();
        let _prev = crate::import::preview_with_year(path_pivot, None, 10, 2026).expect("preview");
        let t_prev = t1.elapsed();
        println!("preview (缓存后) 耗时: {:?}", t_prev);

        let db = Db::open_in_memory().expect("db");
        let t2 = Instant::now();
        let out = crate::import::run_with_year(&db, path_pivot, None, true, 2026).expect("run");
        let t_run = t2.elapsed();
        println!("run 写入台账耗时: {:?} (导入 {} 行)", t_run, out.rows);
    }
}

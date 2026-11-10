//! 仓库出入库明细 · Tauri 后端入口。
//!
//! 启动顺序：开库 → 首启自动导入 → 起 80 端口只读站 → 开窗口。

pub mod commands;
pub mod db;
pub mod import;
pub mod ledger;
pub mod master;
pub mod paths;
pub mod summary;
pub mod voucher;
pub mod web;

use std::sync::Arc;

use tauri::Manager;

pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
        .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("ledger".into()),
        }))
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
        .build();

    tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_file = paths::db_path(&data_dir);
            let db = Arc::new(db::Db::open(&db_file)?);

            // 开发时示例工作簿就在仓库根目录；打包后不预置数据
            let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.to_path_buf());

            let state = Arc::new(commands::AppState::new(db.clone(), dev_root.clone()));

            let startup = commands::auto_import(&state);
            commands::seed_master_data(&state);
            if startup.is_some() {
                if let Ok(mut slot) = state.last_import.lock() {
                    *slot = startup;
                }
            }

            // 只读站默认随程序启动，绑定失败只在设置页显示原因，不影响桌面端
            let dev_dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist-remote");
            let dist = if dev_dist.join("index.html").is_file() {
                // 开发态：仓库根目录里的那一份，npm run build:remote 之后立刻生效
                Some(dev_dist)
            } else {
                paths::remote_dist(app.path().resource_dir().ok().as_deref(), None)
            };
            log::info!("只读站静态目录: {dist:?}");
            let handle = web::start(db, dist, web::DEFAULT_PORT);
            if let Ok(mut slot) = state.web.lock() {
                *slot = Some(handle);
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::ledger_page,
            commands::ledger_facets,
            commands::ledger_detail,
            commands::ledger_update,
            commands::ledger_delete,
            commands::ledger_export,
            commands::import_inspect,
            commands::import_preview,
            commands::import_run,
            commands::import_history,
            commands::import_delete,
            commands::summary_bundle,
            commands::summary_group,
            commands::web_status,
            commands::web_start,
            commands::web_stop,
            commands::web_access_log,
            commands::doc_search,
            commands::doc_lines,
            commands::voucher_create,
            commands::voucher_update,
            commands::voucher_delete,
            commands::voucher_get,
            commands::voucher_list,
            commands::voucher_next_no,
            commands::item_master,
            commands::items_list,
            commands::items_count,
            commands::item_create,
            commands::item_update,
            commands::item_delete,
            commands::item_lookup,
            commands::suppliers_list,
            commands::supplier_create,
            commands::supplier_update,
            commands::supplier_delete,
            commands::master_stats,
            commands::master_import_workbook,
            commands::master_backfill,
            commands::ledger_bulk_update,
            commands::ledger_bulk_delete,
            commands::local_addresses,
            commands::client_log,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}

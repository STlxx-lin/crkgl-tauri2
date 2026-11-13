//! 仓库出入库明细 · Tauri 后端入口。
//!
//! 启动顺序：开库 → 首启自动导入 → 起 80 端口只读站 → 开窗口。

pub mod autostart;
pub mod commands;
pub mod db;
pub mod dict;
pub mod import;
pub mod ledger;
pub mod master;
pub mod paths;
pub mod pivot;
#[cfg(test)]
mod pivot_e2e;
pub mod stock;
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
            let handle = web::start(db.clone(), dist, web::DEFAULT_PORT);
            if let Ok(mut slot) = state.web.lock() {
                *slot = Some(handle);
            }

            app.manage(state.clone());

            // 托盘常驻：关窗口只是收进托盘，后台的 80 端口站和数据一直活着；
            // 真正退出走托盘菜单「退出」。
            setup_tray(app.handle())?;

            // 默认打开开机自动启动：只要用户没有手动在设置中关闭过，就默认开启并保持
            let autostart_disabled = db::get_setting(&state.db, "autostart_disabled")
                .map(|v| v == "1")
                .unwrap_or(false);
            if !autostart_disabled {
                if let Ok(exe) = commands::current_exe() {
                    if !autostart::is_enabled(&exe) {
                        if let Err(e) = autostart::set_enabled(&exe, true) {
                            log::warn!("默认开启开机自启失败: {e}");
                        } else {
                            log::info!("已默认开启开机自启: {}", exe.display());
                        }
                    }
                }
            }

            if autostart::launched_by_autostart() {
                if let Some(win) = app.get_webview_window("main") {
                    log::info!("开机自启拉起，窗口收进托盘");
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 用户点右上角关闭 → 隐藏到托盘，不退出进程
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            commands::stock_report,
            commands::stock_count,
            commands::stock_check,
            commands::stock_check_summary,
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
            commands::dict_list,
            commands::dict_counts,
            commands::dict_create,
            commands::dict_update,
            commands::dict_delete,
            commands::dict_sync,
            commands::suppliers_list,
            commands::supplier_create,
            commands::supplier_update,
            commands::supplier_delete,
            commands::master_stats,
            commands::master_import_workbook,
            commands::master_backfill,
            commands::ledger_bulk_update,
            commands::ledger_bulk_delete,
            commands::data_clear,
            commands::local_addresses,
            commands::client_log,
            commands::autostart_status,
            commands::autostart_set,
            commands::window_show,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}

/// 托盘图标 + 菜单（显示主窗口 / 打开只读站 / 退出）。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let open_site = MenuItem::with_id(app, "open_site", "打开局域网只读站", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &open_site, &PredefinedMenuItem::separator(app)?, &quit])?;

    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("仓库出入库明细 · 关闭窗口后在后台继续运行")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "open_site" => {
                let url = format!("http://localhost:{}", web::DEFAULT_PORT);
                let _ = tauri_plugin_opener::open_url(url, None::<&str>);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标：把主窗口叫回来
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(win) = tray.app_handle().get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

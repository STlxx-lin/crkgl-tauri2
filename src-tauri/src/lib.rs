//! 仓库出入库明细 · Tauri 后端入口。
//!
//! 启动顺序：开库 → 首启自动导入 → 起 80 端口只读站 → 开窗口。

// CI 里 clippy 以 `-D warnings` 跑。下面两条是结构选择而不是缺陷：
// 逐个改成结构体 / type 别名要动 Tauri IPC 签名与全部调用点，属于独立重构，
// 先把它们显式降级，避免 CI 每次都被同两条挡住。
#![allow(clippy::too_many_arguments, clippy::type_complexity)]

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
        // 单实例插件必须最先注册：第二个实例在进入其余 setup 之前就被判定并退出，
        // 否则会先开库、先占 80 端口，反而干扰已经在跑的那一份。
        .plugin(single_instance_plugin())
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
            let resource_dir = app.path().resource_dir().ok();

            let state = Arc::new(commands::AppState::new(
                db.clone(),
                dev_root.clone(),
                resource_dir.clone(),
            ));

            let startup = commands::auto_import(&state);
            commands::seed_master_data(&state);
            if startup.is_some() {
                if let Ok(mut slot) = state.last_import.lock() {
                    *slot = startup;
                }
            }

            // 只读站默认随程序启动，绑定失败只在设置页显示原因，不影响桌面端
            let dev_dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("dist-remote");
            let dist = if dev_dist.join("index.html").is_file() {
                // 开发态：仓库根目录里的那一份，npm run build:remote 之后立刻生效
                Some(dev_dist)
            } else {
                paths::remote_dist(resource_dir.as_deref(), None)
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

            // 默认打开开机自动启动（仅正式打包版生效，避免开发态把 target/debug 写进用户注册表）
            #[cfg(not(debug_assertions))]
            {
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
            commands::master_items_export,
            commands::master_suppliers_export,
            commands::master_dict_export,
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

/// 单实例控制：第二次启动时把参数转交给已运行的实例，然后把主窗口叫到前台。
///
/// 判定依据是操作系统级的锁（Windows 命名互斥量 / Linux D-Bus 名 / macOS Unix socket），
/// 按 `identifier` 生成名字，比「按进程名扫描」更准：改名后的副本、不同安装目录都能识别，
/// 也不会因为存在同名的无关进程而误判成未运行。第二个实例由插件直接 `exit(0)`，
/// 不会走到 `setup`，因此不会重复开库、重复占端口。
fn single_instance_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // 已经有一个实例在跑：把它的窗口显示出来并置前，用户能看到反馈
        log::info!("检测到已有实例在运行，本次启动转入已有窗口");
        // 回调可能早于第一个实例的窗口创建完成（例如刚开机自启、用户立刻双击图标），
        // 因此放到后台线程轮询等待窗口注册就绪；在事件循环线程上直接 sleep 会阻塞窗口创建。
        let app = app.clone();
        std::thread::spawn(move || {
            // 最多等 5 秒，每 200ms 探测一次主窗口
            let mut waited = 0u32;
            while app.get_webview_window("main").is_none() && waited < 5_000 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                waited += 200;
            }
            // 窗口可见性/焦点操作必须在主线程执行
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || {
                // 找不到主窗口（极少见）时只记日志，不影响已有实例继续运行
                if !bring_main_window_to_front(&handle) {
                    log::warn!("已有实例在运行，但找不到主窗口");
                }
            }) {
                log::warn!("无法把唤起窗口的任务投递到主线程: {e}");
            }
        });
    })
}

/// 把主窗口从托盘/最小化状态恢复到前台；窗口不存在时返回 `false`。
///
/// 单实例唤醒、托盘菜单「显示主窗口」、托盘图标左键点击三处共用这一份逻辑。
fn bring_main_window_to_front(app: &tauri::AppHandle) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    // 三步各自容错：某一步失败（如窗口正被系统重建）不应阻断后续步骤
    if let Err(e) = win.show() {
        log::warn!("唤醒主窗口失败: {e}");
    }
    if let Err(e) = win.unminimize() {
        log::warn!("取消最小化失败: {e}");
    }
    if let Err(e) = win.set_focus() {
        log::warn!("主窗口置前失败: {e}");
    }
    true
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
                // 与单实例唤醒共用同一份「显示 + 取消最小化 + 置前」逻辑
                bring_main_window_to_front(app);
            }
            "open_site" => {
                let port = app
                    .try_state::<Arc<commands::AppState>>()
                    .and_then(|st| st.web.lock().ok().and_then(|g| g.as_ref().map(|h| h.snapshot())))
                    .filter(|s| s.listening && s.port > 0)
                    .map(|s| s.port)
                    .unwrap_or(web::DEFAULT_PORT);
                let url = format!("http://localhost:{port}");
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
                bring_main_window_to_front(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

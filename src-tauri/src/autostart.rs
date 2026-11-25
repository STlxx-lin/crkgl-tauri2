//! 开机自启：写当前用户的 `HKCU\...\Run` 项，登录后拉起本程序并带 `--autostart`。
//!
//! 用注册表而不是计划任务：
//! · 不需要管理员权限，与安装器 `perMachine` 也不冲突（装的机器多账户各管各的）；
//! · 卸载时系统不会留计划任务，`Run` 项指向的 exe 不存在时 Windows 直接跳过。
//!
//! 值的内容带 `--autostart`：程序据此判断「这次是被开机自启拉起来的」，
//! 直接把窗口收进托盘，只留 80 端口只读站和后台资料。

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// Run 项里的值名。用产品标识，避免和别家软件撞名。
pub const VALUE_NAME: &str = "WarehouseLedger";

/// 开机自启时附加的启动参数，程序启动时据此决定是否显示窗口。
pub const AUTOSTART_ARG: &str = "--autostart";

#[cfg(windows)]
mod win {
    use super::{OsStr, OsStrExt, AUTOSTART_ARG, VALUE_NAME};
    use std::path::Path;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, KEY_SET_VALUE, REG_SZ,
    };

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 打开 Run 键；`write` 为真时要求可写。
    fn open_run_key(write: bool) -> Option<HKEY> {
        let sub = wide(RUN_KEY);
        let mut key: HKEY = std::ptr::null_mut();
        let access = if write { KEY_SET_VALUE } else { KEY_READ };
        let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, access, &mut key) };
        if rc == ERROR_SUCCESS {
            Some(key)
        } else {
            None
        }
    }

    /// 读回 Run 项里我们自己写的那条值。
    pub fn read_value() -> Option<String> {
        let key = open_run_key(false)?;
        let name = wide(VALUE_NAME);
        let mut size: u32 = 0;
        let mut kind: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if rc != ERROR_SUCCESS || size == 0 {
            unsafe { RegCloseKey(key) };
            return None;
        }
        // size 是字节数，装宽字符的缓冲区多留一个终止符的位置
        let mut buf = vec![0u16; (size as usize / 2) + 1];
        let rc = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buf.as_mut_ptr() as *mut u8,
                &mut size,
            )
        };
        unsafe { RegCloseKey(key) };
        if rc != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    /// 写入 / 删除（传 None）Run 项。
    pub fn write_value(value: Option<&str>) -> Result<(), String> {
        let key = open_run_key(true).ok_or("打不开当前用户的开机启动项")?;
        let name = wide(VALUE_NAME);
        let rc = match value {
            Some(text) => {
                let data = wide(text);
                unsafe {
                    RegSetValueExW(
                        key,
                        name.as_ptr(),
                        0,
                        REG_SZ,
                        data.as_ptr() as *const u8,
                        (data.len() * std::mem::size_of::<u16>()) as u32,
                    )
                }
            }
            None => unsafe { RegDeleteValueW(key, name.as_ptr()) },
        };
        unsafe { RegCloseKey(key) };
        if rc == ERROR_SUCCESS || (value.is_none() && rc == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(format!("写开机启动项失败（错误码 {rc}）"))
        }
    }

    /// 生成写进注册表的命令行：`"exe" --autostart`。
    pub fn command_line(exe: &Path) -> String {
        format!("\"{}\" {AUTOSTART_ARG}", exe.display())
    }

    /// 注册表里那条值是否指向当前这个 exe（换了安装目录时旧值要重写）。
    pub fn points_at_current_exe(value: &str, exe: &Path) -> bool {
        let quoted = format!("\"{}\"", exe.display());
        value.trim_start().starts_with(&quoted) || value.trim_start().starts_with(exe.to_string_lossy().as_ref())
    }
}

/// 当前程序是否已在开机自启里登记。
///
/// 只认指向当前 exe 的那条：用户换过安装目录、或手改过路径时，
/// 旧值不算「已开启」，避免开关显示开着却不生效。
pub fn is_enabled(exe: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        win::read_value()
            .map(|v| win::points_at_current_exe(&v, exe))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        false
    }
}

/// 打开 / 关闭开机自启。
pub fn set_enabled(exe: &std::path::Path, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if on {
            win::write_value(Some(&win::command_line(exe)))
        } else {
            win::write_value(None)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, on);
        Err("开机自启目前只支持 Windows".into())
    }
}

/// 本次进程是否由开机自启拉起（命令行里有 `--autostart`）。
pub fn launched_by_autostart() -> bool {
    std::env::args_os().skip(1).any(|a| a == AUTOSTART_ARG)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 真实读写 HKCU，跑完还原到测试前的样子，不留痕迹。
    #[test]
    fn run_key_roundtrip() {
        let exe = PathBuf::from(r"C:\Program Files\Ledger\warehouse-ledger.exe");
        let before = win::read_value();

        set_enabled(&exe, true).expect("写入开机自启");
        assert!(is_enabled(&exe), "开启后应读到已启用");

        let stored = win::read_value().expect("注册表里应有这一条");
        assert!(stored.ends_with(AUTOSTART_ARG), "命令行要带 --autostart：{stored}");
        assert!(stored.contains("warehouse-ledger.exe"), "要指向 exe 本身：{stored}");

        // 指向别的目录时不算「已开启」，避免换了安装位置还显示开着
        assert!(!is_enabled(&PathBuf::from(r"D:\Other\warehouse-ledger.exe")));

        set_enabled(&exe, false).expect("删除开机自启");
        assert!(!is_enabled(&exe), "关闭后应读到未启用");
        // 幂等：值已不存在时再次关闭不应报错
        set_enabled(&exe, false).expect("重复关闭开机自启应幂等成功");

        // 还原测试前的状态
        match before {
            Some(v) => win::write_value(Some(&v)).expect("还原原值"),
            None => {
                let _ = win::write_value(None);
            }
        }
    }
}

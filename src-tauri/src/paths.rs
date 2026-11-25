//! 路径解析：数据库位置、示例工作簿位置、远程站点静态目录。

use std::path::{Path, PathBuf};

/// 数据目录：`<app_data_dir>`（Windows 上是 `%APPDATA%/<identifier>`）。
pub fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("ledger.db")
}

/// 80 端口服务的静态文件：打包后从资源目录读，开发时读仓库里的 `dist-remote`。
pub fn remote_dist(resource_dir: Option<&Path>, dev_fallback: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("dist-remote"));
    }
    if let Some(dir) = dev_fallback {
        candidates.push(dir.to_path_buf());
    }
    candidates.into_iter().find(|dir| dir.join("index.html").is_file())
}

/// 开发时优先用仓库根目录里的那份示例工作簿。
/// 打包后示例不再随包，导入完全由用户在界面上选文件。
pub fn sample_workbooks(dev_root: Option<&Path>) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Some(root) = dev_root {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.extension().and_then(|e| e.to_str()) {
                    let name = name.to_ascii_lowercase();
                    if name == "xlsm" || name == "xlsx" {
                        found.push(path);
                    }
                }
            }
        }
    }
    found.sort();
    found
}

/// 文件后缀白名单：只接受 Excel 工作簿。
pub fn is_excel(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "xlsm" || e == "xlsx"
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_extension_check() {
        assert!(is_excel(Path::new("a.xlsm")));
        assert!(is_excel(Path::new("A.XLSX")));
        assert!(!is_excel(Path::new("a.csv")));
        assert!(!is_excel(Path::new("a")));
    }

    #[test]
    fn remote_dist_prefers_resource_copy() {
        let root = std::env::temp_dir().join("ledger-paths-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("res/dist-remote")).unwrap();
        std::fs::write(root.join("res/dist-remote/index.html"), "<html></html>").unwrap();
        let found = remote_dist(Some(&root.join("res")), Some(&root.join("dev")));
        assert_eq!(found, Some(root.join("res/dist-remote")));
        let _ = std::fs::remove_dir_all(&root);
    }
}

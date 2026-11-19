// CSV 导出的公共流程：弹保存对话框 → 后端生成内容落盘 → 提示结果。
//
// 基础资料的三处导出（物料 / 供应商 / 字典）与台账导出只差「文件名」和
// 「调哪个 API」，所以对话框、取消处理、成功提示统一收在这里，避免各处复制。

import { isTauri } from "./api";
import type { ExportResult } from "./types";
import { count } from "./format";
import { toast } from "@/components/base/toast/toast";

/** 导出文件的默认名：`前缀_20261119.csv`，用户可以在对话框里改。 */
export function exportFileName(prefix: string): string {
  // 取本地日期而不是 UTC：跨零点导出时文件名要和用户以为的日期一致
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `${prefix}_${stamp}.csv`;
}

/**
 * 弹保存对话框并把后端生成的 CSV 落盘。
 *
 * `run` 收到用户选定的路径，返回后端的导出结果（行数与最终路径）。
 */
export async function saveCsvFile(
  title: string,
  defaultPath: string,
  run: (path: string) => Promise<ExportResult>,
): Promise<void> {
  // 只读站里没有写文件能力，直接说清楚而不是让对话框弹出来又失败
  if (!isTauri) {
    toast("导出只能在桌面端使用", { description: "浏览器里打开的是只读站。", status: "error" });
    return;
  }
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title,
      defaultPath,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    // 用户点了取消：什么都不做，也不要弹提示
    if (!path) return;
    const result = await run(path);
    toast("已导出", {
      description: `${count(result.rows)} 行 → ${result.path}`,
      status: "success",
      duration: 7000,
    });
  } catch (err) {
    toast("导出失败", { description: String(err), status: "error" });
  }
}

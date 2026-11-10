// 主题：浅色 / 深色。只用 BoardUI 的 token 切换（html 上的 .dark），
// 记住用户选择，跨标签页同步；首帧在 index.html 的内联脚本里先定下来，避免闪一下。

export type ThemeMode = "light" | "dark";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const STORAGE_KEY = "ledger.theme";
const EVENT = "ledger:theme-change";

/** 读取已保存的主题；没有就用深色（仓库夜间盘点、屏幕常亮，深色更不刺眼）。 */
export function storedTheme(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // 隐私模式或存储被禁：按默认深色
  }
  return "dark";
}

/** Tauri 窗口标题栏也跟着换，否则浅色页配深色边框很割裂。 */
function syncWindowTheme(mode: ThemeMode): void {
  if (!isTauri) return;
  // 窗口标题栏跟随主题。失败只记日志：权限缺失或平台不支持时，
  // 页面本身的深浅仍然是对的，不该因此中断切换。
  // 用 try/catch 包住同步部分：getCurrentWindow() 在没有窗口上下文时
  // 会直接抛错（不是返回 rejected promise），只 catch Promise 拦不住，
  // 那样会让整个应用白屏。
  try {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(mode))
      .catch((err: unknown) => {
        console.warn("[theme] 同步窗口主题失败", err);
      });
  } catch (err) {
    console.warn("[theme] 无法获取当前窗口", err);
  }
}

/** 把主题落到 <html> 上；`persist` 为 false 时只应用不写盘（首帧复原用）。 */
export function applyTheme(mode: ThemeMode, { persist = true }: { persist?: boolean } = {}): void {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.style.colorScheme = mode;
  syncWindowTheme(mode);
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // 存不下也不影响本次会话
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
  }
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(next);
  return next;
}

/** 订阅：本页切换 + 其他标签页（只读站开两个窗口时）都会推过来。 */
export function subscribeTheme(onChange: (mode: ThemeMode) => void): () => void {
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<ThemeMode>).detail;
    onChange(detail === "light" ? "light" : "dark");
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    const mode: ThemeMode = event.newValue === "light" ? "light" : "dark";
    applyTheme(mode, { persist: false });
    onChange(mode);
  };
  window.addEventListener(EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}

export function currentTheme(): ThemeMode {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// 测试环境的最小 `window` 实现。
//
// 仓库里被测的都是纯函数与 localStorage 读写，引 jsdom / happy-dom 只为
// `window.localStorage` 不划算。这里只补三个必需能力：
//   · `localStorage`（每次用例前清空）
//   · `dispatchEvent` / `addEventListener`（`on*Change` 的跨组件通知）
// 任何依赖真实 DOM 的行为都不在这一层测。

import { beforeEach } from "vitest";

class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
const listeners = new Map<string, Set<(event: Event) => void>>();

const fakeWindow = {
  localStorage: storage,
  dispatchEvent(event: Event): boolean {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
    return true;
  },
  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  },
  removeEventListener(type: string, listener: (event: Event) => void): void {
    listeners.get(type)?.delete(listener);
  },
};

// setupFiles 在每个测试文件前跑一次；globalThis 上没有 window 时才挂
if (!("window" in globalThis)) {
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
}

beforeEach(() => {
  storage.clear();
  listeners.clear();
});

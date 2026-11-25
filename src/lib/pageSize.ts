// 「每页条数」的统一存储。
//
// 台账、基础资料、库存、字典四页原本各抄一份 `storedPageSize()`：键名四个、
// 默认值两种（100 / 20）、写盘时机三种（有的在 onChange 里裸写 localStorage，
// 有的先 `setOffset(0)` 再写，字典页还有单独的 `save*PageSize`）。以后统一
// 调整档位或改成服务端偏好时必然漏改某一页。

import { useCallback, useState } from "react";

/** 读存储的每页条数：不在档位表里（脏数据、旧版本残留）就回退到 `fallback`。 */
export function readStoredPageSize<T extends number>(
  key: string,
  sizes: readonly T[],
  fallback: T,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return sizes.includes(n as T) ? (n as T) : fallback;
  } catch {
    // 隐私模式或存储被禁：本次先用默认值
    return fallback;
  }
}

/** 写每页条数；存不下也不影响本次使用。 */
export function saveStoredPageSize(key: string, size: number): void {
  try {
    window.localStorage.setItem(key, String(size));
  } catch {
    // 忽略：下次退回默认值
  }
}

/**
 * 每页条数的受控状态：初始化时读存储，变更时写回。
 *
 * setter 收 `number` 而不是档位联合类型：`<select>` 的 value 拿来就是
 * `string → number`，各页都要再断言一次反而更啰嗦。
 *
 * 调用方拿到 setter 之后仍需自己处理「回到第一页 / 滚回顶部」——
 * 那部分是各页的分页状态，不属于存储逻辑。
 */
export function useStoredPageSize<T extends number>(
  key: string,
  sizes: readonly T[],
  fallback: T,
): [T, (next: number) => void] {
  const [pageSize, setPageSizeState] = useState<T>(() => readStoredPageSize(key, sizes, fallback));
  const setPageSize = useCallback(
    (next: number) => {
      // 只接受档位表里的值：手改 localStorage 或旧版本残留的档位不该带进来
      const picked = sizes.includes(next as T) ? (next as T) : fallback;
      setPageSizeState(picked);
      saveStoredPageSize(key, picked);
    },
    [key, sizes, fallback],
  );
  return [pageSize, setPageSize];
}

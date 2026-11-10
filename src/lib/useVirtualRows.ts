import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 长列表窗口化：只渲染滚动窗口内的行，窗口外用等高占位撑开滚动条。
 *
 * 表格用的是 react-aria 的 `<Table>`，它自己管 `<tbody>` 结构与键盘导航，
 * DOM 接管型虚拟化会破坏这两点。这里只做「切片 + 上下占位」。
 */
export function useVirtualRows(
  scrollRef: React.RefObject<HTMLElement | null>,
  total: number,
  rowHeight: number,
  overscan = 8,
) {
  const [range, setRange] = useState({ start: 0, end: Math.min(total, 40) });
  const rafId = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el: HTMLElement | null = scrollRef.current;
    if (!el) return;
    const viewport = el.clientHeight || 600;
    const first = Math.floor(el.scrollTop / rowHeight);
    const visible = Math.ceil(viewport / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(total, first + visible + overscan);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [scrollRef, total, rowHeight, overscan]);

  const onScroll = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    const el: HTMLElement | null = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      rafId.current = null;
    };
  }, [scrollRef, onScroll, measure]);

  // 数据量变化（筛选/刷新）后重算窗口，回到顶部避免停在空白处
  useEffect(() => {
    const el: HTMLElement | null = scrollRef.current;
    if (el && el.scrollTop > total * rowHeight) el.scrollTop = 0;
    measure();
  }, [total, rowHeight, measure, scrollRef]);

  return {
    start: range.start,
    end: range.end,
    padTop: range.start * rowHeight,
    padBottom: Math.max(0, (total - range.end) * rowHeight),
  };
}

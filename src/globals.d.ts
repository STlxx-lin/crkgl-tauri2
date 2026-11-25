// 编译期常量：由 vite.config.ts 的 define 注入。
//
// `npm run build:remote` 产出把只读站打进 dist-remote/，但此前 src 里没有任何
// 地方引用它，"remote 产物被误放进 Tauri 外壳" 就没有编译期保护。
declare const __REMOTE_MODE__: boolean;

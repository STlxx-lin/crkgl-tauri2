// ESLint 扁平配置。
//
// 只检查我们自己维护的 `src/`：`components/`、`styles/`、`utils/` 是
// `npx boardui add` 生成的 BoardUI 源码，跟着上游走，按自己的规则改会让
// 以后升级 diff 满天飞，所以整体忽略。真正交给 eslint 的是业务代码。
//
// 规则取向：只保留「能指出真实缺陷」的几条。纯格式问题交给 prettier，
// 因此末尾接 `eslint-config-prettier` 关掉所有格式类规则。

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "dist-remote/",
      "src-tauri/",
      "components/",
      "styles/",
      "utils/",
      "public/",
      "scripts/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // 只开这两条：hooks 调用位置错乱、依赖数组漏项是会真的出 bug 的。
      // react-hooks v7 的 recommended 里还带一整套 React Compiler 规则
      // （set-state-in-effect / refs / immutability 等），它们假定代码是按
      // 「纯渲染 + 不写 ref」的编译期模型写的；本仓库大量页面用
      // useEffect 里发起加载、用 ref 存定时器句柄，一次全改等于重写，
      // 而收益只是「更贴合编译器」，所以先不开。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Tauri 命令返回值与 Office 单元格在边界上确实是 any，逐个补类型
      // 成本远大于收益，降级成提示。
      "@typescript-eslint/no-explicit-any": "warn",
      // `catch {}` 在存储读写里是刻意的（隐私模式不让写就当默认值），放行。
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  prettier,
);

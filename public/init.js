// 首帧同步恢复主题与字号，外链加载以符合 script-src 'self' CSP 策略。
(function () {
  var root = document.documentElement;
  try {
    var savedTheme = localStorage.getItem("ledger.theme");
    var isDark = savedTheme !== "light";
    root.classList.toggle("dark", isDark);
    root.style.colorScheme = isDark ? "dark" : "light";
  } catch (e) {
    root.classList.add("dark");
    root.style.colorScheme = "dark";
  }

  try {
    var sizes = { small: 14, normal: 16, large: 18, xlarge: 20 };
    var savedScale = localStorage.getItem("ledger.fontScale");
    root.style.fontSize = (sizes[savedScale] || 16) + "px";
  } catch (e) {
    root.style.fontSize = "16px";
  }
})();

@echo off
REM Rust 1.90 + MSVC 环境包装。
REM PATH 里的 "Rust stable MSVC 1.88" 是完整工具链目录（不是 rustup 代理），
REM 会把 link.exe 解析到 Git 自带的 /usr/bin/link。这里：
REM   1) 先跑 vcvars64 拿到真正的 link.exe
REM   2) 把 1.90 的工具链 bin 放到 PATH 最前
REM   3) 把 Git 的 usr/bin 从 PATH 里摘掉
setlocal
if not defined VCVARS set "VCVARS=E:\VisualStudio\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [rust90] vcvars64.bat not found. Set VCVARS to its full path.
  exit /b 1
)
set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  echo [rust90] 1.90.0 toolchain not found at "%RUST90%"
  exit /b 1
)
set "PATH=%RUST90%;%PATH:C:\Program Files\Git\usr\bin;=%"
set "PATH=%PATH:D:\Git\usr\bin;=%"
"%RUST90%\cargo.exe" %*
exit /b %ERRORLEVEL%

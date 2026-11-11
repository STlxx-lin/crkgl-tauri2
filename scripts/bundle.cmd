@echo off
REM 打包用：vcvars64 + Rust 1.90 环境下执行 tauri build（与 scripts/rust90.cmd 同一套 PATH 修正）。
setlocal
if not defined VCVARS set "VCVARS=E:\VisualStudio\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [bundle] vcvars64.bat not found.
  exit /b 1
)
set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  echo [bundle] 1.90.0 toolchain not found.
  exit /b 1
)
set "PATH=%RUST90%;%PATH:C:\Program Files\Git\usr\bin;=%"
set "PATH=%PATH:D:\Git\usr\bin;=%"
cd /d "%~dp0.."
call npx tauri build
exit /b %ERRORLEVEL%

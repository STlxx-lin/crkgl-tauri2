@echo off
REM Build NSIS installer with MSVC + Rust 1.90 environment (ASCII only for Windows GBK cmd.exe safety).
setlocal EnableDelayedExpansion

if not defined VCVARS (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  if exist "!VSWHERE!" (
    for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
      if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
    )
  )
)
if not defined VCVARS if exist "E:\VisualStudio\VC\Auxiliary\Build\vcvars64.bat" (
  set "VCVARS=E:\VisualStudio\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS (
  echo [bundle] vcvars64.bat not found. Install VS C++ Build Tools or set VCVARS.
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [bundle] Failed to initialize MSVC environment via "%VCVARS%".
  exit /b 1
)

set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  echo [bundle] Rust 1.90.0 toolchain not found at "%RUST90%".
  exit /b 1
)

set "PATH=%RUST90%;%PATH:C:\Program Files\Git\usr\bin;=%"
set "PATH=%PATH:D:\Git\usr\bin;=%"

cd /d "%~dp0.."
call npx tauri build
exit /b %ERRORLEVEL%

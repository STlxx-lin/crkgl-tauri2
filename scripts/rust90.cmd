@echo off
REM Rust 1.90 + MSVC wrapper script (ASCII only for Windows GBK cmd.exe safety).
REM Automatically detects vcvars64.bat via vswhere.exe unless VCVARS is set,
REM prepends the Rust 1.90 toolchain, removes Git usr/bin from PATH to avoid link.exe shadowing,
REM and enters src-tauri automatically when invoked from the repository root.
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
  echo [rust90] vcvars64.bat not found. Install VS C++ Build Tools or set VCVARS.
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [rust90] Failed to initialize MSVC environment via "%VCVARS%".
  exit /b 1
)

set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  echo [rust90] Rust 1.90.0 toolchain not found at "%RUST90%".
  exit /b 1
)

set "PATH=%RUST90%;%PATH:C:\Program Files\Git\usr\bin;=%"
set "PATH=%PATH:D:\Git\usr\bin;=%"

set "POP_NEEDED=0"
if not exist "Cargo.toml" (
  if exist "%~dp0..\src-tauri\Cargo.toml" (
    pushd "%~dp0..\src-tauri"
    set "POP_NEEDED=1"
  )
)

"%RUST90%\cargo.exe" %*
set "RC=%ERRORLEVEL%"
if "%POP_NEEDED%"=="1" popd
exit /b %RC%

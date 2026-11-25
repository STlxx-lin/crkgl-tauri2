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
if not defined VCVARS (
  echo [bundle] vcvars64.bat not found.
  echo [bundle] Install "Visual Studio Build Tools" with the "Desktop development with C++" workload,
  echo [bundle] or set VCVARS to the full path of your own vcvars64.bat.
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [bundle] Failed to initialize MSVC environment via "%VCVARS%".
  exit /b 1
)

REM Prefer the version pinned by rust-toolchain.toml, fall back to PATH's cargo.
set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  where cargo >nul 2>&1
  if errorlevel 1 (
    echo [bundle] Neither Rust 1.90.0 nor a cargo on PATH was found.
    echo [bundle] Install it with: rustup toolchain install 1.90.0
    exit /b 1
  )
  set "RUST90="
)

REM Strip every */Git/usr/bin entry: Git for Windows ships link.exe that shadows MSVC's.
set "PATH_CLEAN="
for %%p in ("%PATH:;=" "%") do (
  set "ONE=%%~p"
  if /i not "!ONE:~-12!"=="\Git\usr\bin" set "PATH_CLEAN=!PATH_CLEAN!;!ONE!"
)
if defined PATH_CLEAN set "PATH=%PATH_CLEAN:~1%"
if defined RUST90 set "PATH=%RUST90%;%PATH%"

cd /d "%~dp0.."
call npx tauri build
exit /b %ERRORLEVEL%

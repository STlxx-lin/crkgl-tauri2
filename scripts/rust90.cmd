@echo off
REM Rust 1.90 + MSVC wrapper script (ASCII only for Windows GBK cmd.exe safety).
REM Detects vcvars64.bat via vswhere.exe unless VCVARS is set, prepends the Rust 1.90
REM toolchain, strips every Git usr\bin from PATH (its link.exe shadows MSVC link.exe),
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
if not defined VCVARS (
  echo [rust90] vcvars64.bat not found.
  echo [rust90] Install "Visual Studio Build Tools" with the "Desktop development with C++" workload,
  echo [rust90] or set VCVARS to the full path of your own vcvars64.bat.
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [rust90] Failed to initialize MSVC environment via "%VCVARS%".
  exit /b 1
)

REM Prefer the 1.90 toolchain pinned by rust-toolchain.toml; fall back to whatever
REM `cargo` is already on PATH so a fresh clone with only stable installed still works.
set "RUST90=%USERPROFILE%\.rustup\toolchains\1.90.0-x86_64-pc-windows-msvc\bin"
if not exist "%RUST90%\rustc.exe" (
  where cargo >nul 2>&1
  if errorlevel 1 (
    echo [rust90] Neither Rust 1.90.0 nor a cargo on PATH was found.
    echo [rust90] Install it with: rustup toolchain install 1.90.0
    exit /b 1
  )
  set "RUST90="
)

REM Strip every */Git/usr/bin entry instead of hardcoding one machine's install path:
REM Git for Windows ships its own link.exe, which MSVC builds would otherwise pick up.
set "PATH_CLEAN="
for %%p in ("%PATH:;=" "%") do (
  set "ONE=%%~p"
  if /i not "!ONE:~-12!"=="\Git\usr\bin" set "PATH_CLEAN=!PATH_CLEAN!;!ONE!"
)
if defined PATH_CLEAN set "PATH=%PATH_CLEAN:~1%"
if defined RUST90 set "PATH=%RUST90%;%PATH%"

set "POP_NEEDED=0"
if not exist "Cargo.toml" (
  if exist "%~dp0..\src-tauri\Cargo.toml" (
    pushd "%~dp0..\src-tauri"
    set "POP_NEEDED=1"
  )
)

if defined RUST90 (
  "%RUST90%\cargo.exe" %*
) else (
  cargo %*
)
set "RC=%ERRORLEVEL%"
if "%POP_NEEDED%"=="1" popd
exit /b %RC%

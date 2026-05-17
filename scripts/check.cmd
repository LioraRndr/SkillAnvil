@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSDEVCMD="

if exist "%VSWHERE%" (
  for /f "usebackq tokens=* delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VSDEVCMD=%%I\Common7\Tools\VsDevCmd.bat"
  )
)

if not defined VSDEVCMD if exist "D:\Program Files\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat" (
  set "VSDEVCMD=D:\Program Files\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat"
)

if not defined VSDEVCMD (
  echo SkillAnvil could not find Visual Studio Build Tools with C++ workload.
  exit /b 1
)

call "%VSDEVCMD%" -arch=x64
if errorlevel 1 exit /b %errorlevel%

set "PATH=%CARGO_BIN%;%PATH%"
cd /d "%ROOT%"

call pnpm typecheck
if errorlevel 1 exit /b %errorlevel%

call pnpm build
if errorlevel 1 exit /b %errorlevel%

cd /d "%ROOT%\src-tauri"
cargo fmt -- --check
if errorlevel 1 exit /b %errorlevel%

cargo check

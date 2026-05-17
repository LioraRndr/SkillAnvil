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
  echo Install Visual Studio Build Tools and include Desktop development with C++.
  exit /b 1
)

if not exist "%CARGO_BIN%\cargo.exe" (
  echo SkillAnvil could not find cargo.exe at "%CARGO_BIN%\cargo.exe".
  echo Install Rust with rustup, then open a new terminal.
  exit /b 1
)

call "%VSDEVCMD%" -arch=x64
if errorlevel 1 exit /b %errorlevel%

set "PATH=%CARGO_BIN%;%PATH%"
cd /d "%ROOT%"

where cargo >nul 2>nul || (
  echo cargo.exe is not available after loading the development environment.
  exit /b 1
)

where link >nul 2>nul || (
  echo link.exe is not available after loading the development environment.
  exit /b 1
)

pnpm tauri dev

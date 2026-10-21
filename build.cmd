@echo off
if /i not "%~1"=="__build__" (
  start "OpenXLauncher Build" cmd /k call "%~f0" __build__
  exit /b 0
)

setlocal EnableExtensions
cd /d "%~dp0"

title OpenXLauncher Portable Build
set "LOG=%~dp0build.log"
echo.>"%LOG%"

echo.
echo ========================================
echo   OpenXLauncher - Portable EXE Build
echo ========================================
echo Log: %LOG%
echo.

set "PATH=%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"

set "VCVARS=%ProgramFiles(x86)%\Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

set "VCVARS_LOADED=0"
if not exist "%VCVARS%" goto msvc_skip
echo [env] Loading MSVC:
echo   "%VCVARS%"
call "%VCVARS%"
set "VCVARS_LOADED=1"
where link >nul 2>&1
if errorlevel 1 set "VCVARS_LOADED=0"
if "%VCVARS_LOADED%"=="1" for /f "delims=" %%L in ('where link 2^>nul') do echo [env] link.exe: %%L
:msvc_skip
if "%VCVARS_LOADED%"=="1" goto msvc_ok
echo [warn] MSVC / link.exe not ready. Install VS Build Tools C++ workload.
echo [warn] Expected vcvars64 under Visual Studio\18\BuildTools
echo.
:msvc_ok

where node >nul 2>&1
if errorlevel 1 goto err_node
for /f "delims=" %%N in ('node -v 2^>nul') do echo [env] Node %%N
goto chk_pnpm

:err_node
echo [error] Node.js not found.
goto failed

:chk_pnpm
where pnpm >nul 2>&1
if errorlevel 1 goto err_pnpm
for /f "delims=" %%P in ('pnpm -v 2^>nul') do echo [env] pnpm %%P
goto chk_cargo

:err_pnpm
echo [error] pnpm not found. Run: npm install -g pnpm
goto failed

:chk_cargo
where cargo >nul 2>&1
if errorlevel 1 goto err_cargo
for /f "delims=" %%C in ('rustc --version 2^>nul') do echo [env] %%C
goto deps

:err_cargo
echo [error] Rust/cargo not found. See https://rustup.rs
goto failed

:deps
echo.
if exist "node_modules\" goto build_front
echo [deps] pnpm install...
call pnpm install
if errorlevel 1 goto failed
echo.

:build_front
echo [1/2] Building frontend...
call pnpm build >>"%LOG%" 2>&1
if errorlevel 1 goto failed
echo.

echo [2/2] Building portable Tauri binary...
echo        First release build may take 20-40 min ^(src-tauri/.cargo/config.toml sets jobs=1^).
echo        Watch Compiling lines below, or open build.log in another editor.
echo.
call pnpm tauri:build:portable
if errorlevel 1 goto failed
echo.

set "OUT_DIR=%CD%\src-tauri\target\release"
echo ========================================
echo   Build succeeded
echo ========================================
echo %OUT_DIR%
dir /b "%OUT_DIR%\*.exe" 2>nul
echo.
echo Full log: %LOG%
goto end

:failed
echo.
echo ========================================
echo   Build FAILED
echo ========================================
echo See log: %LOG%
type "%LOG%" 2>nul
goto end

:end
echo.
echo Type exit to close this window.
endlocal

@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title RTLauncher Portable Build
echo.
echo ========================================
echo   RTLauncher - Portable EXE Build
echo ========================================
echo.

rem --- Toolchain PATH ---
set "PATH=%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"

rem --- MSVC (link.exe) for Rust ---
set "VCVARS_LOADED=0"
for %%F in (
  "%ProgramFiles(x86)%\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
) do (
  if exist %%~F if "!VCVARS_LOADED!"=="0" (
    echo [env] Loading MSVC: %%~F
    call "%%~F" >nul 2>&1
    set "VCVARS_LOADED=1"
  )
)
if "%VCVARS_LOADED%"=="0" (
  echo [warn] vcvars64.bat not found. Install VS Build Tools with C++ workload.
  echo        Build may fail with: linker `link.exe` not found
  echo.
)

where node >nul 2>&1
if errorlevel 1 (
  echo [error] Node.js not found in PATH.
  goto :failed
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [error] pnpm not found. Try: npm install -g pnpm
  goto :failed
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo [error] Rust/cargo not found. Install from https://rustup.rs
  goto :failed
)

if not exist "node_modules\" (
  echo [deps] node_modules missing, running pnpm install...
  call pnpm install
  if errorlevel 1 goto :failed
  echo.
)

echo [1/2] Building frontend (Next.js export)...
call pnpm build
if errorlevel 1 goto :failed
echo.

echo [2/2] Building portable Tauri binary...
call pnpm tauri:build:portable
if errorlevel 1 goto :failed
echo.

set "OUT_DIR=%CD%\src-tauri\target\release"
echo ========================================
echo   Build succeeded
echo ========================================
echo Output folder:
echo   %OUT_DIR%
echo.
echo Executables:
dir /b "%OUT_DIR%\*.exe" 2>nul
if errorlevel 1 echo   (no .exe found - check build log)
echo.
echo Note: WebView2 must be installed on the target PC.
echo.
pause
exit /b 0

:failed
echo.
echo ========================================
echo   Build FAILED
echo ========================================
pause
exit /b 1

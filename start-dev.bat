@echo off
setlocal EnableExtensions
chcp 65001 >nul

cd /d "%~dp0"
title exhentai-manga-manager launcher
set ELECTRON_RUN_AS_NODE=

echo [1/5] Checking Node.js and npm...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Please install Node.js, then run this script again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Please install Node.js with npm, then run this script again.
  pause
  exit /b 1
)

echo [2/5] Checking project files...
if not exist package.json (
  echo package.json was not found. Run this script from the project root.
  pause
  exit /b 1
)

if not exist secret_key.json (
  echo Creating missing secret_key.json with an empty GitHub token...
  > secret_key.json echo {"gh_token":""}
)

echo [3/5] Checking dependencies...
if not exist node_modules\.bin\vite.cmd (
  set NEED_INSTALL=1
) else if not exist node_modules\.bin\electron.cmd (
  set NEED_INSTALL=1
) else (
  set NEED_INSTALL=0
)

if "%NEED_INSTALL%"=="1" (
  if exist package-lock.json (
    echo Dependencies are missing or incomplete. Running npm ci...
    call npm ci
  ) else (
    echo Dependencies are missing or incomplete. Running npm install...
    call npm install
  )
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

call :check_sqlite >nul 2>&1
if not errorlevel 1 goto dependencies_ready

echo SQLite native dependency is missing or cannot be loaded. Running npm rebuild sqlite3...
call npm rebuild sqlite3
if errorlevel 1 goto sqlite_failed

call :check_sqlite
if errorlevel 1 goto sqlite_failed

:dependencies_ready
echo [4/5] Starting Vite dev server...
if exist .vite-dev.pid del .vite-dev.pid >nul 2>nul
if exist .vite-dev.log del .vite-dev.log >nul 2>nul
if exist .vite-dev.err del .vite-dev.err >nul 2>nul
node scripts\check-dev-port.cjs
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /c npm run dev' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '.vite-dev.log' -RedirectStandardError '.vite-dev.err' -PassThru; Set-Content -Path '.vite-dev.pid' -Value $p.Id -Encoding ASCII"

  echo Waiting for http://127.0.0.1:15374 ...
  for /l %%i in (1,1,90) do (
    node scripts\check-dev-port.cjs --pid-file .vite-dev.pid
    if errorlevel 2 goto vite_failed
    if not errorlevel 1 goto vite_ready
    timeout /t 1 /nobreak >nul
  )

  echo Vite did not become ready on port 15374.
  echo Close any process using port 15374, then try again.
  goto vite_failed_cleanup

  :vite_failed
  echo Vite exited before port 15374 became ready.
  if exist .vite-dev.log (
    echo.
    echo ===== Vite stdout =====
    type .vite-dev.log
  )
  if exist .vite-dev.err (
    echo.
    echo ===== Vite stderr =====
    type .vite-dev.err
  )

  :vite_failed_cleanup
  if exist .vite-dev.pid (
    for /f %%p in (.vite-dev.pid) do taskkill /PID %%p /T /F >nul 2>nul
    del .vite-dev.pid >nul 2>nul
  )
  pause
  exit /b 1
) else (
  echo Port 15374 is already open. Reusing the existing dev server.
)

:vite_ready
echo [5/5] Starting Electron...
call npm run start
set APP_EXIT=%ERRORLEVEL%

if exist .vite-dev.pid (
  echo Cleaning up Vite dev server...
  for /f %%p in (.vite-dev.pid) do taskkill /PID %%p /T /F >nul 2>nul
  del .vite-dev.pid >nul 2>nul
)
if exist .vite-dev.log del .vite-dev.log >nul 2>nul
if exist .vite-dev.err del .vite-dev.err >nul 2>nul

if not "%APP_EXIT%"=="0" (
  echo Electron exited with code %APP_EXIT%.
  exit /b %APP_EXIT%
)

echo Done.
exit /b 0

:check_sqlite
set ELECTRON_RUN_AS_NODE=1
call node_modules\.bin\electron.cmd -e "require('sqlite3')"
set SQLITE_CHECK_EXIT=%ERRORLEVEL%
set ELECTRON_RUN_AS_NODE=
exit /b %SQLITE_CHECK_EXIT%

:sqlite_failed
echo SQLite native dependency repair failed. Electron was not started.
pause
exit /b 1

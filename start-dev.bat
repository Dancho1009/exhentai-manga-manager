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

echo [4/5] Starting Vite dev server...
if exist .vite-dev.pid del .vite-dev.pid >nul 2>nul
if exist .vite-dev.log del .vite-dev.log >nul 2>nul
if exist .vite-dev.err del .vite-dev.err >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $client = [Net.Sockets.TcpClient]::new('localhost', 5374); $client.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /c npm run dev' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '.vite-dev.log' -RedirectStandardError '.vite-dev.err' -PassThru; Set-Content -Path '.vite-dev.pid' -Value $p.Id -Encoding ASCII"

  echo Waiting for http://localhost:5374 ...
  for /l %%i in (1,1,90) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $client = [Net.Sockets.TcpClient]::new('localhost', 5374); $client.Close(); exit 0 } catch { exit 1 }"
    if not errorlevel 1 goto vite_ready
    if exist .vite-dev.pid (
      for /f %%p in (.vite-dev.pid) do powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-Process -Id %%p -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { exit 0 } else { exit 1 }"
      if errorlevel 1 goto vite_failed
    )
    timeout /t 1 /nobreak >nul
  )

  echo Vite did not become ready on port 5374.
  echo Close any process using port 5374, then try again.
  goto vite_failed_cleanup

  :vite_failed
  echo Vite exited before port 5374 became ready.
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
  echo Port 5374 is already open. Reusing the existing dev server.
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

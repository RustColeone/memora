@echo off
setlocal
cd /d "%~dp0\.."

echo [MemoSystem] Building web assets and syncing Capacitor...
call npm run cap:sync
if errorlevel 1 (
  echo.
  echo [ERROR] Sync failed.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Sync complete.
pause

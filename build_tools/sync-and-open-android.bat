@echo off
setlocal
cd /d "%~dp0\.."

echo [MemoSystem] Syncing Capacitor first...
call npm run cap:sync
if errorlevel 1 (
  echo.
  echo [ERROR] Sync failed. Android Studio will not open.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Opening Android project...
call npm run cap:open:android
if errorlevel 1 (
  echo.
  echo [ERROR] Could not open Android project.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Sync + open complete.
pause

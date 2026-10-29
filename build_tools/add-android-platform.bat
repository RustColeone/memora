@echo off
setlocal
cd /d "%~dp0\.."

echo [MemoSystem] Adding Android platform (run once)...
call npm run cap:add:android
if errorlevel 1 (
  echo.
  echo [ERROR] Could not add Android platform.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Android platform added.
pause

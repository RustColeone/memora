@echo off
setlocal
cd /d "%~dp0\.."

echo [MemoSystem] Opening Android project...
call npm run cap:open:android
if errorlevel 1 (
  echo.
  echo [ERROR] Could not open Android project.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Android project opened.
pause

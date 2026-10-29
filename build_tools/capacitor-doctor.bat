@echo off
setlocal
cd /d "%~dp0\.."

echo [MemoSystem] Running Capacitor doctor...
call npm run cap:doctor
if errorlevel 1 (
  echo.
  echo [ERROR] Doctor check failed.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Doctor check complete.
pause

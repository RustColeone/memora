@echo off
REM ============================================================================
REM  Quick frontend debugging.
REM
REM  Serves the LIVE src\ frontend (Jinja templates + static JS/CSS) through the
REM  Flask backend at http://localhost:5050 and opens your browser at it.
REM  Edit anything under src\ and just refresh - no build / cap sync needed.
REM  Open Chrome DevTools (F12) for the console + network.
REM  Press Ctrl+C in this window to stop.
REM
REM  Note: this runs in "server" mode (same-origin Flask), which is ideal for UI
REM  / styling / layout work. Native-only behaviour (Capacitor blob store, cross-
REM  origin sync, safe-area) still needs the Android build on the emulator.
REM
REM  Browser tests (Playwright, headless Chromium - build www\ first automatically):
REM    npm test              all Playwright specs
REM    npm run test:browser  browser suite via tests\run_all.py
REM    npm run test:all      backend + browser
REM ============================================================================
setlocal
if "%MEMO_PORT%"=="" set MEMO_PORT=5050

echo.
echo   Memo frontend (live src\)  -^>  http://localhost:%MEMO_PORT%/
echo   Edit anything under src\ and refresh the browser. Ctrl+C to stop.
echo.

REM Give the server ~2s to bind, then open the default browser (in the background).
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%MEMO_PORT%/'"

python backend\server.py

endlocal

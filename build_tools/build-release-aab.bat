@echo off
setlocal
cd /d "%~dp0\.."

set "KEY_PROPERTIES=android\key.properties"
set "AAB_PATH=android\app\build\outputs\bundle\release\app-release.aab"
set "STORE_FILE="
set "STORE_FILE_PATH="

if not exist "%KEY_PROPERTIES%" (
  echo [ERROR] Missing %KEY_PROPERTIES%.
  echo Create it from android\key.properties.example before building a release bundle.
  pause
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%KEY_PROPERTIES%") do (
  if /i "%%A"=="storeFile" set "STORE_FILE=%%B"
)

if not defined STORE_FILE (
  echo [ERROR] Could not find storeFile in %KEY_PROPERTIES%.
  pause
  exit /b 1
)

if "%STORE_FILE:~1,1%"==":" (
  set "STORE_FILE_PATH=%STORE_FILE%"
) else (
  set "STORE_FILE_PATH=android\%STORE_FILE%"
)

if not exist "%STORE_FILE_PATH%" (
  echo [ERROR] Keystore file not found:
  echo %STORE_FILE_PATH%
  echo Update storeFile in %KEY_PROPERTIES% to point to the generated keystore.
  pause
  exit /b 1
)

echo [MemoSystem] Syncing web assets into Capacitor...
call npm run cap:sync
if errorlevel 1 (
  echo.
  echo [ERROR] Capacitor sync failed.
  pause
  exit /b 1
)

echo.
echo [MemoSystem] Building signed Android App Bundle...
pushd android
call gradlew bundleRelease
set "BUILD_EXIT=%ERRORLEVEL%"
popd

if not "%BUILD_EXIT%"=="0" (
  echo.
  echo [ERROR] Release bundle build failed.
  pause
  exit /b %BUILD_EXIT%
)

echo.
if exist "%AAB_PATH%" (
  echo [OK] Release AAB generated:
  echo %AAB_PATH%
  echo.
  echo [MemoSystem] Copying AAB to project root...
  call node build_tools\verify-release-assets.cjs "%AAB_PATH%"
  if errorlevel 1 (
    echo [ERROR] Release assets do not match the built web app.
    exit /b 1
  )
  copy /y "%AAB_PATH%" "app-release.aab" >nul
  echo [OK] Copied to app-release.aab
) else (
  echo [WARN] Gradle finished but the expected AAB was not found at:
  echo %AAB_PATH%
)

pause

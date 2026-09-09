@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  echo [error] Missing .env. Copy .env.example to .env first.
  exit /b 1
)

findstr /b "YIRAN_UPSTREAM=http" .env >nul
if errorlevel 1 (
  echo [error] Configure YIRAN_UPSTREAM=https://your-xiaoce-server in .env
  exit /b 1
)

node scripts\ensure-yiran-sso-secret.js
if errorlevel 1 exit /b %ERRORLEVEL%

echo [start] mind-map with remote Yiran API
for /f "tokens=1,* delims==" %%A in ('findstr /b "YIRAN_UPSTREAM=" .env') do echo   Yiran upstream: %%B
echo   WorkBuddy stays on host :3000 via /wb-api
echo.

rem app depends on postgres and redis, but no longer requires the local yiran container.
docker compose up -d --build app
set "ec=%ERRORLEVEL%"
if not "%ec%"=="0" exit /b %ec%

echo.
echo [ok] Remote-Yiran mode is up. Verify /yiran/api/health/ through the gateway.
endlocal

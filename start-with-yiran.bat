@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not defined YIRAN_ROOT set "YIRAN_ROOT=C:\Users\YiRan\IdeaProjects\yiran"
if not exist "%YIRAN_ROOT%\backend\manage.py" (
  echo [error] Yiran backend not found at:
  echo   %YIRAN_ROOT%
  echo Set YIRAN_ROOT to your local clone, e.g.
  echo   set YIRAN_ROOT=C:\Users\YiRan\IdeaProjects\yiran
  exit /b 1
)

rem Docker Desktop on Windows prefers forward slashes in compose env paths.
set "YIRAN_ROOT=%YIRAN_ROOT:\=/%"

node scripts\ensure-yiran-sso-secret.js
if errorlevel 1 exit /b %ERRORLEVEL%

if not defined MIND_MAP_PORT (
  for /f "tokens=1,* delims==" %%A in ('findstr /b "MIND_MAP_PORT=" .env') do set "MIND_MAP_PORT=%%B"
)
if not defined MIND_MAP_PORT set "MIND_MAP_PORT=8080"

echo [start] mind-map + yiran API
echo   YIRAN_ROOT=%YIRAN_ROOT%
echo   Gateway: http://localhost:%MIND_MAP_PORT%/
echo   Yiran:   http://localhost:%MIND_MAP_PORT%/yiran/api/docs/
echo   WorkBuddy stays on host :3000 via /wb-api
echo.

docker compose up -d --build %*
set "ec=%ERRORLEVEL%"
if not "%ec%"=="0" (
  echo [error] docker compose failed with code %ec%
  exit /b %ec%
)

echo.
echo [ok] Stack is up. Verify:
echo   curl http://localhost:%MIND_MAP_PORT%/health
echo   curl http://localhost:%MIND_MAP_PORT%/api/health
echo   curl http://localhost:%MIND_MAP_PORT%/yiran/api/schema/
endlocal

@echo off
rem ---------------------------------------------------------------
rem  Start the LAN hub page (the "main service" the mind map talks to)
rem  Usage: double-click, or "start-lan-hub.bat 5050" for another port
rem ---------------------------------------------------------------
chcp 65001 >nul
title Task Button - LAN Hub
cd /d "%~dp0"

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set LAN_HUB_ALLOW_ORIGIN=*.stillgroup.net

set PORT=5000
if not "%~1"=="" set PORT=%~1

where python >nul 2>nul
if errorlevel 1 (
  echo [x] python not found in PATH. Install Python 3 first.
  pause
  exit /b 1
)

echo Starting LAN hub on port %PORT% ...
python "%~dp0workbuddy-lan-hub.py" --port %PORT%

echo.
echo Hub stopped.
pause

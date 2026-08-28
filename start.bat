@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launcher.js %*
if errorlevel 1 pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Docker，请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)
node scripts\docker-up.js %*
if errorlevel 1 pause

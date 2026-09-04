@echo off
chcp 65001 >nul
title 泡泡大作戰
cd /d "%~dp0"
echo 正在啟動泡泡大作戰...
start "" http://localhost:3040
node server.js
if errorlevel 1 (
  echo.
  echo 啟動失敗了。請確認電腦有裝 Node.js：https://nodejs.org
  echo 或者也可以直接用瀏覽器打開 public\index.html 就能玩。
)
pause

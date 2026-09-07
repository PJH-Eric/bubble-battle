@echo off
chcp 65001 >nul
title 泡泡大作戰
cd /d "%~dp0"

rem ---- 先把 node 找出來 ----
rem PATH 裡沒有不代表沒裝。nvm-windows 的 nodejs 捷徑壞掉時，PATH 上會只剩
rem npm/npx 的殼，node.exe 其實還躺在各版本自己的資料夾裡，這裡就自己去翻。
set "NODE_EXE="
set "NODE_FROM_PATH="

for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE (
  set "NODE_EXE=%%N"
  set "NODE_FROM_PATH=1"
)

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem nvm-windows：從新版找到舊版，這個遊戲要 Node 18 以上
for %%M in (24 23 22 21 20 19 18) do (
  if not defined NODE_EXE (
    for /f "delims=" %%D in ('dir /b /a:d "%APPDATA%\nvm\v%%M.*" 2^>nul') do (
      if not defined NODE_EXE if exist "%APPDATA%\nvm\%%D\node.exe" set "NODE_EXE=%APPDATA%\nvm\%%D\node.exe"
    )
  )
)

if not defined NODE_EXE (
  echo.
  echo 找不到 Node.js。
  echo   想玩線上對戰：先安裝 Node.js https://nodejs.org
  echo   只想單機玩　：直接用瀏覽器打開 public\index.html 就可以了
  echo.
  pause
  exit /b 1
)

if not defined NODE_FROM_PATH (
  echo 注意：PATH 裡找不到 node，這次改用
  echo   %NODE_EXE%
  echo 想一勞永逸的話，用系統管理員身分開命令提示字元執行：nvm use 22.11.0
  echo.
)

echo 正在啟動泡泡大作戰...
rem 等伺服器起來再開瀏覽器，不然第一次會開到連線失敗的頁面
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:3050"
"%NODE_EXE%" server.js
if errorlevel 1 (
  echo.
  echo 伺服器結束了。剛才按 Ctrl+C 的話這是正常的。
  echo 這次用的 node：%NODE_EXE%
)
pause

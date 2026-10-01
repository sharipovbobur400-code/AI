@echo off
chcp 65001 >nul
title Solar Factory WMS
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js topilmadi. https://nodejs.org dan Node.js 22 yoki undan yangisini o'rnating.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo .env fayli yaratildi. Super admin birinchi ochilishda saytda yaratiladi.
)
echo Solar Factory WMS ishga tushmoqda: http://localhost:3000
start "" http://localhost:3000
rem Server to'xtab qolsa — 5 soniyadan so'ng avtomatik qayta ishga tushadi (butunlay to'xtatish: oynani yoping)
:loop
node --no-warnings app.js
echo [%date% %time%] Server to'xtadi - 5 soniyadan so'ng qayta ishga tushadi...
timeout /t 5 /nobreak >nul
goto loop

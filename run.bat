@echo off
NET SESSION >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    powershell -Command "Start-Process -Verb RunAs -FilePath '%0' -ArgumentList 'am_admin'"
    exit /b
)

if "%1"=="am_admin" (
    cd /d D:\Code\AlmostHadAI
    net start MySQL90
    git checkout main
    node D:\Code\AlmostHadAI\src\bot.js
)
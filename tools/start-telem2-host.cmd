@echo off
setlocal
cd /d "%~dp0.."
start "Telem2 server" cmd /k "npm start"
start "Betaflight mass-storage watcher" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0betaflight-mass-storage.ps1"

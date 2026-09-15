@echo off
setlocal
start "Telem2 server" /D "%~dp0.." cmd.exe /k npm start
start "Betaflight mass-storage watcher" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0betaflight-mass-storage.ps1"

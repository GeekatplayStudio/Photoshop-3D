@echo off
rem ==========================================================================
rem  Geekatplay 3D Layers - one-click installer for Windows
rem
rem  Just double-click this file. It works on its own: it uses install-windows.ps1
rem  from the same folder if it is there, otherwise it fetches that script from
rem  https://github.com/GeekatplayStudio/Photoshop-3D (install/install-windows.ps1).
rem  The script downloads the latest plugin release, checks it, and installs it
rem  with Adobe's own plugin installer. Read it to see every step.
rem ==========================================================================
title Geekatplay 3D Layers - installer
setlocal
set "GEEKATPLAY_INSTALLER=cmd"
set "SCRIPT=%~dp0install-windows.ps1"
set "URL=https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-windows.ps1"

if exist "%SCRIPT%" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; try { $s = Invoke-RestMethod -UseBasicParsing '%URL%' } catch { Write-Host ('Could not download the installer: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }; & ([scriptblock]::Create($s)) %*"
)
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
    echo All done. You can close this window.
) else (
    echo Something went wrong - see the messages above.
)
echo.
pause
exit /b %EXITCODE%

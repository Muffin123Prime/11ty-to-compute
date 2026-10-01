@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - den Probelauf auf den Stick legen (Paket P, docs\PROBELAUF.md)
rem
rem  Ein Doppelklick statt "node tools\probelauf.js --auf-stick E:\": sucht
rem  den EINEN eingesteckten Stick mit Neural OS (vorbereitet mit [Neue KI])
rem  und legt "Probelauf - Windows" und "Probelauf - Mac" darauf. Startet
rem  nichts. Das Fenster bleibt offen, bis eine Taste gedrueckt wird: Es sagt,
rem  was passiert ist und wie es weitergeht.
rem
rem  Node wird gesucht wie in "Neural OS starten.bat". ASCII und CRLF aus
rem  demselben Grund wie dort: cmd.exe liest die Datei haeppchenweise in der
rem  alten Codepage. In Klammerbloecken steht kein echo.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal enableextensions disabledelayedexpansion
title Neural OS - Probelauf auf den Stick

set "HIER=%~dp0"
set "NODE="
if not exist "%HIER%tools\probelauf.js" goto :kein_skript

rem 1. node.exe direkt neben dieser Datei.
if exist "%HIER%node.exe" (
  set "NODE=%HIER%node.exe"
  goto :los
)

rem 2. Ein entpackter Node-Ordner hier, eine Ebene hoeher oder im
rem    Download-Ordner, auch zwei Ebenen tief ("Alle extrahieren").
for %%B in ("%HIER%." "%HIER%.." "%USERPROFILE%\Downloads") do (
  for /d %%D in ("%%~fB\node-v*") do (
    if exist "%%~fD\node.exe" (
      set "NODE=%%~fD\node.exe"
      goto :los
    )
    if exist "%%~fD\%%~nxD\node.exe" (
      set "NODE=%%~fD\%%~nxD\node.exe"
      goto :los
    )
  )
)
if exist "%HIER%..\node.exe" set "NODE=%HIER%..\node.exe"
if defined NODE goto :los

rem 3. Ein regulaer installiertes Node.js.
where node >nul 2>&1
if not errorlevel 1 (
  set "NODE=node"
  goto :los
)
goto :kein_node

:los
echo.
"%NODE%" "%HIER%tools\probelauf.js" --auf-stick auto
goto :halt

:kein_node
echo.
echo   Node.js wurde nicht gefunden. Erst "Neural OS starten.bat" zum Laufen bringen.
goto :halt

:kein_skript
echo.
echo   Diese Datei gehoert in den Ordner "neural-os", neben "tools".
goto :halt

:halt
echo.
pause
endlocal
exit /b 0

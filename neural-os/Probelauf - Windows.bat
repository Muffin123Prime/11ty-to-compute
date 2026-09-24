@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - Probelauf fuer Windows (Paket P, docs\STICK-BAUPLAN.md)
rem
rem  Ein Doppelklick beantwortet, was sich ohne diesen Rechner nicht pruefen
rem  laesst: Geht das Fenster zu, sind Programme vom Stick erlaubt, sind die
rem  Ports frei, wie oft blockiert der Virenschutz ein Umbenennen?
rem
rem  Diese Datei liegt byte-gleich an zwei Stellen:
rem   - im Projektordner als "Probelauf - Windows.bat", fuer den Fall ohne
rem     vorbereiteten Stick (ZIP entpackt, node.exe daneben);
rem   - als Vorlage tools\launchers\probelauf-windows.bat, die
rem     "node tools\probelauf.js --auf-stick <Stick>" auf den Stick legt.
rem  Deshalb sucht sie Skript und Node an beiden Orten, auf dem Stick zuerst.
rem
rem  ASCII und CRLF aus demselben Grund wie "Neural OS starten.bat": cmd.exe
rem  liest die Datei waehrend des Laufs haeppchenweise in der alten Codepage.
rem  Die Umlaute stehen deshalb umschrieben; alles Weitere sagt die Seite im
rem  Browser.
rem
rem  Im Erfolgsfall endet sie mit "exit /b 0" OHNE pause: Ob das Fenster dann
rem  wirklich zugeht, ist genau die erste Frage des Probelaufs.
rem ---------------------------------------------------------------------------
setlocal enableextensions
title Neural OS Probelauf

set "HIER=%~dp0"
set "SKRIPT="
set "NODE="

rem Das Skript: Stick im neuen Aufbau, Stick im alten Aufbau, Projektordner.
if exist "%HIER%Inhalt\probelauf.js" set "SKRIPT=%HIER%Inhalt\probelauf.js"
if not defined SKRIPT if exist "%HIER%probelauf.js" set "SKRIPT=%HIER%probelauf.js"
if not defined SKRIPT if exist "%HIER%tools\probelauf.js" set "SKRIPT=%HIER%tools\probelauf.js"
if not defined SKRIPT goto :kein_skript

rem Node wie der echte Starter: die Laufzeit auf dem Stick. Ein 32-Bit-cmd
rem auf 64-Bit-Windows meldet x86; die wahre Architektur steht dann in
rem PROCESSOR_ARCHITEW6432. Windows auf ARM fuehrt x64 emuliert aus.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%ARCH%"=="ARM64" if exist "%HIER%Inhalt\runtime\win-arm64\node.exe" set "NODE=%HIER%Inhalt\runtime\win-arm64\node.exe"
if /i "%ARCH%"=="ARM64" if not defined NODE if exist "%HIER%runtime\win-arm64\node.exe" set "NODE=%HIER%runtime\win-arm64\node.exe"
if not defined NODE if exist "%HIER%Inhalt\runtime\win-x64\node.exe" set "NODE=%HIER%Inhalt\runtime\win-x64\node.exe"
if not defined NODE if exist "%HIER%runtime\win-x64\node.exe" set "NODE=%HIER%runtime\win-x64\node.exe"
if defined NODE goto :probe

rem Kein Stick: Node suchen wie "Neural OS starten.bat" im Projektordner.
rem 1. node.exe direkt neben dieser Datei.
if exist "%HIER%node.exe" (
  set "NODE=%HIER%node.exe"
  goto :probe
)

rem 2. Ein entpackter Node-Ordner neben dieser Datei, eine Ebene hoeher oder
rem    im Download-Ordner, auch zwei Ebenen tief ("Alle extrahieren").
for %%B in ("%HIER%." "%HIER%.." "%USERPROFILE%\Downloads") do (
  for /d %%D in ("%%~fB\node-v*") do (
    if exist "%%~fD\node.exe" (
      set "NODE=%%~fD\node.exe"
      goto :probe
    )
    if exist "%%~fD\%%~nxD\node.exe" (
      set "NODE=%%~fD\%%~nxD\node.exe"
      goto :probe
    )
  )
)

rem 3. Ein regulaer installiertes Node.js.
where node >nul 2>&1
if not errorlevel 1 (
  set "NODE=node"
  goto :probe
)
goto :kein_node

:probe
rem Nicht annehmen, dass es laeuft - ausprobieren. Scheitert schon das, ist
rem genau das das Ergebnis dieses Probelaufs. Jeder Code ausser 0 zaehlt:
rem Ein Absturz meldet einen negativen Code, und "if errorlevel 1" hiesse
rem nur "1 oder mehr" - der Probelauf ginge dann still zu.
"%NODE%" -e "" >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :gesperrt

echo.
echo   Probelauf startet ...
echo.
rem Hinter dem Ordner steht ein Punkt: Ein Backslash direkt vor dem
rem schliessenden Anfuehrungszeichen wuerde es fuer Node maskieren.
"%NODE%" "%SKRIPT%" --start --ort "%HIER%."
if not "%ERRORLEVEL%"=="0" goto :fehler
exit /b 0

:gesperrt
echo.
echo   Dieser Rechner laesst keine Programme vom Stick starten.
goto :halt

:kein_node
echo.
if exist "%HIER%Inhalt\" goto :kein_node_stick
if exist "%HIER%runtime\" goto :kein_node_stick
echo   Node.js wurde nicht gefunden. node.exe neben diese Datei legen.
goto :halt

:kein_node_stick
echo   Auf diesem Stick fehlt das Programm fuer Windows.
goto :halt

:kein_skript
echo.
echo   Der Probelauf fehlt: probelauf.js wurde nicht gefunden.
goto :halt

:fehler
rem Den Grund hat Node schon ausgegeben.
goto :halt

:halt
echo.
pause
endlocal
exit /b 1

@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - Starter fuer den eigenen Windows-Rechner
rem
rem  Fuer den Fall, dass auf dem Rechner nichts installiert werden darf.
rem  Node.js gibt es als ZIP ohne Installer (nodejs.org, "Standalone-
rem  Binaerdatei"); die node.exe daraus neben diese Datei legen, doppelklicken,
rem  fertig. Kein Administrator, kein Terminal, kein PATH.
rem
rem  Wie der Starter auf dem Stick (tools\launchers\start-windows.bat, Stick-
rem  Bauplan 2.4): Neural OS startet im Hintergrund, der Browser geht auf,
rem  dieses Fenster schliesst sich von selbst. Ein zweiter Doppelklick oeffnet
rem  nur den Browser. Beendet wird in der App mit [Beenden] - oder von selbst
rem  nach 10 Minuten ohne offenen Tab. Nur wenn etwas nicht geht, bleibt das
rem  Fenster offen und nennt den Grund.
rem
rem  Nicht verwechseln mit tools\launchers\start-windows.bat: der gehoert auf
rem  den Stick und erwartet dort den Stick-Aufbau (Inhalt\app, runtime\ ...).
rem  Dieser hier startet den Quelltext-Ordner, in dem er liegt, und legt die
rem  Daten an der normalen Stelle ab - derselben wie "npm start".
rem
rem  Diese Datei ist absichtlich ohne Umlaute und mit CRLF-Zeilenenden
rem  gespeichert: cmd.exe liest Batchdateien haeppchenweise in der alten
rem  Codepage, ein Umlaut kann dabei eine Zeile zerlegen, und LF-Zeilenenden
rem  bringen manche cmd-Fassungen bei goto durcheinander. In Klammerbloecken
rem  steht kein echo, und kein echo gibt einen Pfad aus: Ein Ordner wie
rem  "neural-os (1)" oder einer mit Und-Zeichen wuerde sonst mitgelesen.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal enableextensions disabledelayedexpansion
title Neural OS

set "HIER=%~dp0"
set "NODE="

rem 1. node.exe liegt direkt neben dieser Datei - der empfohlene Weg.
if exist "%HIER%node.exe" (
  set "NODE=%HIER%node.exe"
  goto :probe
)

rem 2. Ein entpackter Node-Ordner neben dieser Datei, eine Ebene hoeher oder
rem    noch im Download-Ordner. "Alle extrahieren" legt unter Windows einen
rem    Ordner mit dem Namen der ZIP an, und die ZIP enthaelt selbst noch einen
rem    Ordner - die node.exe liegt dann ZWEI Ebenen tief. Beide Lagen pruefen.
rem    Dazu eine node.exe, die lose eine Ebene hoeher liegt.
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
if exist "%HIER%..\node.exe" set "NODE=%HIER%..\node.exe"
if defined NODE goto :probe

rem 3. Ein regulaer installiertes Node.js.
where node >nul 2>&1
if not errorlevel 1 (
  set "NODE=node"
  goto :probe
)
goto :kein_node

:probe
rem Nicht annehmen, dass es laeuft - ausprobieren. Auf manchen verwalteten
rem Rechnern darf ein Programm ausserhalb von "Programme" nicht starten.
"%NODE%" -e "" >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :gesperrt

if not exist "%HIER%bin\neural-os.js" goto :kein_programm

rem Der Starter schreibt "Neural OS startet ...", startet den Dienst ohne
rem Fenster, oeffnet den Browser und endet. Laeuft Neural OS schon, oeffnet
rem er nur den Browser. Scheitert etwas, steht der Grund schon da.
"%NODE%" "%HIER%bin\neural-os.js" start --hintergrund --open
if not "%ERRORLEVEL%"=="0" goto :warten
endlocal
exit /b 0

:kein_node
echo.
echo   Node.js wurde nicht gefunden - ohne das kann Neural OS nicht starten.
echo.
echo   So geht es OHNE Installation und OHNE Administratorrechte:
echo     1. nodejs.org/en/download oeffnen.
echo     2. Unten bei "vorgefertigten Node.js" den Knopf
echo        "Standalone-Binaerdatei (.zip)" nehmen - NICHT den Installer.
echo     3. Die ZIP entpacken. Darin liegt eine Datei node.exe.
echo     4. Diese node.exe in den Ordner kopieren, in dem diese Datei liegt.
echo     5. Diese Datei noch einmal doppelklicken.
echo.
echo   Gesucht wurde: neben dieser Datei, eine Ebene hoeher, im Download-
echo   Ordner und unter den installierten Programmen.
goto :warten

:gesperrt
echo.
echo   Dieser Rechner laesst keine Programme vom Stick starten.
goto :warten

:kein_programm
echo.
echo   Diese Datei gehoert in den Ordner "neural-os", neben "bin" und "src".
goto :warten

:warten
echo.
pause
endlocal
exit /b 1

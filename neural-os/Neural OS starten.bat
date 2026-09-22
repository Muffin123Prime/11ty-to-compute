@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - Starter fuer den eigenen Windows-Rechner
rem
rem  Fuer den Fall, dass auf dem Rechner nichts installiert werden darf.
rem  Node.js gibt es als ZIP ohne Installer (nodejs.org, "Standalone-
rem  Binaerdatei"); die node.exe daraus neben diese Datei legen, doppelklicken,
rem  fertig. Kein Administrator, kein Terminal, kein PATH.
rem
rem  Nicht verwechseln mit tools\launchers\start-windows.bat: der gehoert auf
rem  den Stick und erwartet dort den Stick-Aufbau (app\, runtime\, data\).
rem  Dieser hier startet den Quelltext-Ordner, in dem er liegt, und legt die
rem  Daten an der normalen Stelle ab - derselben wie "npm start".
rem
rem  Diese Datei ist absichtlich ohne Umlaute und mit CRLF-Zeilenenden
rem  gespeichert: cmd.exe liest Batchdateien haeppchenweise in der alten
rem  Codepage, ein Umlaut kann dabei eine Zeile zerlegen, und LF-Zeilenenden
rem  bringen manche cmd-Fassungen bei goto durcheinander.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal enableextensions
title Neural OS

set "HIER=%~dp0"
set "NODE="
set "WOHER="

rem 1. node.exe liegt direkt neben dieser Datei - der empfohlene Weg.
if exist "%HIER%node.exe" (
  set "NODE=%HIER%node.exe"
  set "WOHER=neben dieser Datei"
  goto :probe
)

rem 2. Ein entpackter Node-Ordner neben dieser Datei, eine Ebene hoeher oder
rem    noch im Download-Ordner. "Alle extrahieren" legt unter Windows einen
rem    Ordner mit dem Namen der ZIP an, und die ZIP enthaelt selbst noch einen
rem    Ordner - die node.exe liegt dann ZWEI Ebenen tief. Beide Lagen pruefen.
for %%B in ("%HIER%." "%HIER%.." "%USERPROFILE%\Downloads") do (
  for /d %%D in ("%%~fB\node-v*") do (
    if exist "%%~fD\node.exe" (
      set "NODE=%%~fD\node.exe"
      set "WOHER=%%~fD"
      goto :probe
    )
    if exist "%%~fD\%%~nxD\node.exe" (
      set "NODE=%%~fD\%%~nxD\node.exe"
      set "WOHER=%%~fD\%%~nxD"
      goto :probe
    )
  )
)

rem 3. Ein regulaer installiertes Node.js.
where node >nul 2>&1
if not errorlevel 1 (
  set "NODE=node"
  set "WOHER=installiertes Node.js"
  goto :probe
)
goto :no_node

:probe
rem Nicht annehmen, dass es laeuft - ausprobieren. Auf manchen verwalteten
rem Rechnern darf ein Programm ausserhalb von "Programme" nicht starten.
"%NODE%" -e "" >nul 2>&1
if errorlevel 1 goto :blocked

if not exist "%HIER%bin\neural-os.js" goto :no_app

echo.
echo   Neural OS wird gestartet ...
echo.
echo   Node:      %WOHER%
echo   Programm:  %HIER%
echo.
echo   Gleich oeffnet sich dein Browser. Dieses Fenster bitte offen lassen -
echo   solange es offen ist, laeuft Neural OS. Beenden mit Strg+C.
echo.

"%NODE%" "%HIER%bin\neural-os.js" start --open
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" goto :crashed
echo   Neural OS wurde beendet.
goto :end

:crashed
echo   Neural OS wurde mit Fehler %CODE% beendet.
echo.
echo   Versuche es im abgesicherten Modus (ohne eigene Erweiterungen):
echo       "%NODE%" "%HIER%bin\neural-os.js" start --safe
echo.
goto :end

:no_node
echo.
echo   Node.js wurde nicht gefunden - ohne das kann Neural OS nicht starten.
echo.
echo   So geht es OHNE Installation und OHNE Administratorrechte:
echo     1. nodejs.org/en/download oeffnen.
echo     2. Unten bei "vorgefertigten Node.js" den Knopf
echo        "Standalone-Binaerdatei (.zip)" nehmen - NICHT den Installer.
echo     3. Die ZIP entpacken. Darin liegt eine Datei node.exe.
echo     4. Diese node.exe in DIESEN Ordner kopieren, neben diese Datei:
echo        %HIER%
echo     5. Diese Datei noch einmal doppelklicken.
echo.
echo   Gesucht wurde: neben dieser Datei, eine Ebene hoeher, im Download-
echo   Ordner und unter den installierten Programmen.
echo.
goto :end

:blocked
echo.
echo   Node.js wurde gefunden, darf auf diesem Rechner aber nicht laufen:
echo       %NODE%
echo.
echo   Das ist meist eine Einstellung des Rechners (Schule, Firma), die
echo   Programme ausserhalb von "Programme" sperrt. Dagegen hilft hier nichts.
echo.
echo   Was stattdessen geht:
echo     - Neural OS auf einem anderen Rechner starten (z. B. MacBook) und
echo       diesen hier als Bildschirm benutzen: dort "Einstellungen" -^>
echo       "Freigabe im lokalen Netz", hier nur den Browser oeffnen.
echo     - Oder den Stick-Weg von dem anderen Rechner aus vorbereiten.
echo   Beides steht in docs\ERSTE-SCHRITTE.md.
echo.
goto :end

:no_app
echo.
echo   Diese Datei liegt nicht im Programmordner von Neural OS.
echo   Gesucht wurde:  %HIER%bin\neural-os.js
echo.
echo   Sie gehoert in den Ordner "neural-os" - dort, wo auch "package.json",
echo   "bin", "src" und "web" liegen.
echo.
goto :end

:end
echo.
pause
endlocal

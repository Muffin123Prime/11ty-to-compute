@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - Starter fuer Windows (auf dem Stick)
rem
rem  Doppelklick: Neural OS startet im Hintergrund, der Browser geht auf, und
rem  dieses Fenster schliesst sich von selbst. Nur wenn etwas nicht geht,
rem  bleibt es offen, nennt den Grund in einem Satz und wartet auf eine Taste
rem  (docs\STICK-BAUPLAN.md, 1.2 und 2.4).
rem
rem  Zwei Aufbauten des Sticks, der neue zuerst:
rem   - Inhalt\app, Inhalt\runtime, Inhalt\data
rem   - app, runtime, data direkt auf dem Stick (alter Aufbau)
rem  Welcher Datenordner gilt, entscheidet die Markierung neural-os.portable,
rem  nicht dieser Starter; er gibt keinen Datenordner vor.
rem
rem  Warum die Datei so aussieht:
rem   - ASCII und CRLF: cmd.exe liest Batchdateien waehrend des Laufs
rem     haeppchenweise in der alten Codepage. Ein Umlaut kann eine Zeile
rem     zerlegen, LF-Zeilenenden bringen goto durcheinander. Die zwei Saetze,
rem     die hier stehen, sind deshalb umschrieben; alle anderen sagt Node.
rem   - chcp 65001, damit die Saetze von Node mit Umlauten ankommen.
rem   - Keine Klammerbloecke, kein echo mit Pfad: Eine Klammer oder ein
rem     Und-Zeichen im Ordnernamen (etwa "Stick (2)") wuerde sonst mitgelesen.
rem   - Im Erfolgsfall "exit /b 0" ohne pause: Das Fenster geht zu.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal enableextensions disabledelayedexpansion
title Neural OS

set "HIER=%~dp0"
set "APP="
set "NODE="

if exist "%HIER%Inhalt\app\bin\neural-os.js" set "APP=%HIER%Inhalt\app\bin\neural-os.js"
if not defined APP if exist "%HIER%app\bin\neural-os.js" set "APP=%HIER%app\bin\neural-os.js"
if not defined APP goto :kein_programm

rem Ein 32-Bit-cmd auf 64-Bit-Windows meldet x86; die wahre Architektur
rem steht dann in PROCESSOR_ARCHITEW6432. Windows auf ARM fuehrt x64
rem emuliert aus, die x64-Laufzeit ist also auch dort ein Weg.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%ARCH%"=="ARM64" if exist "%HIER%Inhalt\runtime\win-arm64\node.exe" set "NODE=%HIER%Inhalt\runtime\win-arm64\node.exe"
if /i "%ARCH%"=="ARM64" if not defined NODE if exist "%HIER%runtime\win-arm64\node.exe" set "NODE=%HIER%runtime\win-arm64\node.exe"
if not defined NODE if exist "%HIER%Inhalt\runtime\win-x64\node.exe" set "NODE=%HIER%Inhalt\runtime\win-x64\node.exe"
if not defined NODE if exist "%HIER%runtime\win-x64\node.exe" set "NODE=%HIER%runtime\win-x64\node.exe"
if not defined NODE goto :kein_programm

rem Nicht annehmen, dass es geht - ausprobieren. Richtlinien der Schule
rem oder Firma sperren oft genau das: Programme von Wechseldatentraegern.
"%NODE%" -e "" >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :gesperrt

rem Weg vom Stick: Solange das Arbeitsverzeichnis dieses Fensters dort
rem liegt, meldet Windows ihn als "in Verwendung".
cd /d "%SystemRoot%" >nul 2>&1

rem Der Starter schreibt "Neural OS startet ...", startet den Dienst ohne
rem Fenster, oeffnet den Browser und endet. Laeuft Neural OS schon, oeffnet
rem er nur den Browser. Scheitert etwas, steht der Grund schon da.
"%NODE%" "%APP%" start --hintergrund --open
if not "%ERRORLEVEL%"=="0" goto :warten
endlocal
exit /b 0

:kein_programm
echo.
echo   Auf diesem Stick fehlt das Programm fuer Windows.
goto :warten

:gesperrt
echo.
echo   Dieser Rechner laesst keine Programme vom Stick starten.
goto :warten

:warten
echo.
pause
endlocal
exit /b 1

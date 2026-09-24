@echo off
rem ---------------------------------------------------------------------------
rem  Neural OS - Starter fuer Windows
rem
rem  Wird beim Vorbereiten des Sticks als "Neural OS starten.bat" in den
rem  Stick-Ordner gelegt. Er findet sein eigenes Verzeichnis ueber %~dp0,
rem  waehlt die passende Laufzeit und startet die Anwendung.
rem
rem  Zwei bewusste Entscheidungen:
rem   - chcp 65001 stellt die Konsole auf UTF-8, damit die deutschen Meldungen
rem     von Neural OS selbst lesbar sind und nicht als Zeichensalat erscheinen.
rem   - Der Text in DIESER Datei kommt trotzdem ohne Umlaute aus: cmd.exe liest
rem     die Batchdatei haeppchenweise und noch in der alten Codepage, waehrend
rem     sie laeuft. Ein Umlaut in Zeile 40 kann dann die Zeile zerlegen. Ein
rem     unleserlicher Starter ist schlimmer als ein Starter ohne Umlaute.
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal enableextensions
title Neural OS

set "STICK=%~dp0"

rem 32-Bit-cmd auf einem 64-Bit-Windows meldet x86; die wahre Architektur
rem steht dann in PROCESSOR_ARCHITEW6432.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"

set "PLAT=win-x64"
if /i "%ARCH%"=="ARM64" set "PLAT=win-arm64"

set "NODE=%STICK%runtime\%PLAT%\node.exe"
if exist "%NODE%" goto :have_runtime

rem Windows auf ARM fuehrt x64-Programme emuliert aus - der Stick laeuft also
rem auch dann, wenn nur die x64-Laufzeit dabei ist.
if /i not "%PLAT%"=="win-arm64" goto :no_runtime
set "PLAT=win-x64 (emuliert)"
set "NODE=%STICK%runtime\win-x64\node.exe"
if exist "%NODE%" goto :have_runtime
goto :no_runtime

:have_runtime
if not exist "%STICK%app\bin\neural-os.js" goto :no_app

echo.
echo   Neural OS wird gestartet ...
echo.
echo   Laufzeit:  %PLAT%
echo   Daten:     %STICK%data
echo.
echo   Gleich oeffnet sich dein Browser. Dieses Fenster bitte offen lassen -
echo   solange es offen ist, laeuft Neural OS. Zum Aufhoeren in Neural OS
echo   unter Einstellungen -^> Stick auf "Beenden ^& abziehen" tippen.
echo.

set "NEURAL_OS_HOME=%STICK%data"
"%NODE%" "%STICK%app\bin\neural-os.js" start --open
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" goto :crashed

rem Sauber beendet: das Arbeitsverzeichnis dieses Fensters liegt auf dem
rem Stick, und solange es dort liegt, meldet Windows den Stick als "in
rem Verwendung". Also weg vom Stick, kurz Bescheid geben, Fenster zu.
cd /d "%SystemRoot%"
echo   Neural OS wurde beendet. Alles ist gespeichert.
echo   Jetzt kannst du den Stick abziehen.
echo.
timeout /t 6 >nul 2>&1
endlocal
exit /b 0

:crashed
echo   Neural OS wurde mit Fehler %CODE% beendet.
echo.
echo   Versuche es im abgesicherten Modus (ohne eigene Erweiterungen):
echo       "%NODE%" "%STICK%app\bin\neural-os.js" start --safe
echo.
echo   Hilft das nicht, steht in LIESMICH.txt, was du sonst tun kannst.
goto :end

:no_runtime
echo.
echo   Neural OS kann auf diesem Rechner nicht starten.
echo.
echo   Es fehlt die Laufzeitumgebung fuer:  %ARCH%  (erwartet: %PLAT%)
echo   Gesucht wurde hier:                  %STICK%runtime\%PLAT%\node.exe
echo.
echo   Das heisst: Der Stick wurde auf einem Rechner mit einem anderen
echo   Betriebssystem oder einer anderen Prozessorarchitektur vorbereitet.
echo.
echo   So legst du die fehlende Laufzeit nach:
echo     1. Stick an einem Rechner mit Neural OS und Internet einstecken.
echo        Dort unter Einstellungen -^> Stick noch einmal auf
echo        "Stick vorbereiten" tippen und "Erlauben" waehlen. Dein Wissen
echo        auf dem Stick bleibt dabei, wie es ist.
echo     2. Oder: Node.js ab Version 20 auf diesem Rechner installieren
echo        (nodejs.org) und dann in diesem Ordner ausfuehren:
echo            node app\bin\neural-os.js start --open
echo.
goto :end

:no_app
echo.
echo   Der Programmordner "app" fehlt auf dem Stick oder ist unvollstaendig.
echo   Gesucht wurde:  %STICK%app\bin\neural-os.js
echo.
echo   Das passiert, wenn der Stick waehrend des Kopierens abgezogen wurde.
echo   Stecke ihn an einem Rechner mit Neural OS ein und tippe dort unter
echo   Einstellungen -^> Stick auf "Stick vorbereiten". Deine Daten in
echo   "data" sind davon nicht betroffen - die werden dabei nie angefasst.
echo.
goto :end

:end
echo.
pause
endlocal

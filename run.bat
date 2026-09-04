@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 낚시 출조 현황판 - 한 번에 실행
rem
rem   run.bat            의존성 설치 + 화면 띄우기 + 브라우저 열기 (기본)
rem   run.bat admin      같은 서버를 띄우고 시스템 관리 페이지를 엽니다
rem   run.bat noupdate   시작할 때 git pull 을 건너뜁니다
rem   run.bat collect    전체 수집. docs\data.json 을 갱신합니다
rem   run.bat all        수집한 다음 화면 띄우기
rem   run.bat test       파서 회귀 테스트. 네트워크 불필요
rem   run.bat debug [id] 사이트 한 곳만 돌려보기. id 생략하면 목록

if "%PORT%"=="" set "PORT=8080"

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem 켤 때 한 번 최신화합니다. git이 없거나, 레포가 아니거나, 손댄 파일이 있어
rem 빨리감기가 안 되면 그냥 넘어갑니다. 여기서 멈출 만한 일이 아닙니다.
if /i "%~1"=="noupdate" goto :skip_update
where git >nul 2>nul
if errorlevel 1 goto :skip_update
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :skip_update
echo [최신화] git pull ...
git pull --ff-only
if errorlevel 1 echo [알림] 최신화를 건너뜁니다. 손댄 파일이 있거나 네트워크가 안 됩니다.
echo.
:skip_update

if not exist "node_modules\." goto :install
goto :ready

:install
echo [준비] 의존성을 설치합니다. 처음 한 번만 걸립니다...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :install_failed
echo.

:ready
set "CMD=%~1"
if "%CMD%"=="" set "CMD=serve"

if /i "%CMD%"=="serve"   goto :serve
if /i "%CMD%"=="admin"   goto :admin
if /i "%CMD%"=="noupdate" goto :serve
if /i "%CMD%"=="collect" goto :collect
if /i "%CMD%"=="all"     goto :all
if /i "%CMD%"=="test"    goto :test
if /i "%CMD%"=="debug"   goto :debug
goto :usage

:all
call :do_collect
echo.

:admin
set "OPENPATH=/admin.html"

:serve
if "%OPENPATH%"=="" set "OPENPATH=/"
echo [실행] 현황판  http://localhost:%PORT%
echo        관리    http://localhost:%PORT%/admin.html
echo        잠시 뒤 브라우저가 자동으로 열립니다. 끄려면 Ctrl+C.
echo        관리 페이지의 "서버 종료" 버튼으로도 끌 수 있습니다.
echo.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & explorer http://localhost:%PORT%%OPENPATH%"

rem 관리 페이지에서 "최신 코드 받고 재시작"을 누르면 서버가 75로 끝납니다.
rem 그때만 다시 띄웁니다. 그냥 종료(0)나 Ctrl+C면 여기서 끝납니다.
set "RESTARTABLE=1"
:serve_loop
node serve.js
if %errorlevel% equ 75 (
  echo.
  echo [재시작] 새 코드로 다시 띄웁니다...
  echo.
  goto :serve_loop
)
goto :end

:collect
call :do_collect
goto :end

:do_collect
if "%DAYS%"=="" set "DAYS=21"
echo [수집] 등록된 사이트를 %DAYS%일치 긁어옵니다. 몇 분 걸립니다...
echo.
node collect.js
if errorlevel 1 (
  echo.
  echo [알림] 수집 중 실패한 사이트가 있습니다. 위 로그를 확인하세요.
)
exit /b 0

:test
call npm test
goto :end

:debug
if "%~2"=="" goto :debug_list
node debug.js %2 %3 %4 %5
goto :end

:debug_list
node debug.js
goto :end

:usage
echo 사용법:
echo   run.bat                기본. 설치 + 화면 띄우기
echo   run.bat admin          시스템 관리 페이지 열기
echo   run.bat noupdate       git pull 없이 띄우기
echo   run.bat collect        전체 수집
echo   run.bat all            수집 후 화면 띄우기
echo   run.bat test           테스트
echo   run.bat debug ^<id^>     사이트 한 곳만 확인
goto :end

:no_node
echo [오류] Node.js를 찾을 수 없습니다.
echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 창을 닫고 다시 실행하세요.
goto :end

:install_failed
echo.
echo [오류] npm install 이 실패했습니다. 인터넷 연결이나 사내 프록시 설정을 확인하세요.
goto :end

:end
rem 탐색기에서 더블클릭해 실행했으면 창이 바로 닫히지 않게 잡아둡니다.
set "CMDLINE=%cmdcmdline%"
echo "%CMDLINE%" | find /i "%~nx0" >nul
if not errorlevel 1 pause
endlocal

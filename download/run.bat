@echo off
REM ============================================================
REM M.I.S.T. UNIFIED launcher (Next.js core :3000 + neural-service :3003)
REM First run on a new PC: auto-installs dependencies and creates
REM her database. Needs Bun (https://bun.sh). Usage: run.bat [build]
REM ============================================================
setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [MIST] Bun is not installed. Install it with:
  echo.
  echo        powershell -c "irm bun.sh/install.ps1 | iex"
  echo.
  echo        then open a NEW terminal and double-click run.bat again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [MIST] first run: installing core dependencies ...
  call bun install
  if errorlevel 1 ( echo [MIST] bun install failed. & pause & exit /b 1 )
)

if not exist "mini-services\neural-service\node_modules" (
  echo [MIST] first run: installing neural-service dependencies ...
  pushd mini-services\neural-service
  call bun install
  popd
  if errorlevel 1 ( echo [MIST] neural-service install failed. & pause & exit /b 1 )
)

if not exist db\custom.db (
  echo [MIST] first run: creating her local database ...
  call bun run db:push
)

echo [MIST] checking ports 3000 / 3003 ...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3003 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

if "%~1"=="build" (
  echo [MIST] building frontend ...
  call bun run build
)

echo [MIST] starting neural service (port 3003) ...
start "mist-neural" /min cmd /c "cd /d %~dp0mini-services\neural-service && bun run dev"

echo [MIST] starting M.I.S.T. (port 3000) ...
start "mist-core" /min cmd /c "cd /d %~dp0 && bun run dev"

timeout /t 8 /nobreak >nul
start http://localhost:3000
echo [MIST] online at http://localhost:3000
echo [MIST] tip: full system powers — Settings ^> Local Bridge ^> download mist-bridge.js, then:  node mist-bridge.js
echo.
echo [MIST] --------------- security (v3) ---------------
where node >nul 2>nul
if errorlevel 1 goto :noNode
node -e "const c=require('crypto'),f=require('fs'),p=require('path'),h=require('os').homedir();try{console.log('[MIST] bridge token : '+JSON.parse(f.readFileSync(p.join(h,'.mist','bridge.json'),'utf8')).token)}catch(e){console.log('[MIST] bridge token : not created yet - start the bridge once, then re-run run.bat')}try{const s=JSON.parse(f.readFileSync(p.join(h,'.mist','mist.json'),'utf8')).sessionSecret;console.log('[MIST] pair code    : '+c.createHmac('sha256',s).update('pair').digest('hex'))}catch(e){console.log('[MIST] pair code    : not created yet - open http://localhost:3000 once, then re-run run.bat')}"
goto :afterCreds
:noNode
echo [MIST] node not found - install Node.js, then re-run to print bridge token + pair code
:afterCreds
echo [MIST] bridge token: Settings ^> Local Bridge asks for it (Bearer auth on every bridge call).
echo [MIST] pair code: opens a paired session from another device or browser profile:
echo         http://localhost:3000/api/mist/pair?code=THE_PAIR_CODE
echo [MIST] plain-words guide: PC-SETUP.md, section 10 - Security (v3)
endlocal

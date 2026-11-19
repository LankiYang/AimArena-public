@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "GAME_NODE="
where node.exe >nul 2>nul
if not errorlevel 1 set "GAME_NODE=node.exe"
if defined GAME_NODE goto node_found
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "GAME_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined GAME_NODE goto node_found
echo 未找到 Node.js。请先准备 Node.js 22.12 或以上版本。
echo 此脚本不会自动安装软件或修改系统设置。
pause
exit /b 1

:node_found
"%GAME_NODE%" -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12)){console.error('Node.js 22.12+ required');process.exit(1)};require('./server.cjs');const fs=require('node:fs');for(const f of ['index.html','src/main.js','src/scene.js','assets/maps/ascent-full/levels.json'])if(!fs.existsSync(f))throw Error('Missing '+f)"
if errorlevel 1 goto failed
if /i "%~1"=="--check" goto checked
echo 无畏契约网页研究项目 - 开发切片
echo 默认地址 http://localhost:3000 ，仅当前电脑可通过 localhost 访问。
echo 局域网好友请使用本机局域网 IP，并输入同一房间码。
echo 不会修改系统、防火墙或网络设置；临时公网依赖本机服务器和隧道进程。
"%GAME_NODE%" server.cjs --open
if errorlevel 1 goto failed
exit /b 0

:checked
echo 启动检查通过：Node.js、依赖和入口文件均可用。
exit /b 0

:failed
echo 启动检查或服务启动失败，请查看上方错误。
echo 若复制项目后 node_modules 缺失，请先在本目录运行 pnpm install。
pause
exit /b 1

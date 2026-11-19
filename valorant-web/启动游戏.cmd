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
echo 未找到 Node.js。请先准备 Node.js 22 或以上版本。
echo 此脚本不会自动安装软件或修改系统设置。
pause
exit /b 1

:node_found
"%GAME_NODE%" -e "if(Number(process.versions.node.split('.')[0])<22){console.error('Node.js 22+ required');process.exit(1)};require.resolve('ws');require.resolve('three');require('./shared/world.cjs');const fs=require('node:fs');for(const f of ['server.cjs','index.html','src/main.js','src/scene.js'])if(!fs.existsSync(f))throw Error('Missing '+f)"
if errorlevel 1 goto failed
if /i "%~1"=="--check" goto checked
echo 无畏契约网页研究项目 - 开发切片
echo 默认地址 http://localhost:3000 ，仅当前电脑可通过 localhost 访问。
echo 局域网好友请使用本机局域网 IP，并输入同一房间码。
echo 不会修改系统、防火墙或网络设置；临时公网依赖本机服务器和隧道进程。
"%GAME_NODE%" -e "const port=Number(process.env.PORT||3000);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');const url='http://localhost:'+port;const open=()=>{const c=require('node:child_process').spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'});c.unref()};(async()=>{try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(1500)});const b=await r.json();if(b.ok&&Number.isInteger(b.tick)){console.log('Existing game server: '+url);open();return}}catch{}const api=require('./server.cjs');console.log('Loading Ascent B geometry...');const ascentWorld=await api.loadAscentWorld();const game=api.createGameServer({ascentWorld});game.server.once('error',e=>{console.error('Server error: '+e.message);game.close().then(()=>process.exit(1))});await game.listen(port);console.log('Game server: '+url+' -- Ctrl+C to stop');open();for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>game.close().then(()=>process.exit(0)))})().catch(e=>{console.error(e);process.exit(1)})"
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

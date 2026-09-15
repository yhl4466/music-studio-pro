@echo off
chcp 65001 >nul
title 智能音乐工坊 PRO - 本地服务器

cd /d %~dp0

echo.
echo ================================================
echo   智能音乐工坊 PRO - 本地服务器
echo ================================================
echo.
echo   项目目录: %cd%
echo   启动端口: 8080
echo.
echo   服务器启动后浏览器会自动打开
echo   关闭本窗口即可停止服务器
echo.
echo ================================================
echo.

REM 检查 npx 是否可用
where npx >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 npx，请先安装 Node.js
    echo 下载地址: https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM 延迟 2 秒后自动打开浏览器（等服务器起来）
start "" cmd /c "timeout /t 2 >nul && start http://localhost:8080"

REM 启动服务器
echo [启动中] 服务器正在运行，按 Ctrl+C 停止...
echo.
npx serve -p 8080

REM 如果服务器异常退出
echo.
echo [已停止] 服务器已关闭
pause
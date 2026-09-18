#!/usr/bin/env bash
# build.sh — 从 WSL 交叉构建 Windows 单文件 exe
# 产物：winapp/dist/ApiHealth.exe（框架依赖 + 单文件，需要目标机有 .NET 10 桌面运行时）
set -e
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
cd "$(dirname "$0")"

dotnet publish -c Release -r win-x64 --self-contained false \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -o dist

echo ""
echo "OK -> $(pwd)/dist/ApiHealth.exe"
ls -la dist/ApiHealth.exe
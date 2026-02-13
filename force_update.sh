#!/bin/bash

# 强制更新脚本 (Run this on Server)
# 解决 git pull 失败或冲突问题

echo ">>> 开始强制更新..."

# 1. 进入项目目录
cd /www/wwwroot/snake-game || cd ~/snake-game || exit

# 2. 强制重置代码到最新版本 (丢弃本地修改)
echo ">>> [1/3] 重置代码..."
git fetch --all
git reset --hard origin/main

# 3. 重新安装依赖 (防止 package-lock 冲突)
echo ">>> [2/3] 更新依赖..."
npm install

# 4. 重启服务
echo ">>> [3/3] 重启游戏..."
pm2 restart snake-game

echo ">>> ✅ 更新完成！当前版本: $(grep -oE "v[0-9]+\.[0-9]+\.[0-9]+" public/index.html | head -n 1)"

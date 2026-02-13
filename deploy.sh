#!/bin/bash

# ==========================================
# 贪吃蛇游戏一键部署/更新脚本 (v1.0.2)
# ==========================================

# 1. 确保在正确的运行目录 (宝塔目录)
PROJECT_DIR="/www/wwwroot/snake-game"
BACKUP_DIR="/home/admin/snake-game"

echo ">>> 开始部署更新..."

# 2. 从 GitHub 同步最新代码到备份目录 (admin)
echo ">>> [1/4] 正在从 GitHub 同步代码..."
cd $BACKUP_DIR
git fetch --all
git reset --hard origin/main

# 3. 将代码强制覆盖到宝塔运行目录
echo ">>> [2/4] 正在同步代码到生产目录..."
sudo cp -rf $BACKUP_DIR/* $PROJECT_DIR/

# 4. 清理旧进程并重启
echo ">>> [3/4] 正在清理旧进程并释放端口..."
# 暴力清理：杀死所有 node 进程（确保没有僵尸进程）
sudo pkill -f node || true
sudo fuser -k 8080/tcp || true
pm2 delete all || true

echo ">>> [4/4] 正在启动新版本..."
cd $PROJECT_DIR
pm2 start server.js --name "snake-game"

# 5. 最终验证
echo ">>> 部署完成！正在验证版本..."
# 动态获取 index.html 中的版本号
CURRENT_VERSION=$(grep -oE "v[0-9]+\.[0-9]+\.[0-9]+" $PROJECT_DIR/public/index.html | head -n 1)
echo ">>> 当前生产品版本: $CURRENT_VERSION"

echo "=========================================="
echo " 更新成功！"
echo " 请在浏览器访问并检查左侧是否显示: $CURRENT_VERSION"
echo " 如果不是，请务必执行：Ctrl + F5 (PC) 或 清理浏览器缓存 (手机)"
echo " http://47.112.222.117:8080 "
echo "=========================================="

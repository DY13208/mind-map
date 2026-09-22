#!/bin/bash

cd -- "$(dirname -- "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org/"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

node scripts/launcher.js "$@"
status=$?

if [ "$status" -ne 0 ]; then
  echo
  read -r -p "启动失败（错误码 $status），按回车键关闭窗口..."
fi

exit "$status"

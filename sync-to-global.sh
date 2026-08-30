#!/usr/bin/env bash
# =============================================================================
# PE → 全局 同步脚本（pi-auxiliary-models）
# 在 PE 开发验证通过后，把扩展同步到全局运行目录 ~/.pi/agent
#
# 用法：在 D:\FSCode\Pi-Extension 下执行  bash sync-to-global.sh
# 或：bash /d/FSCode/Pi-Extension/sync-to-global.sh
#
# 流程：
#   1. parse gate（扩展 .ts 语法检查，防半成品同步到全局）
#   2. 运行测试（node --test）
#   3. 备份全局旧版
#   4. 同步扩展 + lib 到全局
# =============================================================================
set -euo pipefail

PE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_EXT="$PE_DIR/pi-auxiliary-models/extensions/auxiliary-models.ts"
SRC_LIB="$PE_DIR/pi-auxiliary-models/lib"
GLOBAL_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

# 0. 前置检查
[ -f "$SRC_EXT" ] || { echo "✗ 找不到 PE 扩展: $SRC_EXT"; exit 1; }
[ -d "$SRC_LIB" ] || { echo "✗ 找不到 PE lib: $SRC_LIB"; exit 1; }
[ -d "$GLOBAL_DIR" ] || { echo "✗ 找不到全局目录: $GLOBAL_DIR"; exit 1; }

echo "=== 同步 pi-auxiliary-models → 全局 ==="
echo "源 (PE):  $PE_DIR"
echo "目标:     $GLOBAL_DIR"

# 1. Parse gate：扩展 .ts 语法检查（jiti 从全局取）
echo
GLOBAL_JITI="$GLOBAL_DIR/npm/node_modules/jiti"
[ -d "$GLOBAL_JITI" ] || { echo "✗ 找不到全局 jiti（$GLOBAL_JITI）"; exit 1; }
echo "[1/4] parse gate (jiti: $GLOBAL_JITI)..."
if JITI_PATH="$GLOBAL_JITI" SRC="$SRC_EXT" SRC_ABS="$SRC_EXT" node -e "
  const { createJiti } = require(process.env.JITI_PATH);
  createJiti(process.env.SRC_ABS).import(process.env.SRC).then(
    () => process.exit(0),
    (e) => {
      const m = String(e.message);
      if (/ParseError|SyntaxError/.test(m)) { console.error('语法错误:', m.slice(0,200)); process.exit(1); }
      console.error('模块解析错误（可忽略）:', m.slice(0,120)); process.exit(0);
    }
  );
" 2>&1; then
  echo "   ✓ 扩展语法 OK"
else
  echo "   ✗ parse gate 失败，中止同步（防止半成品同步到全局）"
  exit 1
fi

# 2. 测试
echo
echo "[2/4] 测试..."
if [ -d "$PE_DIR/pi-auxiliary-models/tests" ]; then
  (cd "$PE_DIR/pi-auxiliary-models" && node --test tests/*.test.mjs 2>&1 | tail -4)
else
  echo "   (PE 无 tests/，跳过 — 若需回归保护请先在 PE 建 tests/)"
fi

# 3. 备份全局旧版
echo
echo "[3/4] 备份全局旧版..."
TS="$(date +%Y%m%d-%H%M%S)"
if [ -f "$GLOBAL_DIR/extensions/auxiliary-models.ts" ]; then
  cp "$GLOBAL_DIR/extensions/auxiliary-models.ts" "$GLOBAL_DIR/extensions/auxiliary-models.ts.bak-$TS"
  echo "   ✓ 备份扩展: auxiliary-models.ts.bak-$TS"
fi
for f in "$GLOBAL_DIR"/lib/auxiliary-models-*.mjs; do
  [ -f "$f" ] && cp "$f" "$f.bak-$TS" && echo "   ✓ 备份 lib: $(basename "$f").bak-$TS"
done

# 4. 同步
echo
echo "[4/4] 同步..."
cp "$SRC_EXT" "$GLOBAL_DIR/extensions/auxiliary-models.ts"
mkdir -p "$GLOBAL_DIR/lib"
cp "$SRC_LIB"/auxiliary-models-*.mjs "$GLOBAL_DIR/lib/"
echo "   ✓ 已同步扩展 + lib 到全局"

echo
echo "=== 完成 ==="
echo "提示：重启 Pi 让全局扩展生效（当前运行的 Pi 用的是内存里的旧版本）。"
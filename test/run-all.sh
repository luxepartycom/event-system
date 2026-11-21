#!/bin/bash
# event-system の検査を全部走らせる。1つでも落ちたら終了コード1。
# 実行: bash test/run-all.sh   （jsdom は ~/.cache/claude-node/node_modules を既定で使う）
cd "$(dirname "$0")/.." || exit 1
export NODE_PATH="${NODE_PATH:-$HOME/.cache/claude-node/node_modules}"
fail=0; n=0
for f in test/*.cjs test/*.mjs; do
  [ -e "$f" ] || continue
  n=$((n+1))
  out=$(node "$f" 2>&1); code=$?
  last=$(printf '%s\n' "$out" | grep -v '^\s*$' | tail -1)
  if [ $code -eq 0 ]; then echo "✅ $f  $last"; else echo "❌ $f (exit $code)  $last"; printf '%s\n' "$out" | grep -E '❌|⚠' | head -20; fail=1; fi
done
echo "—— event-system: ${n}本 $([ $fail -eq 0 ] && echo '全部通過 ✅' || echo '落ちたものあり ❌') ——"
exit $fail

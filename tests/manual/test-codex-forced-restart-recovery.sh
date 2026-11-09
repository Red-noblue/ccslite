#!/usr/bin/env bash
# Codex CLI 隔离验收兼容入口：自动创建副本，只调用本机伪供应商。
# 不读取当前供应商或既有 profile；所有测试进程由 Node 入口统一清理。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${LITE_CCSWITCH_NODE:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  printf '错误：找不到可用的 node，请设置 LITE_CCSWITCH_NODE。\n' >&2
  exit 1
fi
exec "${NODE_BIN}" "${SCRIPT_DIR}/test-codex-isolated.mjs" "$@"

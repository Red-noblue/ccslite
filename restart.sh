#!/usr/bin/env bash
# 中文独立仓库直启重启入口：只处理本目录的服务，旧进程排空已有 SSE 后退出。
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="${TOOL_DIR}"

usage() {
  printf '用法：%s <端口>\n' "$(basename "$0")"
  printf '示例：%s 15720\n' "$(basename "$0")"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if (( $# != 1 )); then
  usage >&2
  exit 2
fi

PORT="$1"
NODE_BIN="${LITE_CCSWITCH_NODE:-$(command -v node || true)}"

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  printf '错误：端口无效：%s\n' "${PORT}" >&2
  exit 1
fi

if [[ ! -x "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  printf '错误：找不到可用的 node。\n' >&2
  exit 1
fi

# 与 server.js 共用环境文件解析器；显式环境变量优先，文件内容不会作为 shell 执行。
runtime_env="$("${NODE_BIN}" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { loadRuntimeEnvironment } = await import(pathToFileURL(process.argv[1]));
  const env = loadRuntimeEnvironment(process.argv[2]);
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("LITE_CCSWITCH_") && !/[\r\n]/.test(value)) process.stdout.write(`${key}=${value}\n`);
  }
' "${TOOL_DIR}/lib/runtime-config.js" "${TOOL_DIR}")"
while IFS= read -r env_entry; do
  [[ -n "${env_entry}" ]] && export "${env_entry}"
done <<< "${runtime_env}"
unset runtime_env env_entry
LOG_PATH="${LITE_CCSWITCH_LOG:-/tmp/lite-ccswitch-project-${PORT}.log}"
LISTEN_HOST="${LITE_CCSWITCH_HOST:-127.0.0.1}"

ready() {
  # 仅检查无敏感信息的认证状态接口，兼容启用了管理令牌的服务。
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/auth/status" >/dev/null 2>&1
}

if ! "${NODE_BIN}" --check "${TOOL_DIR}/server.js"; then
  printf '错误：新版本 server.js 语法检查失败，保留当前服务，不执行重启。\n' >&2
  exit 1
fi

listener_pids() {
  lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

launchd_service_label() {
  local uid label details

  [[ "$(uname -s)" == "Darwin" ]] || return 1
  command -v launchctl >/dev/null 2>&1 || return 1
  uid="$(id -u)"
  label="com.$(id -un).$(basename "${PROJECT_ROOT}").lite-ccswitch.${PORT}"
  details="$(launchctl print "gui/${uid}/${label}" 2>/dev/null || true)"
  [[ -n "${details}" ]] || return 1
  [[ "${details}" == *"${TOOL_DIR}/server.js"* ]] || return 1
  [[ "${details}" == *"LITE_CCSWITCH_PORT=${PORT}"* ]] || return 1
  printf '%s\n' "${label}"
}

is_old_listener_pid() {
  local pid="$1"
  case $'\n'"${old_pids}"$'\n' in
    *$'\n'"${pid}"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

is_project_lite_ccswitch() {
  local pid="$1"
  local command_line="" process_directory=""
  command_line="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ "${command_line}" == *"${TOOL_DIR}/server.js"* ]] && return 0
  # npm start 使用相对脚本名；额外核对进程工作目录，不能误停另一份独立安装。
  [[ "${command_line}" == *"node server.js" || "${command_line}" == *"node ./server.js" ]] || return 1
  process_directory="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0, 2); exit}' || true)"
  [[ "${process_directory}" == "${TOOL_DIR}" ]]
}

old_pids="$(listener_pids)"
managed_launchd_label="$(launchd_service_label || true)"
if [[ -n "${old_pids}" ]]; then
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    listener_command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "${listener_command}" == *"handoff-runner.mjs"* ]]; then
      if [[ "${listener_command}" == *"--workspace"* ]]; then
        printf '错误：端口 %s 由根目录 handoff-runner（PID %s）管理，当前服务保持运行。\n' "${PORT}" "${pid}" >&2
        printf '请向 handoff-runner 发送一次 SIGTERM，等待连接排空后，再执行 handoff-runner.mjs --workspace。\n' >&2
      else
        printf '错误：端口 %s 由版本包 handoff-runner（PID %s）管理，当前服务保持运行。\n' "${PORT}" "${pid}" >&2
        printf '请向该 handoff-runner 发送一次 SIGTERM，等待连接排空后，再按原版本包命令启动。\n' >&2
      fi
      exit 1
    fi
    # 受版本监督器管理时不能直接停止子进程，否则会被当成崩溃并触发回退。
    parent_pid="$(ps -p "${pid}" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
    parent_command="$(ps -p "${parent_pid}" -o command= 2>/dev/null || true)"
    # handoff-runner 持有公开端口，不能直接结束它管理的工作子进程。
    if [[ "${parent_command}" == *"handoff-runner.mjs"* ]]; then
      if [[ "${parent_command}" == *"--workspace"* ]]; then
        printf '错误：端口 %s 由根目录 handoff-runner（PID %s）管理，当前服务保持运行。\n' "${PORT}" "${parent_pid}" >&2
        printf '请向 handoff-runner 发送一次 SIGTERM，等待连接排空后，再执行 handoff-runner.mjs --workspace。\n' >&2
      else
        printf '错误：端口 %s 由版本包 handoff-runner（PID %s）管理，当前服务保持运行。\n' "${PORT}" "${parent_pid}" >&2
        printf '请向该 handoff-runner 发送一次 SIGTERM，等待连接排空后，再按原版本包命令启动。\n' >&2
      fi
      exit 1
    fi
    if [[ "${parent_command}" == *"/release.mjs run "* ]]; then
      printf '错误：端口 %s 由版本监督器（PID %s）管理，当前服务保持运行。\n' "${PORT}" "${parent_pid}" >&2
      printf '请向监督器发送一次 SIGTERM，待现有请求排空并退出后，再用 release.mjs run 启动指定版本与回退版本。\n' >&2
      exit 1
    fi
    if ! is_project_lite_ccswitch "${pid}"; then
      printf '错误：端口 %s 被非当前项目的进程占用（PID %s），已停止重启。\n' "${PORT}" "${pid}" >&2
      exit 1
    fi
  done <<< "${old_pids}"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    printf '向旧 lite-ccswitch（PID %s）发送 SIGTERM，等待活动请求完成...\n' "${pid}"
    kill -TERM "${pid}"
  done <<< "${old_pids}"

  if [[ -n "${managed_launchd_label}" ]]; then
    printf '检测到 launchd 托管任务 %s；等待它在旧连接排空后接管新实例...\n' "${managed_launchd_label}"
    for _ in {1..300}; do
      while IFS= read -r pid; do
        [[ -n "${pid}" ]] || continue
        if ! is_old_listener_pid "${pid}" && ready; then
          printf 'lite-ccswitch 已由 launchd 优雅重启，PID：%s，端口：%s\n' "${pid}" "${PORT}"
          exit 0
        fi
      done <<< "$(listener_pids)"
      sleep 1
    done
    printf '错误：launchd 托管任务未在 300 秒内接管端口 %s。\n' "${PORT}" >&2
    exit 1
  fi

  while [[ -n "$(listener_pids)" ]]; do
    sleep 1
  done
  printf '旧进程已释放监听端口；已有连接继续排空，现在启动新版本接管新请求。\n'
else
  printf '端口 %s 当前没有监听进程，直接启动。\n' "${PORT}"
fi

cd "${PROJECT_ROOT}"
nohup env \
  LITE_CCSWITCH_HOST="${LISTEN_HOST}" \
  LITE_CCSWITCH_PORT="${PORT}" \
  "${NODE_BIN}" "${TOOL_DIR}/server.js" \
  >>"${LOG_PATH}" 2>&1 < /dev/null &
new_pid="$!"

for _ in {1..30}; do
  if ready; then
    printf 'lite-ccswitch 已优雅重启，PID：%s，端口：%s\n' "${new_pid}" "${PORT}"
    printf '启动日志：%s\n' "${LOG_PATH}"
    exit 0
  fi
  if ! kill -0 "${new_pid}" 2>/dev/null; then
    printf '错误：新 lite-ccswitch 启动失败，请查看：%s\n' "${LOG_PATH}" >&2
    exit 1
  fi
  sleep 1
done

printf '错误：新 lite-ccswitch 未在 30 秒内就绪，请查看：%s\n' "${LOG_PATH}" >&2
exit 1

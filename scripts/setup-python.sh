#!/usr/bin/env bash
# setup-python.sh — 为 memoplus4dsh 创建专用 python 环境并安装"完整版"组件。
#
# 装什么:
#   - sentence-transformers  → harrier embedding sidecar（1024 维多语言向量）
#   - torch + gliner + stanza → NER PyTorch sidecar（抽取候选提示，召回最完整）
#
# 为什么用专用 venv: 插件运行时解析的是 dsh 进程 PATH 上的 python3，和你
# 交互 shell 的 python3 未必是同一个（conda/系统/python.org 并存时尤其如此）。
# 专用 venv + 配置绝对路径后，这个不确定性彻底消失。
#
# 用法:
#   scripts/setup-python.sh [venv 目录]     # 默认 <插件目录>/venv
# 完成后按输出提示把 nerPython/embedPython 写进 profile 的 cordis.patch.yml。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${1:-$PLUGIN_DIR/venv}"

command -v python3 >/dev/null || { echo "setup-python.sh: python3 not found on PATH" >&2; exit 1; }

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "==> creating venv at $VENV"
  python3 -m venv "$VENV"
fi

echo "==> installing packages (torch 较大，首次约几百 MB，请耐心)"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install sentence-transformers torch gliner stanza

PY="$VENV/bin/python"
echo
echo "==> 验证探测"
"$PY" -c "import importlib.util, sys; mods=['sentence_transformers','torch','gliner','stanza']; missing=[m for m in mods if importlib.util.find_spec(m) is None]; print('missing:', missing) if missing else print('all present'); sys.exit(1 if missing else 0)"

cat <<EOF

==> 完成。把下面两行加进 profile 的 cordis.patch.yml 受管块 config: 里
    （与 extraction/injectTopK 同级），然后重启 dsh:

      nerPython: '$PY'
      embedPython: '$PY'

    验证: node $PLUGIN_DIR/scripts/doctor.mjs
    （模型本体在首次使用时自动下载：harrier ~1.2GB，GLiNER ~600MB，
      国内可在 config 里加 hfBaseUrl: 'https://hf-mirror.com'）
EOF

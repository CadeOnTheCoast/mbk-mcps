#!/usr/bin/env bash
#
# Set up the EveryAction Moves Management tools for Claude Desktop.
#
# What this installs:
#   1. uv                -- Python package manager (skipped if present)
#   2. browser-harness   -- drives your existing Chrome session
#   3. this MCP server   -- registered with Claude Desktop
#
# It does NOT ask for or store any EveryAction credentials. The tools work by
# using the EveryAction tab you are already signed in to.

set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-$HOME/Developer/browser-harness}"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
SERVER_NAME="everyaction-moves"
REPO_URL="https://github.com/CadeOnTheCoast/mbk-mcps.git"
INSTALL_ROOT="$HOME/Library/Application Support/MobileBaykeeper/everyaction-moves"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

# --- 0. Fetch the tool itself -------------------------------------------------
# This script may be running from a one-off unzipped copy (that's how people
# first get it), but the copy this installer sets Claude Desktop up to actually
# run always lives in a real git checkout at INSTALL_ROOT. That's what lets the
# server keep itself current later (see mcp_server.py's self-update): a fix
# pushed to this public repo reaches every install the next time Claude
# Desktop restarts it, with nobody sent a new zip.
say "1/6  Fetching the tool"
# `command -v git` is not a usable check on macOS: /usr/bin/git is a stub that
# exists even with no developer tools installed, pops the install dialog, and
# fails. Actually running it is the only way to know it works.
if ! git --version >/dev/null 2>&1; then
  warn "macOS needs its developer tools installed before this can run."
  warn "A box should have just appeared asking to install them -- click"
  warn "Install and let it finish (it takes a few minutes), then open"
  warn "Install.command again. Nothing here is broken; this is a one-time"
  warn "macOS step."
  exit 1
fi
if [ -d "$INSTALL_ROOT/.git" ]; then
  if git -C "$INSTALL_ROOT" pull --ff-only --quiet origin main; then
    ok "up to date"
  else
    warn "couldn't fast-forward the existing checkout -- reusing it as-is"
  fi
else
  rm -rf "$INSTALL_ROOT"
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$INSTALL_ROOT"
  git -C "$INSTALL_ROOT" sparse-checkout init --cone
  git -C "$INSTALL_ROOT" sparse-checkout set apps/moves-proxy
  git -C "$INSTALL_ROOT" checkout --quiet main
  ok "installed to $INSTALL_ROOT"
fi
HERE="$INSTALL_ROOT/apps/moves-proxy"

# --- 1. uv ------------------------------------------------------------------
say "2/6  Python tooling"
if command -v uv >/dev/null 2>&1; then
  ok "uv already installed"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  ok "uv installed"
fi
command -v uv >/dev/null 2>&1 || { warn "uv still not on PATH -- open a new terminal and re-run"; exit 1; }

# --- 2. browser-harness -----------------------------------------------------
say "3/6  browser-harness"
if command -v browser-harness >/dev/null 2>&1; then
  ok "browser-harness already installed"
else
  if [ ! -d "$HARNESS_DIR" ]; then
    mkdir -p "$(dirname "$HARNESS_DIR")"
    git clone https://github.com/browser-use/browser-harness "$HARNESS_DIR"
  fi
  (cd "$HARNESS_DIR" && uv tool install -e .)
  export PATH="$HOME/.local/bin:$PATH"
  ok "browser-harness installed at $HARNESS_DIR"
fi

# --- 3. server environment --------------------------------------------------
say "4/6  MCP server environment"
# Re-running the installer has to work: people run it again after installing
# developer tools or connecting Chrome. `uv venv` refuses to touch an existing
# environment, so only create one when there isn't a usable one already.
if [ -x "$HERE/.venv/bin/python" ]; then
  ok "reusing existing environment"
else
  rm -rf "$HERE/.venv"
  uv venv "$HERE/.venv" >/dev/null
fi
# shellcheck disable=SC1091
VIRTUAL_ENV="$HERE/.venv" uv pip install --quiet "mcp[cli]>=1.2.0"
ok "dependencies installed into $HERE/.venv"

# --- 4. Claude Desktop registration ----------------------------------------
say "5/6  Registering with Claude Desktop"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] || echo '{}' > "$CFG"
cp "$CFG" "$CFG.backup.$(date +%Y%m%d%H%M%S)"

PYBIN="$HERE/.venv/bin/python" SERVER="$HERE/mcp_server.py" NAME="$SERVER_NAME" \
CFG_PATH="$CFG" HARNESS_BIN="$(command -v browser-harness)" \
"$HERE/.venv/bin/python" - <<'PY'
import json, os

cfg_path = os.environ["CFG_PATH"]
with open(cfg_path) as fh:
    try:
        cfg = json.load(fh)
    except json.JSONDecodeError:
        cfg = {}

servers = cfg.setdefault("mcpServers", {})
servers[os.environ["NAME"]] = {
    "command": os.environ["PYBIN"],
    "args": [os.environ["SERVER"]],
    # browser-harness must be reachable from the server's own PATH.
    "env": {"PATH": os.path.dirname(os.environ["HARNESS_BIN"]) + ":/usr/bin:/bin:/usr/local/bin"},
}

with open(cfg_path, "w") as fh:
    json.dump(cfg, fh, indent=2)
print("  ✓ registered as", os.environ["NAME"])
PY

# --- 5. Chrome ---------------------------------------------------------------
say "6/6  Connecting to Chrome"
if printf 'print(page_info())\n' | browser-harness >/dev/null 2>&1; then
  ok "already attached to Chrome"
else
  warn "Chrome is not attached yet -- that's expected on a first install."
  warn "After Claude Desktop restarts, ask Claude to 'check my EveryAction"
  warn "session'. If Chrome shows an 'Allow remote debugging?' prompt, click"
  warn "Allow (or Claude will run 'browser-harness mac-approve' for you). It"
  warn "is remembered after that."
fi

say "Done"
# Install.command prints its own closing instructions; don't say it all twice.
[ -n "${MOVES_WRAPPED:-}" ] && exit 0
cat <<'EOF'
  Next:
    1. Make sure you are signed in to EveryAction in Chrome.
    2. Quit and reopen Claude Desktop.
    3. Ask Claude: "check my EveryAction session"

  Nothing here stores your EveryAction password. The tools use the browser
  session you are already signed in to, so changes are recorded under your own
  name in EveryAction's history.
EOF

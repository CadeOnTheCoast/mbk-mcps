#!/usr/bin/env bash
#
# Double-clickable installer. Finder opens .command files in Terminal, so the
# person installing never has to type a path or know what a shell is.

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

clear
cat <<'BANNER'

  EveryAction Moves Management — installer
  ========================================

  This connects Claude to the EveryAction you are already signed
  into in Chrome. It never asks for your password.

  It takes a few minutes. You can watch it work below.

BANNER

read -r -p "  Press Return to start (or close this window to cancel): " _ || true
echo

if ! MOVES_WRAPPED=1 ./install.sh; then
  echo
  echo "  ---------------------------------------------------------"
  echo "  Something went wrong above."
  echo "  Send Cade a screenshot of this window and he'll sort it."
  echo "  ---------------------------------------------------------"
  echo
  read -r -p "  Press Return to close: " _ || true
  exit 1
fi

cat <<'DONE'

  ---------------------------------------------------------
  Almost there — three things left, all outside this window:

    1. Open EveryAction in Chrome and sign in.
    2. Quit Claude Desktop completely (Command+Q), then reopen it.
    3. In a new chat, ask:   check my EveryAction session

  If it says you're connected, you're done.
  ---------------------------------------------------------

DONE

read -r -p "  Press Return to close this window: " _ || true

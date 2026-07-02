#!/data/data/com.termux/files/usr/bin/bash
# Chat2API Termux Startup Script
# Place this file in your Termux home directory and run: bash start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Chat2API Termux Headless Installer    ${NC}"
echo -e "${CYAN}========================================${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo -e "Install it with: ${YELLOW}pkg install nodejs${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
echo -e "${GREEN}Node.js version: $(node -v)${NC}"

if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${YELLOW}Warning: Node.js 20+ is recommended.${NC}"
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${CYAN}Installing dependencies...${NC}"
    npm install --no-audit --no-fund
    echo -e "${GREEN}Dependencies installed.${NC}"
fi

# Create config directory if not exists
CONFIG_DIR="$HOME/.chat2api"
if [ ! -d "$CONFIG_DIR" ]; then
    mkdir -p "$CONFIG_DIR"
    echo -e "${GREEN}Created config directory: $CONFIG_DIR${NC}"
fi

# Set environment variables
export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"

# Point NODE_PATH to termux node_modules so the proxy server code can find dependencies
# (The proxy server code is in ../src/main/proxy/ which doesn't have its own node_modules)
export NODE_PATH="${SCRIPT_DIR}/node_modules:${NODE_PATH}"

echo -e "${CYAN}Starting Chat2API proxy server...${NC}"
echo -e "  Port: ${GREEN}$PORT${NC}"
echo -e "  Host: ${GREEN}$HOST${NC}"
echo -e "  Config: ${GREEN}$CONFIG_DIR${NC}"
echo ""

# Start the server
# preload.cjs: Monkey-patches CJS require() to redirect Electron-dependent modules
# loader.ts: ESM module loader hook for import() calls
exec node --require ./src/preload.cjs --import tsx --import ./src/loader.ts ./src/index.ts
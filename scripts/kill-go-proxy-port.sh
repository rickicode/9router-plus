#!/bin/bash
# Kill any process using Go Proxy port

PORT=${1:-20138}

echo "Checking port $PORT..."

# Find and kill process
PID=$(lsof -ti :$PORT 2>/dev/null)

if [ -z "$PID" ]; then
  echo "✓ Port $PORT is free"
  exit 0
fi

echo "Found process $PID using port $PORT"
echo "Killing process..."

kill -9 $PID 2>/dev/null

sleep 1

# Verify
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "✗ Failed to kill process"
  exit 1
else
  echo "✓ Port $PORT is now free"
  exit 0
fi

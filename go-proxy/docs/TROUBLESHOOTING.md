# Go Proxy Troubleshooting

## Problem: Go Proxy tidak otomatis start

**Root cause:** `GO_PROXY_WRAPPER_ENABLED` environment variable tidak diset.

**Solution:**

### Option 1: Enable via environment variable
```bash
GO_PROXY_WRAPPER_ENABLED=true npm start
```

### Option 2: Use dedicated script
```bash
npm run start:with-go-wrapper
```

### Option 3: Start manually from UI
1. Open dashboard: http://localhost:20128/dashboard/endpoint
2. Go to "Go Proxy" tab
3. Click "Start" button

### Option 4: Add to .env file
```bash
echo "GO_PROXY_WRAPPER_ENABLED=true" >> .env
```

## Problem: NetworkError when attempting to fetch resource

**Symptoms:**
```
Failed to fetch logs: TypeError: NetworkError when attempting to fetch resource
Failed to fetch status: TypeError: NetworkError when attempting to fetch resource
```

**Root causes:**
1. Go Proxy binary tidak running
2. Binary tidak ditemukan
3. CLI arguments salah

**Solutions:**

### 1. Check if binary exists
```bash
ls -lh ~/.9router/bin/9router-go-proxy
```

If not found, build and install:
```bash
npm run build:go-proxy
npm run install:go-proxy
```

### 2. Test binary manually
```bash
# Generate tokens first (or use existing from UI)
export INTERNAL_PROXY_RESOLVE_TOKEN="your-token-here"
export INTERNAL_PROXY_REPORT_TOKEN="your-token-here"

# Test run
~/.9router/bin/9router-go-proxy \
  --host 127.0.0.1 \
  --port 20138 \
  --base-url http://localhost:20128 \
  --resolve-token "$INTERNAL_PROXY_RESOLVE_TOKEN" \
  --report-token "$INTERNAL_PROXY_REPORT_TOKEN" \
  --credentials-file ~/.9router/db.json
```

### 3. Check logs
```bash
# If running via npm start
# Logs will show in terminal

# If running via UI
# Check logs in Go Proxy tab > expand "Logs" section
```

### 4. Verify port is not in use
```bash
lsof -i :20138
# or
netstat -tlnp | grep 20138
```

If port is in use, kill the process:
```bash
lsof -ti :20138 | xargs kill -9
```

## Problem: Binary tidak bisa dijalankan

**Symptoms:**
```
Go Proxy binary not found. Run: npm run build:go-proxy && npm run install:go-proxy
```

**Solutions:**

### 1. Build from source
```bash
npm run build:go-proxy
npm run install:go-proxy
```

### 2. Download pre-built binary
```bash
# Linux x64
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-linux-amd64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy

# macOS Apple Silicon
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-darwin-arm64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy
```

### 3. Check Go installation
```bash
go version
# Should show: go version go1.22 or higher
```

If Go not installed:
- Linux: `sudo apt install golang-go` or download from https://go.dev/dl/
- macOS: `brew install go`
- Windows: Download installer from https://go.dev/dl/

## Problem: Permission denied

**Symptoms:**
```
permission denied: ~/.9router/bin/9router-go-proxy
```

**Solution:**
```bash
chmod +x ~/.9router/bin/9router-go-proxy
```

## Problem: Missing internal tokens

**Symptoms:**
```
Missing required internal auth token(s): INTERNAL_PROXY_RESOLVE_TOKEN, INTERNAL_PROXY_REPORT_TOKEN
```

**Solution:**

Tokens are auto-generated on first use. If missing:

1. Open UI: http://localhost:20128/dashboard/endpoint
2. Go to "Go Proxy" tab
3. Tokens will be auto-generated and displayed
4. Or regenerate manually by clicking "Regenerate" button

## Problem: Health check failed

**Symptoms:**
```
[Go Wrapper] Health check failed: http://127.0.0.1:20138/health
```

**Possible causes:**
1. Binary crashed on startup
2. Port already in use
3. Invalid configuration

**Solutions:**

### 1. Check binary logs
Look for error messages in terminal or UI logs section

### 2. Test health endpoint manually
```bash
curl http://localhost:20138/health
```

Expected response:
```json
{"status":"ok"}
```

### 3. Check if process is running
```bash
ps aux | grep 9router-go-proxy
```

### 4. Restart with verbose logging
```bash
# Stop current instance
pkill -f 9router-go-proxy

# Start with logging
~/.9router/bin/9router-go-proxy \
  --host 127.0.0.1 \
  --port 20138 \
  --base-url http://localhost:20128 \
  --resolve-token "your-token" \
  --report-token "your-token" \
  --credentials-file ~/.9router/db.json
```

## Problem: Process exited with code 1

**Common causes:**

### 1. Missing credentials file
```
config load failed: missing required internal proxy tokens
```

**Solution:** Ensure tokens are set (see "Missing internal tokens" above)

### 2. Port already in use
```
listen tcp 127.0.0.1:20138: bind: address already in use
```

**Solution:**
```bash
lsof -ti :20138 | xargs kill -9
```

### 3. Invalid base URL
```
failed to connect to nine-router
```

**Solution:** Ensure 9Router main server is running on port 20128:
```bash
lsof -i :20128
```

## Diagnostic Commands

### Full system check
```bash
# Check binary
ls -lh ~/.9router/bin/9router-go-proxy

# Check Go installation
go version

# Check ports
lsof -i :20128 -i :20138

# Check processes
ps aux | grep -E "(9router|go-proxy)"

# Test binary
~/.9router/bin/9router-go-proxy --help

# Check logs
tail -f ~/.9router/logs/go-proxy.log  # if logging to file
```

### Quick restart
```bash
# Kill all instances
pkill -f 9router-go-proxy

# Restart 9Router with go-proxy enabled
GO_PROXY_WRAPPER_ENABLED=true npm start
```

## Getting Help

If issues persist:

1. Check GitHub issues: https://github.com/rickicode/9router-plus/issues
2. Collect diagnostic info:
   ```bash
   # System info
   uname -a
   go version
   node --version
   
   # Binary info
   ls -lh ~/.9router/bin/9router-go-proxy
   file ~/.9router/bin/9router-go-proxy
   
   # Process info
   ps aux | grep -E "(9router|go-proxy)"
   lsof -i :20128 -i :20138
   
   # Logs
   # Copy terminal output or UI logs
   ```
3. Create issue with diagnostic info

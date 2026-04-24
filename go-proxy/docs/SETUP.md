# Go Proxy Local Setup

## Automatic Installation

When you run `npm install`, the Go proxy binary will be automatically built and installed to `~/.9router/bin/9router-go-proxy`.

**Requirements:**
- Go 1.22 or higher installed
- If Go is not found, the system will fallback to `go run` at runtime (slower startup)

## Manual Installation

If you want to manually build and install:

```bash
# Build the binary
npm run build:go-proxy

# Install to ~/.9router/bin/
npm run install:go-proxy
```

## Runtime Behavior

The `start.js` script will automatically detect and use the Go proxy binary in this order:

1. **Installed binary**: `~/.9router/bin/9router-go-proxy` (fastest)
2. **Local binary**: `./bin/9router-go-proxy` (fast)
3. **Fallback**: `go run main.go` (slower, requires Go installed)

## Verify Installation

Check if the binary is installed:

```bash
ls -lh ~/.9router/bin/9router-go-proxy
```

Test the binary:

```bash
~/.9router/bin/9router-go-proxy --help
```

## Download Pre-built Binaries

Instead of building locally, you can download pre-built binaries from GitHub releases:

```bash
# Linux x64
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-linux-amd64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy

# Linux ARM64
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-linux-arm64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy

# macOS Intel
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-darwin-amd64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy

# macOS Apple Silicon
curl -L https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-darwin-arm64 -o ~/.9router/bin/9router-go-proxy
chmod +x ~/.9router/bin/9router-go-proxy

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.9router\bin"
Invoke-WebRequest -Uri "https://github.com/rickicode/9router-plus/releases/latest/download/go-proxy-windows-amd64.exe" -OutFile "$env:USERPROFILE\.9router\bin\9router-go-proxy.exe"
```

## Configuration

The Go proxy reads configuration from environment variables:

```bash
# Host and port
export GO_PROXY_HOST=127.0.0.1
export GO_PROXY_PORT=20138

# 9Router base URL
export GO_PROXY_NINEROUTER_BASE_URL=http://127.0.0.1:20128

# Internal auth tokens (required)
export INTERNAL_PROXY_RESOLVE_TOKEN=your-resolve-token
export INTERNAL_PROXY_REPORT_TOKEN=your-report-token

# Credentials file path
export GO_PROXY_CREDENTIALS_FILE=~/.9router/db.json

# HTTP timeout
export GO_PROXY_HTTP_TIMEOUT_SECONDS=30
```

## Enable Go Proxy Wrapper

To enable the Go proxy wrapper at runtime:

```bash
# Using environment variable
GO_PROXY_WRAPPER_ENABLED=true npm start

# Or use the dedicated script
npm run start:with-go-wrapper
```

## Troubleshooting

### Binary not found at startup

If you see "No binary found, using 'go run'", it means:
- The binary is not installed in `~/.9router/bin/`
- The binary is not in `./bin/`
- Solution: Run `npm run build:go-proxy && npm run install:go-proxy`

### Permission denied

```bash
chmod +x ~/.9router/bin/9router-go-proxy
```

### Go not installed

If Go is not installed, you have two options:
1. Install Go 1.22+ from https://go.dev/dl/
2. Download pre-built binary from releases (see above)

### Build fails

Make sure you're in the project root and Go modules are initialized:

```bash
cd go-proxy
go mod tidy
cd ..
npm run build:go-proxy
```

## Performance Comparison

| Method | Startup Time | Memory | Notes |
|--------|--------------|--------|-------|
| Precompiled binary | ~50ms | ~10MB | Fastest, recommended |
| `go run` | ~2-3s | ~50MB | Slower, compiles on every start |

## CI/CD Integration

The GitHub Actions workflow automatically builds binaries for all platforms on every `go-proxy-v*` tag:

```bash
git tag go-proxy-v1.0.0
git push origin go-proxy-v1.0.0
```

Binaries will be available at:
https://github.com/rickicode/9router-plus/releases

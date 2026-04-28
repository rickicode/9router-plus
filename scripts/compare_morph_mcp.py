#!/usr/bin/env python3
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path
from tempfile import gettempdir

ENV_FILE = Path.home() / ".config" / "morph-test.env"
ROUTER_BASE_URL = "http://localhost:20128"

INIT_TIMEOUT = 15
TOOLS_TIMEOUT = 15
EDIT_TIMEOUT = 45
CASE_TIMEOUT = 70

DUMMY_FILE = Path(gettempdir()) / "morph-mcp-dummy.js"
DUMMY_FILE.write_text(
    "export function greet(name) {\n"
    "  return `Hello ${name}`;\n"
    "}\n",
    encoding="utf-8",
)


def load_env_file(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Missing env file: {path}")
    env = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        env[key.strip()] = value
    return env


def encode_message(msg: dict) -> bytes:
    body = json.dumps(msg).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    return header + body


class McpClient:
    def __init__(self, env: dict, allowed_dir: str):
        self.proc = subprocess.Popen(
            ["npx", "-y", "@morphllm/morphmcp", allowed_dir],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            bufsize=0,
        )
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.proc.stdout, selectors.EVENT_READ)
        self.buffer = b""

    def send(self, msg: dict):
        payload = encode_message(msg)
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()

    def read_message(self, timeout: float) -> dict:
        deadline = time.time() + timeout

        while b"\r\n\r\n" not in self.buffer:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for MCP header")
            events = self.sel.select(remaining)
            if not events:
                raise TimeoutError("Timed out waiting for stdout readiness")
            chunk = os.read(self.proc.stdout.fileno(), 4096)
            if not chunk:
                raise RuntimeError("MCP process closed while reading header")
            self.buffer += chunk

        header_raw, rest = self.buffer.split(b"\r\n\r\n", 1)
        content_length = None
        for line in header_raw.decode("utf-8").split("\r\n"):
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
                break
        if content_length is None:
            raise RuntimeError("Missing Content-Length in MCP response")

        while len(rest) < content_length:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for MCP body")
            events = self.sel.select(remaining)
            if not events:
                raise TimeoutError("Timed out waiting for MCP body readiness")
            chunk = os.read(self.proc.stdout.fileno(), 4096)
            if not chunk:
                raise RuntimeError("MCP process closed while reading body")
            rest += chunk

        body = rest[:content_length]
        self.buffer = rest[content_length:]
        return json.loads(body.decode("utf-8"))

    def request(self, msg: dict, timeout: float) -> dict:
        self.send(msg)
        return self.read_message(timeout)

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                self.proc.wait(timeout=3)
        except Exception:
            if self.proc.poll() is None:
                self.proc.kill()

        try:
            stderr_data = self.proc.stderr.read().decode("utf-8", "ignore")
        except Exception:
            stderr_data = ""
        return stderr_data[-2000:]


def timed_call(fn):
    start = time.perf_counter()
    value = fn()
    elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
    return value, elapsed_ms


def run_case(label: str, extra_env: dict) -> dict:
    env = os.environ.copy()
    env.update(extra_env)

    client = McpClient(env=env, allowed_dir=str(DUMMY_FILE.parent))
    case_started = time.perf_counter()

    try:
        init_resp, init_ms = timed_call(
            lambda: client.request(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "morph-compare", "version": "1.0.0"},
                    },
                },
                INIT_TIMEOUT,
            )
        )

        client.send(
            {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            }
        )

        tools_resp, tools_ms = timed_call(
            lambda: client.request(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/list",
                    "params": {},
                },
                TOOLS_TIMEOUT,
            )
        )

        tools = tools_resp.get("result", {}).get("tools", [])
        tool_names = [tool.get("name") for tool in tools]

        if "edit_file" not in tool_names:
            return {
                "label": label,
                "ok": False,
                "error": "edit_file tool not exposed",
                "tool_names": tool_names,
                "timing_ms": {
                    "initialize": init_ms,
                    "tools_list": tools_ms,
                    "edit_file": None,
                    "total": round((time.perf_counter() - case_started) * 1000, 2),
                },
                "stderr_tail": client.close(),
            }

        edit_resp, edit_ms = timed_call(
            lambda: client.request(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "edit_file",
                        "arguments": {
                            "path": str(DUMMY_FILE),
                            "instruction": "I am benchmarking Morph MCP edit_file compatibility on a dummy file.",
                            "code_edit": (
                                "export function greet(name) {\n"
                                "  // ... existing code ...\n"
                                "  return `Hello, ${name}!`;\n"
                                "}\n"
                            ),
                            "dryRun": True,
                        },
                    },
                },
                EDIT_TIMEOUT,
            )
        )

        total_ms = round((time.perf_counter() - case_started) * 1000, 2)
        result = edit_resp.get("result", {})
        is_error = result.get("isError", False)

        return {
            "label": label,
            "ok": not is_error,
            "tool_names": tool_names,
            "server_info": init_resp.get("result", {}).get("serverInfo", {}),
            "timing_ms": {
                "initialize": init_ms,
                "tools_list": tools_ms,
                "edit_file": edit_ms,
                "total": total_ms,
            },
            "edit_result_preview": json.dumps(result)[:2000],
            "stderr_tail": client.close(),
        }

    except Exception as exc:
        total_ms = round((time.perf_counter() - case_started) * 1000, 2)
        return {
            "label": label,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "timing_ms": {
                "initialize": None,
                "tools_list": None,
                "edit_file": None,
                "total": total_ms,
            },
            "stderr_tail": client.close(),
        }


def main():
    file_env = load_env_file(ENV_FILE)
    api_key = file_env.get("MORPH_API_KEY")
    if not api_key:
        print("MORPH_API_KEY missing in ~/.config/morph-test.env", file=sys.stderr)
        sys.exit(1)

    cases = [
        {
            "label": "morph-default",
            "env": {
                "MORPH_API_KEY": api_key,
            },
        },
        {
            "label": "9router-override",
            "env": {
                "MORPH_API_KEY": api_key,
                "MORPH_API_URL": ROUTER_BASE_URL,
            },
        },
    ]

    results = []
    for case in cases:
        print(f"\n=== Running {case['label']} ===")
        result = run_case(case["label"], case["env"])
        results.append(result)
        print(json.dumps(result, indent=2))

    print("\n=== Compare Summary ===")
    summary = []
    for result in results:
        summary.append(
            {
                "label": result["label"],
                "ok": result["ok"],
                "error": result.get("error"),
                "timing_ms": result["timing_ms"],
            }
        )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

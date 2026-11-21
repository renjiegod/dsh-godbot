"""Guest stdio MCP adapter for the host-owned authenticated loopback bridge."""
import concurrent.futures
import http.client
import json
import os
import sys
import threading
import urllib.parse

endpoint = urllib.parse.urlsplit(os.environ["GODBOT_MCP_URL"])
token = os.environ["GODBOT_MCP_TOKEN"]
if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.path != "/mcp":
    sys.exit(1)
write_lock = threading.Lock()


def send(obj):
    with write_lock:
        print(json.dumps(obj, separators=(",", ":")), flush=True)


def forward(line):
    call_id = None
    conn = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=120)
    try:
        msg = json.loads(line)
        call_id = msg.get("id")
        conn.request("POST", "/mcp", body=line, headers={"Authorization": "Bearer " + token,
                     "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        response = conn.getresponse()
        if response.status in (202, 204):
            return
        if response.status != 200:
            raise ValueError("MCP HTTP request failed")
        if response.headers.get_content_type() == "text/event-stream":
            parts = []
            for raw in response:
                row = raw.decode().rstrip("\r\n")
                if row.startswith("data:"):
                    parts.append(row[5:].lstrip(" "))
                elif not row and parts:
                    send(json.loads("\n".join(parts)))
                    parts = []
            if parts:
                send(json.loads("\n".join(parts)))
        else:
            reply = json.load(response)
            for item in reply if isinstance(reply, list) else [reply]:
                send(item)
    except (OSError, ValueError, http.client.HTTPException):
        if call_id is not None:
            send({"jsonrpc": "2.0", "id": call_id, "error": {"code": -32603, "message": "MCP transport failed"}})
    finally:
        conn.close()


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
    for record in sys.stdin.buffer:
        workers.submit(forward, record)

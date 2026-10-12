#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import urllib.request

binary = sys.argv[1]
env = dict(os.environ, CASEBOOK_DB=os.path.abspath("work.db"), CASEBOOK_MODE="embedded")
process = subprocess.Popen([binary, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
exchanges = []

def send(obj):
    process.stdin.write(json.dumps(obj, separators=(",", ":")) + "\n")
    process.stdin.flush()

def request(identifier, method, params=None):
    req = {"jsonrpc": "2.0", "id": identifier, "method": method}
    if params is not None:
        req["params"] = params
    send(req)
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        reply = json.loads(line)
        if reply.get("id") == identifier:
            if "error" in reply:
                raise RuntimeError(reply)
            exchanges.append({"request": req, "response": reply, "wireBytes": len(line.encode())})
            return reply["result"]

try:
    initialized = request(1, "initialize", {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "arena-proof", "version": "1"}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    listed = request(2, "tools/list", {})
    called = request(3, "tools/call", {"name": "get", "arguments": {"ref": 1}})
    assert {tool["name"] for tool in listed["tools"]} == {"get", "propose", "report"}
    assert called["structuredContent"]["ref"] == 1
    assert not called.get("isError", False)
finally:
    process.stdin.close()
    process.wait(timeout=10)
    assert process.returncode == 0

help_text = {}
for operation in ("get", "propose", "report"):
    help_text[operation] = subprocess.check_output([binary, operation, "--help"], env=env, text=True)
    assert "--input" in help_text[operation]
cli_result = json.loads(subprocess.check_output([binary, "get", "--ref", "1"], env=env, text=True))
assert cli_result["ref"] == 1
openapi = json.loads(subprocess.check_output([binary, "openapi"], env=env, text=True))
assert openapi["openapi"] == "3.1.0"

server = subprocess.Popen([binary, "serve", "--db", env["CASEBOOK_DB"]], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    address = json.loads(server.stdout.readline())["listen"]
    with urllib.request.urlopen(address + "/openapi.json") as response:
        served_openapi = json.load(response)
    assert served_openapi == openapi
    for tool in listed["tools"]:
        operation = openapi["paths"]["/ops/" + tool["name"]]["post"]
        assert operation["requestBody"]["content"]["application/json"]["schema"] == tool["inputSchema"]
        assert operation["responses"]["200"]["content"]["application/json"]["schema"] == tool["outputSchema"]
finally:
    server.terminate()
    server.wait(timeout=10)

with open("openapi.json", "w") as file:
    json.dump(openapi, file, indent=2)
with open("registry-proof.json", "w") as file:
    json.dump({"protocolVersion": initialized["protocolVersion"], "toolsListResultBytes": len(json.dumps(listed, separators=(",", ":"), ensure_ascii=False).encode()),
               "toolsListWireBytes": exchanges[1]["wireBytes"], "exchanges": exchanges, "cliHelp": help_text, "checks": "Three schemas identical across HTTP/OpenAPI/MCP; stdio get and generated CLI get returned ref 1"}, file, indent=2)
print("PASS registry: 3 operations; identical schemas; MCP tools/list+tools/call; generated CLI; OpenAPI HTTP")

#!/usr/bin/env python3
"""Disposable Docker verification. See docs/deploy.md for image builds. Never run against a production Docker daemon."""

import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRATCH = tempfile.TemporaryDirectory(prefix="mainworthy-lockdown-")
WORK = pathlib.Path(SCRATCH.name)
PREFIX = "mainworthy-lockdown-" + uuid.uuid4().hex[:8]
APP_IMAGE = os.environ.get("APP_IMAGE", "mainworthy-lockdown:test")
TOOLS_IMAGE = os.environ.get("TOOLS_IMAGE", "mainworthy-lockdown-tools:test")
# Coolify strips this existing custom property before invoking Compose.
source = (
    (ROOT / "compose.coolify.yaml")
    .read_text()
    .replace("    exclude_from_hc: true\n", "")
)
env = {
    **os.environ,
    "MAINWORTHY_TRUSTED_PROXY": "172.30.231.0/24",
    "MAINWORTHY_CLIENT_ADDRESS_HEADER": "x-mainworthy-client",
}
rendered = subprocess.run(
    [
        "docker",
        "compose",
        "--project-directory",
        str(ROOT),
        "-f",
        "-",
        "config",
        "--format",
        "json",
    ],
    input=source,
    env=env,
    text=True,
    capture_output=True,
    check=True,
)
config = json.loads(rendered.stdout)
app_config = config["services"]["mainworthy"]
assert set(app_config["cap_add"]) == {"NET_ADMIN", "SETUID", "SETGID", "SETPCAP"}
assert app_config["cap_drop"] == ["ALL"] and app_config["user"] == "0:0"
assert app_config["environment"]["MAINWORTHY_LOCKDOWN"] == "1" and not app_config.get(
    "ports"
)
assert config["services"]["tailscale"]["environment"]["TS_USERSPACE"] == "true"
# Start the real Compose service once: this validates interpolation and read-only startup.
compose_path = WORK / "compose.yaml"
compose_path.write_text(source)
compose_args = [
    "docker",
    "compose",
    "--project-directory",
    str(ROOT),
    "-p",
    PREFIX + "-config",
    "-f",
    str(compose_path),
]
try:
    subprocess.run(
        [*compose_args, "up", "-d", "--no-deps", "ingress"],
        env=env,
        check=True,
        capture_output=True,
    )
    inspection = subprocess.run(
        [
            *compose_args,
            "exec",
            "-T",
            "ingress",
            "nginx",
            "-c",
            "/tmp/nginx.conf",
            "-T",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    container_id = subprocess.check_output(
        [*compose_args, "ps", "-q", "ingress"], env=env, text=True
    ).strip()
    deployed = json.loads(
        subprocess.check_output(["docker", "inspect", container_id], text=True)
    )[0]
    security = deployed["HostConfig"]
    assert deployed["Config"]["User"] == "101:101" and security["ReadonlyRootfs"]
    assert security["CapDrop"] == ["ALL"] and security["SecurityOpt"] == [
        "no-new-privileges:true"
    ]
    assert security["Memory"] == 64 * 1024 * 1024 and security["PidsLimit"] == 64
    assert not deployed["Mounts"] and "/tmp" in security["Tmpfs"]
    assert security["PortBindings"]["8080/tcp"] == [
        {"HostIp": "127.0.0.1", "HostPort": "7359"}
    ]
    content = inspection.stdout.split("# configuration file /tmp/nginx.conf:\n", 1)[1]
    (WORK / "ingress.conf").write_text(content)
    print(
        "PASS actual Compose ingress starts read-only and nginx validates its generated config",
        flush=True,
    )
finally:
    subprocess.run(
        [*compose_args, "down", "--volumes"], env=env, check=True, capture_output=True
    )
NGINX = config["services"]["ingress"]["image"]
print(
    "PASS production Compose renders after the Coolify-only property is stripped",
    flush=True,
)
subprocess.run(
    ["docker", "compose", "-f", str(ROOT / "compose.yaml"), "config", "--quiet"],
    check=True,
)
print("PASS ordinary Compose renders", flush=True)
containers, networks = [], []


def cmd(*args, ok=True):
    p = subprocess.run(list(args), check=False, text=True, capture_output=True)
    if ok and p.returncode:
        raise AssertionError(f"{args}: {p.stdout} {p.stderr}")
    return p


def docker(*args, **kwargs):
    return cmd("docker", *args, **kwargs)


def report(msg):
    print("PASS " + msg, flush=True)


def run(name, *args, image=APP_IMAGE, command=()):
    name = PREFIX + "-" + name
    containers.append(name)
    docker("run", "-d", "--name", name, *args, image, *command)
    return name


def state(name):
    return json.loads(docker("inspect", name).stdout)[0]


def wait(name, healthy=False):
    for _ in range(100):
        s = state(name)["State"]
        if not s["Running"]:
            raise AssertionError(
                docker("logs", name).stdout + docker("logs", name).stderr
            )
        if healthy:
            if (
                s.get("Health", {}).get("Status") == "healthy"
                and docker(
                    "exec",
                    name,
                    "/usr/local/bin/mainworthy-entrypoint",
                    "health",
                    ok=False,
                ).returncode
                == 0
            ):
                return
        elif (
            docker(
                "exec", name, "/usr/local/bin/mainworthy-entrypoint", "health", ok=False
            ).returncode
            == 0
        ):
            return
        time.sleep(0.2)
    raise AssertionError("not healthy " + name)


def probe(namespace, code, *, raw=False):
    args = [
        "run",
        "--rm",
        "--network",
        namespace,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
    ]
    args += ["--cap-add", "NET_RAW"] if raw else ["--user", "10001:10001"]
    return docker(*args, TOOLS_IMAGE, "python3", "-c", code, ok=False)


def tcp(namespace, address, port, expected):
    code = f'import socket; s=socket.create_connection(({address!r},{port}),timeout=1); s.sendall(b"GET / HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n"); assert s.recv(4096)'
    p = probe(namespace, code)
    if (p.returncode == 0) != expected and namespace.startswith("container:"):
        print(
            docker("exec", namespace[10:], "nft", "list", "ruleset").stdout, flush=True
        )
        print(
            probe(
                namespace, 'import os; print(os.readlink("/proc/self/ns/net"))'
            ).stdout,
            flush=True,
        )
        print(
            docker("exec", namespace[10:], "readlink", "/proc/self/ns/net").stdout,
            flush=True,
        )
    assert (p.returncode == 0) == expected, (
        address,
        port,
        expected,
        p.stdout,
        p.stderr,
    )


def udp(namespace, address, port, expected, payload=b"round-five"):
    code = f'import socket; s=socket.socket(socket.AF_INET6 if ":" in {address!r} else socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(1); s.sendto({payload!r},({address!r},{port})); assert s.recvfrom(4096)[0]'
    p = probe(namespace, code)
    assert (p.returncode == 0) == expected, (
        address,
        port,
        expected,
        p.stdout,
        p.stderr,
    )


def request(port, target="/healthz", headers=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{target}", headers=headers or {}
    )
    try:
        return urllib.request.urlopen(req, timeout=3)
    except urllib.error.HTTPError as error:
        return error


def raw_request(port, line):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as s:
        s.sendall((line + "\r\nHost: diversion.invalid\r\n\r\n").encode())
        return int(s.recv(2048).split()[1])


FIXTURE = """import http.server,socket,threading
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  import json
  data=json.dumps(dict(self.headers)).encode(); self.send_response(200); self.end_headers(); self.wfile.write(data)
 def log_message(self,*a): pass
class V6(http.server.ThreadingHTTPServer): address_family=socket.AF_INET6
http=http.server.ThreadingHTTPServer(('0.0.0.0',7357),H)
threading.Thread(target=http.serve_forever,daemon=True).start()
v6=V6(('::',7359),H)
threading.Thread(target=v6.serve_forever,daemon=True).start()
def udp(family,addr):
 s=socket.socket(family,socket.SOCK_DGRAM)
 if family==socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
 s.bind((addr,7357))
 while True:
  data,peer=s.recvfrom(65535); s.sendto(data,peer)
threading.Thread(target=udp,args=(socket.AF_INET,'0.0.0.0'),daemon=True).start()
udp(socket.AF_INET6,'::')
"""


class HostHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"fixture")

    def log_message(self, *args):
        pass


host = http.server.ThreadingHTTPServer(("0.0.0.0", 0), HostHandler)
threading.Thread(target=host.serve_forever, daemon=True).start()
try:
    net = PREFIX + "-net"
    networks.append(net)
    docker(
        "network",
        "create",
        "--ipv6",
        "--subnet",
        "172.30.231.0/24",
        "--subnet",
        "fd42:231::/64",
        net,
    )
    echo_net = PREFIX + "-echo"
    networks.append(echo_net)
    docker("network", "create", echo_net)
    fixture = run(
        "fixture",
        "--network",
        net,
        image=TOOLS_IMAGE,
        command=("python3", "-c", FIXTURE),
    )
    time.sleep(0.3)
    assert state(fixture)["State"]["Running"], docker("logs", fixture).stderr
    ips = state(fixture)["NetworkSettings"]["Networks"][net]
    peer4, peer6 = ips["IPAddress"], ips["GlobalIPv6Address"]
    setup = [
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETPCAP",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/data:uid=10001,gid=10001",
        "-e",
        "MAINWORTHY_LOCKDOWN=1",
        "-e",
        "MAINWORTHY_OWNER_TOKEN=synthetic-round-five-token-at-least-32",
        "-e",
        "MAINWORTHY_DEMO=",
        "-e",
        "MAINWORTHY_TRUSTED_PROXY=172.30.231.0/24",
        "-e",
        "MAINWORTHY_CLIENT_ADDRESS_HEADER=x-mainworthy-client",
    ]
    app = run(
        "app",
        "--network",
        net,
        "--network-alias",
        "mainworthy",
        "--health-interval",
        "1s",
        "--health-start-period",
        "1s",
        *setup,
    )
    wait(app, True)
    appns = "container:" + app
    caps = docker("exec", app, "cat", "/proc/1/status").stdout
    for field in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        assert field + ":\t0000000000000000" in caps
    assert "NoNewPrivs:\t1" in caps and "Uid:\t10001\t10001\t10001\t10001" in caps
    print(
        "\n".join(
            line
            for line in caps.splitlines()
            if line.startswith(("Uid:", "Gid:", "Groups:", "Cap", "NoNewPrivs:"))
        ),
        flush=True,
    )
    report("actual Mainworthy PID 1 credentials; app self-check passed before listener")
    deny = docker(
        "exec",
        app,
        "setpriv",
        "--reuid=10001",
        "--regid=10001",
        "--clear-groups",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "nft",
        "add",
        "table",
        "inet",
        "forbidden",
        ok=False,
    )
    assert deny.returncode != 0 and "Operation not permitted" in deny.stderr
    report("nft modification denied with app credentials")
    hard = [
        "--network",
        net,
        "--user",
        "101:101",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:uid=101,gid=101",
        "--memory",
        "64m",
        "--pids-limit",
        "64",
        "--entrypoint",
        "nginx",
        "-v",
        str(WORK / "ingress.conf") + ":/etc/nginx/nginx.conf:ro",
    ]
    ingress = run(
        "ingress",
        *hard,
        "-p",
        "127.0.0.1::8080",
        image=NGINX,
        command=("-g", "daemon off;"),
    )
    port = int(state(ingress)["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostPort"])
    for _ in range(30):
        try:
            assert request(port).status == 200
            break
        except OSError:
            time.sleep(0.1)
    else:
        raise AssertionError("ingress unavailable")
    lan = cmd(
        "sh", "-c", "ip -4 route get 1.1.1.1 | sed -n 's/.* src \\([^ ]*\\).*/\\1/p'"
    ).stdout.strip()
    tcp("host", lan, port, False)
    tcp("host", lan, host.server_port, True)
    docker(
        "exec",
        ingress,
        "wget",
        "-q",
        "-O",
        "/dev/null",
        "http://127.0.0.1:8080/healthz",
    )
    report(
        "ingress loopback and configured health command work; host LAN address fails with reachable LAN control"
    )
    assert (
        state(fixture)["State"]["Running"]
        and state(fixture)["NetworkSettings"]["Networks"][net]["IPAddress"] == peer4
    )
    assert peer4 != state(app)["NetworkSettings"]["Networks"][net]["IPAddress"]
    tcp(appns, peer4, 7357, False)
    report("egress before first restart blocked")
    for i in range(2):
        docker("restart", app)
        wait(app, True)
        assert request(port).status == 200
        caps2 = docker("exec", app, "cat", "/proc/1/status").stdout
        for field in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
            assert field + ":\t0000000000000000" in caps2
        report(
            "restart "
            + str(i + 1)
            + " healthy with zero app capabilities and ingress response"
        )
    for address, p in [
        (peer4, 7357),
        (peer6, 7359),
        ("172.30.231.1", host.server_port),
        (lan, host.server_port),
    ]:
        tcp("host" if p == host.server_port else net, address, p, True)
        tcp(appns, address, p, False)
        report("TCP blocked with positive control " + address)
        assert (
            "counter packets 0 bytes 0 drop\n\t}"
            not in docker(
                "exec", app, "nft", "list", "table", "inet", "mainworthy_lockdown"
            ).stdout
        )
    for address in (peer4, peer6):
        udp(net, address, 7357, True)
        udp(appns, address, 7357, False)
        for namespace, expected in ((net, True), (appns, False)):
            p = probe(
                namespace,
                f'import subprocess; raise SystemExit(subprocess.run(["ping","-c","1","-W","1",{address!r}],capture_output=True).returncode)',
                raw=True,
            )
            assert (p.returncode == 0) == expected, (address, p.stderr)
        report("UDP and ICMP blocked with positive controls " + address)
    for address in (peer4, peer6):
        code = (
            'import sys; sys.argv=["fragments",'
            + repr(address)
            + "];\n"
            + (ROOT / "scripts/container/fragments.py").read_text()
        )
        for namespace, expected in ((net, True), (appns, False)):
            p = probe(namespace, code, raw=True)
            assert (p.returncode == 0) == expected, (address, p.stderr)
        report("fragmented UDP blocked with positive control " + address)
    for family in ("AF_INET", "AF_INET6"):
        code = f"import socket; socket.socket(socket.{family},socket.SOCK_RAW,253)"
        assert probe(net, code, raw=True).returncode == 0
        denied = probe(appns, code)
        assert denied.returncode != 0 and "Operation not permitted" in denied.stderr
    report(
        "unprivileged app credentials cannot create raw sockets for other IP protocols"
    )
    public_net = PREFIX + "-public-fixture"
    networks.append(public_net)
    docker(
        "network",
        "create",
        "--ipv6",
        "--subnet",
        "198.51.100.0/24",
        "--subnet",
        "2001:db8:231::/64",
        public_net,
    )
    docker("network", "connect", public_net, fixture)
    docker("network", "connect", public_net, app)
    public_ips = state(fixture)["NetworkSettings"]["Networks"][public_net]
    for address, target_port in (
        (public_ips["IPAddress"], 7357),
        (public_ips["GlobalIPv6Address"], 7359),
    ):
        tcp(public_net, address, target_port, True)
        tcp(appns, address, target_port, False)
        udp(public_net, address, 7357, True)
        udp(appns, address, 7357, False)
        report(
            "new network attachment: documentation-range TCP/UDP blocked with positive control "
            + address
        )
    dns = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01"
    for address in ("127.0.0.11", "1.1.1.1"):
        udp(net, address, 53, True, dns)
        udp(appns, address, 53, False, dns)
        report("DNS UDP blocked with positive control " + address)
        for namespace, expected in ((net, True), (appns, False)):
            code = f'import socket,struct; s=socket.create_connection(({address!r},53),timeout=1); s.sendall(struct.pack("!H",{len(dns)})+{dns!r})'
            p = probe(namespace, code)
            assert (p.returncode == 0) == expected, (address, p.stderr)
        report("DNS TCP blocked with positive control " + address)
    for namespace, expected in ((net, True), (appns, False)):
        p = probe(
            namespace,
            'import socket; s=socket.create_connection(("1.1.1.1",443),timeout=2)',
        )
        assert (p.returncode == 0) == expected, p.stderr
    report("public IPv4 TCP blocked with positive control")
    tcp(appns, "127.0.0.1", 7357, True)
    report("app loopback health allowed")
    for method in (
        "CONNECT example.com:443 HTTP/1.1",
        "GET http://example.com/ HTTP/1.1",
        "GET https://example.com/ HTTP/1.1",
    ):
        assert raw_request(port, method) in (400, 405)
    report("CONNECT and absolute-form diversion rejected")
    codes = [
        request(
            port,
            "/api/session",
            {
                "Authorization": f"Bearer wrong{i:03d}-not-a-token",
                "CF-Connecting-IP": "198.51.100.42",
                "X-Mainworthy-Client": f"203.0.113.{i}",
                "X-Forwarded-Proto": "http",
            },
        ).status
        for i in range(8)
    ]
    assert codes[:5] == [401] * 5 and codes[5:] == [429] * 3, codes
    for i in range(2):
        assert (
            request(
                port,
                "/api/session",
                {
                    "Authorization": f"Bearer other{i:03d}-not-a-token",
                    "CF-Connecting-IP": "203.0.113.42",
                },
            ).status
            == 401
        )
    report(
        "actual app uses normalized dedicated client header for per-client sign-in limits"
    )
    # Same exact proxy config, isolated upstream alias points to echo fixture.
    echo = run(
        "echo",
        "--network",
        echo_net,
        "--network-alias",
        "mainworthy",
        image=TOOLS_IMAGE,
        command=("python3", "-c", FIXTURE),
    )
    echo_hard = hard.copy()
    echo_hard[1] = echo_net
    proxy = run(
        "echo-proxy",
        *echo_hard,
        "-p",
        "127.0.0.1::8080",
        image=NGINX,
        command=("-g", "daemon off;"),
    )
    ep = int(state(proxy)["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostPort"])
    for _ in range(30):
        try:
            headers = json.load(
                request(
                    ep,
                    "/",
                    {
                        "CF-Connecting-IP": "198.51.100.42",
                        "X-Mainworthy-Client": "203.0.113.99",
                        "X-Forwarded-Proto": "http",
                    },
                )
            )
            break
        except OSError:
            time.sleep(0.1)
    assert (
        headers["X-Mainworthy-Client"] == "198.51.100.42"
        and headers["X-Forwarded-Proto"] == "https"
    ), headers
    missing = json.load(request(ep, "/", {"X-Mainworthy-Client": "203.0.113.99"}))
    assert "X-Mainworthy-Client" not in missing
    report(
        "proxy overwrites incoming dedicated address and scheme; missing CF removes spoofed header"
    )
    # Direct internal request covers the Tailscale sidecar's upstream hop without a real tailnet identity.
    tcp(net, state(app)["NetworkSettings"]["Networks"][net]["IPAddress"], 7357, True)
    report("direct internal sidecar hop reaches app")
    for label, extra in [
        ("invalid-mode", ["-e", "MAINWORTHY_LOCKDOWN=bad"]),
        (
            "invalid-policy",
            [
                "-v",
                str(WORK / "invalid.nft")
                + ":/usr/local/share/mainworthy/lockdown.nft:ro",
            ],
        ),
        ("missing-netadmin", []),
    ]:
        (WORK / "invalid.nft").write_text("this is not valid nft syntax\n")
        bad_setup = setup.copy()
        if label == "missing-netadmin":
            index = bad_setup.index("NET_ADMIN")
            del bad_setup[index - 1 : index + 1]
        broken = run(label, "--network", net, *bad_setup, *extra)
        for _ in range(50):
            s = state(broken)["State"]
            if not s["Running"]:
                break
            time.sleep(0.1)
        assert not s["Running"] and s["ExitCode"] != 0, (label, s)
        report(label + " startup fails closed before app")
    default = run(
        "ordinary",
        "--network",
        net,
        "--tmpfs",
        "/data:uid=10001,gid=10001",
        "-e",
        "MAINWORTHY_OWNER_TOKEN=synthetic-round-five-token-at-least-32",
    )
    wait(default)
    tcp("container:" + default, peer4, 7357, True)
    report("ordinary image remains nonroot, healthy and outbound-capable")
    started = time.monotonic()
    docker("stop", "--time", "10", app)
    s = state(app)["State"]
    assert s["ExitCode"] == 0 and time.monotonic() - started < 10, s
    report("SIGTERM reaches Mainworthy PID 1 and exits 0 before timeout")
    docker("stop", "--time", "10", ingress)
    assert state(ingress)["State"]["ExitCode"] == 0
    report("ingress exits 0 on SIGTERM")
finally:
    host.shutdown()
    host.server_close()
    for name in reversed(containers):
        docker("rm", "-fv", name, ok=False)
    for name in reversed(networks):
        docker("network", "rm", name, ok=False)
    SCRATCH.cleanup()

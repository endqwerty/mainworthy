import socket
import struct
import sys

address = sys.argv[1]
v6 = ":" in address
family = socket.AF_INET6 if v6 else socket.AF_INET
receiver = socket.socket(family, socket.SOCK_DGRAM)
receiver.connect((address, 7357))
source, port = receiver.getsockname()[:2]
receiver.settimeout(1)
raw = socket.socket(family, socket.SOCK_RAW, socket.IPPROTO_RAW)
if not v6:
    raw.setsockopt(socket.IPPROTO_IP, socket.IP_HDRINCL, 1)


def checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    total = (total >> 16) + (total & 65535)
    total += total >> 16
    return ~total & 65535


payload = b"fragment-probe-round-five-abcdef"
src = socket.inet_pton(family, source)
dst = socket.inet_pton(family, address)
udp = struct.pack("!HHHH", port, 7357, 8 + len(payload), 0) + payload
if v6:
    check = checksum(src + dst + struct.pack("!I3xB", len(udp), 17) + udp) or 65535
    udp = udp[:6] + struct.pack("!H", check) + udp[8:]
for offset, part, more in [(0, udp[:16], 1), (16, udp[16:], 0)]:
    if v6:
        frag = struct.pack("!BBHI", 17, 0, (offset // 8) << 3 | more, 56789)
        header = (
            struct.pack("!IHBB16s16s", 6 << 28, len(frag) + len(part), 44, 64, src, dst)
            + frag
        )
    else:
        header = struct.pack(
            "!BBHHHBBH4s4s",
            0x45,
            0,
            20 + len(part),
            56789,
            (more << 13) | (offset // 8),
            64,
            17,
            0,
            src,
            dst,
        )
        header = header[:10] + struct.pack("!H", checksum(header)) + header[12:]
    raw.sendto(header + part, (address, 0))
assert receiver.recv(4096) == payload

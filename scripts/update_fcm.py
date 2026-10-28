"""Build the Worker's mtalk.google.com records from published upstream hosts."""

import ipaddress
import json
import os
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen


SOURCE = "https://fcm-hosts.cagedbird.cn/fcm_dual.hosts"
TARGET = "mtalk.google.com"
OUTPUT = Path(__file__).resolve().parents[1] / "worker/src/fcm-data.js"
MAX_SOURCE_BYTES = 2 * 1024 * 1024


def parse_hosts(content):
    records = {"A": [], "AAAA": []}
    for line in content.splitlines():
        fields = line.split("#", 1)[0].split()
        if len(fields) < 2:
            continue
        domains = {item.rstrip(".").lower() for item in fields[1:]}
        if TARGET not in domains:
            continue
        try:
            address = ipaddress.ip_address(fields[0])
        except ValueError:
            continue
        if not address.is_global:
            continue
        record_type = "A" if address.version == 4 else "AAAA"
        value = str(address)
        if value not in records[record_type]:
            records[record_type].append(value)
    if not records["A"] and not records["AAAA"]:
        raise ValueError("No valid mtalk.google.com records; keeping existing data.")
    return {TARGET: records}


def write_data(data, output=OUTPUT):
    content = "export default " + json.dumps(data, separators=(",", ":")) + ";\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=output.parent,
            prefix=".fcm-data-", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    request = Request(SOURCE, headers={"User-Agent": "fcm-static-doh/1.0"})
    with urlopen(request, timeout=30) as response:
        content = response.read(MAX_SOURCE_BYTES + 1)
    if len(content) > MAX_SOURCE_BYTES:
        raise ValueError("Upstream hosts file is too large; keeping existing data.")
    data = parse_hosts(content.decode("utf-8-sig"))
    write_data(data)
    records = data[TARGET]
    print(f"Updated {TARGET}: A={len(records['A'])}, AAAA={len(records['AAAA'])}")


if __name__ == "__main__":
    main()

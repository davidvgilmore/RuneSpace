#!/usr/bin/env python3
"""Install or verify an isolated LiveKit relay on a tailnet-enrolled Debian 12 VM."""
import argparse
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

VERSION = '1.13.11'
ARCHIVE_SHA = '1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb'
BINARY_SHA = '85a58024d9b36542712514e0e926c0adb74f6182bcb19a664b9d9eb98ad01b52'
RELEASE = f'https://github.com/livekit/livekit/releases/download/v{VERSION}/livekit_{VERSION}_linux_amd64.tar.gz'
BINARY = Path('/usr/local/lib/runespace-media') / VERSION / 'livekit-server'
CONFIG = Path('/etc/runespace-media/livekit.yaml')
UNIT = Path('/etc/systemd/system/runespace-media.service')
PROXY = 'http://127.0.0.1:7880'
SIGNAL = '8466'
PORTS = {('tcp', '7880'), ('udp', '7882')}
UNIT_HEADER = '# Managed by RuneSpace install-media.py'


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def unit_contents():
    return f'''{UNIT_HEADER}
[Unit]
Description=RuneSpace LiveKit media server
After=network-online.target tailscaled.service
Wants=network-online.target
Requires=tailscaled.service

[Service]
DynamicUser=yes
LoadCredential=livekit.yaml:{CONFIG}
ExecStart={BINARY} --config %d/livekit.yaml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
'''


def read_keys(source):
    if source == '-':
        if sys.stdin.isatty():
            raise ValueError('Pipe the credential JSON through stdin, or specify a private file.')
        raw = sys.stdin.buffer.read(16385)
    else:
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise ValueError('Use a regular credentials file readable only by its owner (0600).')
            raw = f.read(16385)
    if len(raw) > 16384:
        raise ValueError('The credential JSON exceeds 16 KiB.')
    keys = json.loads(raw)
    if (not isinstance(keys, dict) or set(keys) != {'key', 'secret'}
            or not isinstance(keys['key'], str) or not keys['key']
            or not isinstance(keys['secret'], str) or len(keys['secret']) < 32):
        raise ValueError('Supply exactly the LiveKit key and secret. The secret must be at least 32 characters.')
    return keys


def livekit_config(ip, keys):
    # JSON is valid YAML. Quoting also keeps arbitrary key material out of YAML syntax.
    return json.dumps({
        'port': 7880, 'bind_addresses': ['127.0.0.1'],
        'rtc': {'tcp_port': 0, 'udp_port': 7882, 'node_ip': ip, 'use_external_ip': False,
                'ips': {'includes': [ip + '/32']}},
        'keys': {keys['key']: keys['secret']}, 'logging': {'level': 'warn'},
    }, indent=2) + '\n'


def tailnet():
    status = json.loads(output('tailscale', 'status', '--json'))
    node = status.get('Self') or {}
    ips = [ip for ip in node.get('TailscaleIPs', []) if ipaddress.ip_address(ip).version == 4]
    host = node.get('DNSName', '').rstrip('.')
    if status.get('BackendState') != 'Running' or not host or not ips:
        raise ValueError('Enroll this VM with tailscale up and enable MagicDNS before installing.')
    return host, ips[0]


def route_exists(routes, host):
    endpoint = host + ':' + SIGNAL
    if any(key.endswith(':' + SIGNAL) and enabled for key, enabled in (routes.get('AllowFunnel') or {}).items()):
        raise ValueError('Funnel is enabled on the media port. Use a private tailnet listener.')
    if any(SIGNAL in (fg.get('TCP') or {}) for fg in (routes.get('Foreground') or {}).values()):
        raise ValueError('The media port is in use by a foreground Tailscale Serve command.')
    listeners = routes.get('TCP') or {}
    web = {key: value for key, value in (routes.get('Web') or {}).items() if key.endswith(':' + SIGNAL)}
    if SIGNAL not in listeners and not web:
        return False
    if (listeners.get(SIGNAL) == {'HTTPS': True} and set(web) == {endpoint} and
            web[endpoint].get('Handlers') == {'/': {'Proxy': PROXY}}):
        return True
    raise ValueError('Tailscale port 8466 already belongs to a different handler. Existing routes were preserved.')


def routes(host):
    return route_exists(json.loads(output('tailscale', 'serve', 'status', '--json')) or {}, host)


def pid():
    proc = subprocess.run(['systemctl', 'show', UNIT.name, '--property=MainPID', '--value'],
                          capture_output=True, text=True)
    number = proc.stdout.strip()
    return number if proc.returncode == 0 and number.isdigit() and int(number) > 0 else None


def sockets(ip, verify):
    expected = {('tcp', '127.0.0.1:7880'), ('udp', ip + ':7882')}
    owned = set()
    owner = pid()
    for line in output('ss', '-H', '-lnutp').splitlines():
        fields = line.split()
        proto, address = fields[0], fields[4]
        if owner and ('pid=' + owner + ',') in line:
            owned.add((proto, address))
        elif (proto, address.rsplit(':', 1)[-1]) in PORTS:
            raise ValueError('A different process owns media port ' + address + '.')
    if verify and owned != expected:
        raise ValueError('LiveKit must listen only on 127.0.0.1 TCP 7880 and the tailnet IPv4 UDP 7882.')


def put(path, data, mode):
    if path.is_file() and path.read_bytes() == data:
        os.chmod(path, mode)
        return False
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        temp = Path(f.name)
    try:
        temp.write_bytes(data)
        temp.chmod(mode)
        os.replace(temp, path)
        return True
    finally:
        temp.unlink(missing_ok=True)


def checksum(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def install_binary(archive):
    if BINARY.exists() and checksum(BINARY) == BINARY_SHA:
        return False
    with tempfile.TemporaryDirectory() as tmp:
        if archive is None:
            archive = Path(tmp) / 'release.tar.gz'
            with urlopen(RELEASE, timeout=30) as response, archive.open('wb') as f:
                shutil.copyfileobj(response, f)
        if checksum(archive) != ARCHIVE_SHA:
            raise ValueError('The release archive SHA-256 does not match the pinned LiveKit release.')
        with tarfile.open(archive, 'r:gz') as tar:
            entry = tar.getmember('livekit-server')
            if not entry.isfile():
                raise ValueError('Expected a regular livekit-server binary in the release.')
            with tar.extractfile(entry) as source:
                data = source.read()
        if hashlib.sha256(data).hexdigest() != BINARY_SHA:
            raise ValueError('The LiveKit executable SHA-256 did not match.')
        BINARY.parent.mkdir(parents=True, exist_ok=True)
        return put(BINARY, data, 0o755)


def health(url, seconds):
    deadline = time.monotonic() + seconds
    while True:
        try:
            with urlopen(url, timeout=3) as response:
                if response.status == 200 and response.read(64).strip() == b'OK':
                    return
        except (URLError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise ValueError('LiveKit did not become ready at ' + url)
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--credentials', metavar='PATH|-', help='Owner-only file or stdin containing key and secret JSON')
    group.add_argument('--check', action='store_true', help='Verify service, private route and socket ownership')
    parser.add_argument('--archive', type=Path, help='Use a predownloaded, pinned Linux amd64 release archive')
    args = parser.parse_args()
    osinfo = platform.freedesktop_os_release()
    if os.geteuid() or osinfo.get('ID') != 'debian' or osinfo.get('VERSION_ID') != '12' or platform.machine() != 'x86_64':
        raise ValueError('Run as root on a Debian 12 x86_64 systemd VM.')
    if not Path('/run/systemd/system').is_dir():
        raise ValueError('A running systemd system manager is required.')
    host, ip = tailnet()
    with contextlib.ExitStack() as stack:
        if not args.check:
            lock = stack.enter_context(open('/run/lock/runespace-media-install.lock', 'a'))
            fcntl.flock(lock, fcntl.LOCK_EX)
        configured = routes(host)
        if not args.check:
            if UNIT.exists() and not UNIT.read_text().startswith(UNIT_HEADER + '\n'):
                raise ValueError('Refusing to overwrite an existing unmanaged systemd unit.')
            sockets(ip, False)
            keys = read_keys(args.credentials)
            changed_binary = install_binary(args.archive)
            CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(CONFIG.parent, 0o700)
            changed_config = put(CONFIG, livekit_config(ip, keys).encode(), 0o600)
            changed_unit = put(UNIT, unit_contents().encode(), 0o644)
            if changed_unit:
                subprocess.run(['systemctl', 'daemon-reload'], check=True)
            subprocess.run(['systemctl', 'enable', UNIT.name], check=True)
            action = 'restart' if changed_config or changed_binary or changed_unit else 'start'
            subprocess.run(['systemctl', action, UNIT.name], check=True)
            health(PROXY, 30)
            sockets(ip, True)
            if not routes(host):
                subprocess.run(['tailscale', 'serve', '--bg', '--https=' + SIGNAL, PROXY], check=True)
            configured = routes(host)
        if not configured:
            raise ValueError('The expected private signaling route is missing.')
        subprocess.run(['systemctl', 'is-active', '--quiet', UNIT.name], check=True)
        sockets(ip, True)
        health(PROXY, 5)
        health('https://' + host + ':' + SIGNAL, 45)
        print('LiveKit ready at wss://' + host + ':' + SIGNAL + ' with ICE/UDP on ' + ip + ':7882.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(str(error))

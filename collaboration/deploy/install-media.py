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
import socket
import ssl
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
TURN = '443'
TURN_LISTENER = 5349
RELAY_MIN, RELAY_MAX = 40000, 40999
PORTS = {('tcp', '7880'), ('udp', '7882'), ('tcp', str(TURN_LISTENER))}
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


def livekit_config(host, ip, keys):
    # JSON is valid YAML. Quoting also keeps arbitrary key material out of YAML syntax.
    return json.dumps({
        'port': 7880, 'bind_addresses': ['127.0.0.1'],
        'rtc': {'tcp_port': 0, 'udp_port': 7882, 'node_ip': ip, 'use_external_ip': False,
                'ips': {'includes': [ip + '/32']}},
        'turn': {'enabled': True, 'domain': host, 'tls_port': TURN_LISTENER,
                 'external_tls': True, 'bind_addresses': [ip],
                 'proxy_protocol': True, 'proxy_protocol_trusted_cidrs': [ip + '/32'],
                 'relay_range_start': RELAY_MIN, 'relay_range_end': RELAY_MAX,
                 'allow_restricted_peer_cidrs': [ip + '/32']},
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


def route_exists(config, host, ip, port):
    endpoint = host + ':' + port
    if any(key.endswith(':' + port) and enabled for key, enabled in (config.get('AllowFunnel') or {}).items()):
        raise ValueError(f'Funnel is enabled on port {port}. Use a private tailnet listener.')
    for foreground in (config.get('Foreground') or {}).values():
        if port in (foreground.get('TCP') or {}) or any(key.endswith(':' + port) for key in (foreground.get('Web') or {})):
            raise ValueError(f'Tailscale port {port} belongs to a foreground Serve command.')
    listeners = config.get('TCP') or {}
    web = {key: value for key, value in (config.get('Web') or {}).items() if key.endswith(':' + port)}
    if port not in listeners and not web:
        return False
    if port == SIGNAL:
        if (listeners.get(port) == {'HTTPS': True} and set(web) == {endpoint} and
                web[endpoint].get('Handlers') == {'/': {'Proxy': PROXY}}):
            return True
    elif not web and listeners.get(port) == {'TCPForward': f'{ip}:{TURN_LISTENER}', 'TerminateTLS': host, 'ProxyProtocol': 2}:
        return True
    raise ValueError(f'Tailscale port {port} already belongs to a different handler. Existing routes were preserved.')


def routes(host, ip):
    config = json.loads(output('tailscale', 'serve', 'status', '--json')) or {}
    return {port: route_exists(config, host, ip, port) for port in (SIGNAL, TURN)}


def configure_routes(host, ip):
    # Check both ports before creating either route. Never replace an existing service or Funnel.
    existing = routes(host, ip)
    if not existing[SIGNAL]:
        subprocess.run(['tailscale', 'serve', '--bg', '--yes', '--https=' + SIGNAL, PROXY], check=True)
    if not existing[TURN]:
        subprocess.run(['tailscale', 'serve', '--bg', '--yes', '--proxy-protocol=2', '--tls-terminated-tcp=' + TURN,
                        f'tcp://{ip}:{TURN_LISTENER}'], check=True)


def pid():
    proc = subprocess.run(['systemctl', 'show', UNIT.name, '--property=MainPID', '--value'],
                          capture_output=True, text=True)
    number = proc.stdout.strip()
    return number if proc.returncode == 0 and number.isdigit() and int(number) > 0 else None


def sockets(ip, verify):
    expected = {('tcp', '127.0.0.1:7880'), ('udp', ip + ':7882'), ('tcp', f'{ip}:{TURN_LISTENER}')}
    owned = set()
    owner = pid()
    for line in output('ss', '-H', '-lnutp').splitlines():
        fields = line.split()
        proto, address = fields[0], fields[4]
        if owner and ('pid=' + owner + ',') in line:
            # Each active TURN allocation opens a UDP socket on the same tailnet IP.
            bound_ip, _, bound_port = address.rpartition(':')
            if proto == 'udp' and bound_ip == ip and bound_port.isdigit() and RELAY_MIN <= int(bound_port) <= RELAY_MAX:
                continue
            owned.add((proto, address))
        elif (proto, address.rsplit(':', 1)[-1]) in PORTS:
            raise ValueError('A different process owns media port ' + address + '.')
    if verify and owned != expected:
        raise ValueError('Unexpected LiveKit listeners. Check the loopback signaling, tailnet media, and TURN relay ports.')


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


def check_turn_tls(host, seconds=45):
    deadline = time.monotonic() + seconds
    context = ssl.create_default_context()
    while True:
        try:
            with socket.create_connection((host, int(TURN)), timeout=3) as raw:
                with context.wrap_socket(raw, server_hostname=host):
                    return
        except OSError as exc:
            if time.monotonic() >= deadline:
                raise ValueError('Private TURN TLS did not become ready at ' + host + ':' + TURN) from exc
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
        configured = routes(host, ip)
        if not args.check:
            if UNIT.exists() and not UNIT.read_text().startswith(UNIT_HEADER + '\n'):
                raise ValueError('Refusing to overwrite an existing unmanaged systemd unit.')
            sockets(ip, False)
            keys = read_keys(args.credentials)
            changed_binary = install_binary(args.archive)
            CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(CONFIG.parent, 0o700)
            # Prepare both private endpoints while an existing SFU keeps serving calls.
            configure_routes(host, ip)
            changed_config = put(CONFIG, livekit_config(host, ip, keys).encode(), 0o600)
            changed_unit = put(UNIT, unit_contents().encode(), 0o644)
            if changed_unit:
                subprocess.run(['systemctl', 'daemon-reload'], check=True)
            subprocess.run(['systemctl', 'enable', UNIT.name], check=True)
            action = 'restart' if changed_config or changed_binary or changed_unit else 'start'
            subprocess.run(['systemctl', action, UNIT.name], check=True)
            health(PROXY, 30)
            sockets(ip, True)
            configured = routes(host, ip)
        if not all(configured.values()):
            raise ValueError('A private signaling or TURN/TLS route is missing.')
        subprocess.run(['systemctl', 'is-active', '--quiet', UNIT.name], check=True)
        sockets(ip, True)
        health(PROXY, 5)
        health('https://' + host + ':' + SIGNAL, 45)
        check_turn_tls(host)
        print(f'LiveKit ready at wss://{host}:{SIGNAL} with direct UDP {ip}:7882 and private TURN/TLS {host}:{TURN}.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(str(error))

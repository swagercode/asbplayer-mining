#!/usr/bin/env python3
"""Native-messaging transport; the job queue outlives this browser connection."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
MAX_MESSAGE = 256 * 1024


def request(message):
    for attempt in range(30):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(ROOT / 'bridge.sock'))
                client.sendall(json.dumps(message).encode() + b'\n')
                return json.loads(client.makefile('rb').readline(MAX_MESSAGE))
        except (ConnectionRefusedError, FileNotFoundError):
            if attempt == 0:
                with (ROOT / 'service.log').open('ab') as log:
                    subprocess.Popen([sys.executable, str(ROOT / 'service.py')], stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
            time.sleep(0.1)
    raise ValueError('The local mining queue could not start. Check service.log.')


def main():
    os.umask(0o077)
    while True:
        header = sys.stdin.buffer.read(4)
        if len(header) != 4:
            return
        size = struct.unpack('<I', header)[0]
        if size > MAX_MESSAGE:
            return
        message = {}
        try:
            message = json.loads(sys.stdin.buffer.read(size))
            result = request(message)
        except Exception as error:
            result = {'error': str(error)}
        result['requestId'] = message.get('requestId')
        encoded = json.dumps(result).encode()
        sys.stdout.buffer.write(struct.pack('<I', len(encoded)) + encoded)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()

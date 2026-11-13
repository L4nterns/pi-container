"""Run inside the service container against its real Nginx gateway."""
import base64
import hashlib
import http.client
import json
import socket
import time

connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=3)
connection.request('GET', '/headers', headers={
    'Host': 'app-demo.example.com',
    'X-Real-IP': '192.0.2.1',
    'X-Forwarded-For': '192.0.2.1',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'app-demo.example.com',
    'X-Forwarded-Port': '443',
})
response = connection.getresponse()
assert response.status == 200
headers = json.loads(response.read())
assert headers['Host'] == 'app-demo.example.com'
assert headers['X-Forwarded-For'] == '192.0.2.1'
assert headers['X-Forwarded-Proto'] == 'https'
assert headers['X-Forwarded-Host'] == 'app-demo.example.com'
assert headers['X-Forwarded-Port'] == '443'
connection.close()

connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=3)
start = time.monotonic()
connection.request('GET', '/events', headers={'Host': 'app-demo.example.com'})
response = connection.getresponse()
assert response.status == 200
assert response.getheader('Content-Type') == 'text/event-stream'
assert response.readline() == b'data: first\n'
assert time.monotonic() - start < 1, 'SSE first event was buffered until the response ended'
assert response.readline() == b'\n'
assert response.readline() == b'data: second\n'
assert time.monotonic() - start < 3
connection.close()

key = base64.b64encode(b'0123456789abcdef').decode()
expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
with socket.create_connection(('127.0.0.1', 8080), timeout=3) as sock:
    sock.sendall((f'GET /ws HTTP/1.1\r\nHost: app-demo.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
    reader = sock.makefile('rb')
    assert b'101' in reader.readline()
    lines = []
    while (line := reader.readline()) != b'\r\n':
        assert line, 'Unexpected EOF during handshake'
        lines.append(line)
    assert expected in b''.join(lines)
    assert reader.read(4) == b'\x81\x02ok'
# Only explicitly configured hosts may select the application route.
for host in ('app-missing.example.com', 'app-demo.unconfigured.example.com', 'app-demo.invalid'):
    connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=3)
    connection.request('GET', '/', headers={'Host': host})
    response = connection.getresponse()
    assert response.status == 404, f'Unconfigured host was routed: {host}'
    response.read()
    connection.close()
print('Exact host routes, forwarded headers, unbuffered SSE and WebSocket upgrade passed')

#!/usr/bin/env python3
"""Owned loopback HTTP proxy; route changes keep one browser origin."""

import http.client
import http.server
import json
import select
import socket
import sys
from pathlib import Path

HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}


def serve(root):
    environment = json.loads((root / "resolved-environment.json").read_text())

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        # Preserve frames sent in the same packet as the Upgrade headers.
        rbufsize = 0

        def forward_websocket(self):
            self.close_connection = True
            path = self.path.split("?")[0]
            if (self.command != "GET" or path == "/api" or path.startswith("/api/") or
                    self.headers.get("Upgrade", "").lower() != "websocket" or
                    "upgrade" not in {token.strip().lower() for token in self.headers.get("Connection", "").split(",")}):
                self.send_error(400, "Only frontend WebSockets are supported")
                return
            upstream = None
            response_started = False
            try:
                upstream = socket.create_connection(("127.0.0.1", environment["front_port"]), timeout=10)
                request = self.requestline + "\r\n"
                request += "".join(f"{key}: {value}\r\n" for key, value in self.headers.items())
                upstream.sendall((request + "\r\n").encode("latin-1"))
                handshake = bytearray()
                while b"\r\n\r\n" not in handshake:
                    chunk = upstream.recv(8192)
                    if not chunk or len(handshake) + len(chunk) > 64 * 1024:
                        raise http.client.HTTPException("Invalid frontend WebSocket handshake")
                    handshake.extend(chunk)
                self.connection.sendall(handshake)
                response_started = True
                upstream.settimeout(None)
                peers = {self.connection: upstream, upstream: self.connection}
                while peers:
                    readable, _, _ = select.select(list(peers), [], [], 120)
                    if not readable:
                        continue
                    for source in readable:
                        destination = peers[source]
                        chunk = source.recv(64 * 1024)
                        if chunk:
                            destination.sendall(chunk)
                        else:
                            destination.shutdown(socket.SHUT_WR)
                            del peers[source]
            except (OSError, http.client.HTTPException, ValueError):
                if not response_started:
                    self.send_error(502, "Owned frontend WebSocket is unavailable")
            finally:
                if upstream:
                    upstream.close()

        def forward(self):
            response_started = False
            upstream = None
            if self.headers.get("Upgrade"):
                self.forward_websocket()
                return
            route = json.loads((root / "route.json").read_text())
            if self.path.startswith(("/api/", "/api-public/")):
                api = route["api"]
                if self.path.split("?")[0].endswith("/preview/media"):
                    preflight = self.command == "HEAD" or self.headers.get("Range") == "bytes=0-0"
                    api = route["media_preflight" if preflight else "media_stream"]
                port = environment[f"api_{api}_port"]
            else:
                port = environment["front_port"]
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 4 * 1024 * 1024 or self.headers.get("Transfer-Encoding"):
                    self.send_error(413, "Use bounded TUS chunks in this test environment")
                    return
                body = bytearray()
                while len(body) < length:
                    chunk = self.rfile.read(length - len(body))
                    if not chunk:
                        raise http.client.HTTPException("Incomplete bounded request body")
                    body.extend(chunk)
                headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_HEADERS}
                headers["Connection"] = "close"
                upstream = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
                upstream.request(self.command, self.path, body, headers)
                response = upstream.getresponse()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in HOP_HEADERS:
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                response_started = True
                if self.command != "HEAD":
                    while chunk := response.read(64 * 1024):
                        self.wfile.write(chunk)
                self.close_connection = True
            except (OSError, http.client.HTTPException, ValueError):
                self.close_connection = True
                if not response_started:
                    self.send_error(502, "Owned test upstream is unavailable")
            finally:
                if upstream:
                    upstream.close()

        do_GET = forward
        do_HEAD = forward
        do_POST = forward
        do_PATCH = forward
        do_DELETE = forward
        do_OPTIONS = forward

    http.server.ThreadingHTTPServer(("127.0.0.1", environment["proxy_port"]), Handler).serve_forever()


if __name__ == "__main__":
    serve(Path(sys.argv[1]))

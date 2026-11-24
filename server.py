import http.server
import json
import os
import socket
import socketserver
import threading
import time
import urllib.parse

from scraper import TR_TZ, collect_pharmacy_data

PORT = int(os.environ.get("PORT", "5050"))
CACHE_TTL_SECONDS = 600  # 10 dakika bellek onbellegi

_cache_lock = threading.Lock()
_cached_payload = None
_cached_at = 0.0


def _load_disk_fallback():
    data_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
    if os.path.exists(data_path):
        try:
            with open(data_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def get_pharmacies_payload(force_refresh: bool = False) -> dict:
    global _cached_payload, _cached_at
    now = time.time()

    with _cache_lock:
        if not force_refresh and _cached_payload and (now - _cached_at) < CACHE_TTL_SECONDS:
            return _cached_payload

    fresh = collect_pharmacy_data(days_ahead=3)
    if fresh and fresh.get("pharmacies"):
        with _cache_lock:
            _cached_payload = fresh
            _cached_at = now
        # Diskteki data.json'i da guncel tut
        try:
            data_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
            with open(data_path, "w", encoding="utf-8") as f:
                json.dump(fresh, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return fresh

    with _cache_lock:
        if _cached_payload:
            return _cached_payload

    disk = _load_disk_fallback()
    if disk and disk.get("pharmacies"):
        return disk

    raise RuntimeError("Eczaci Odasi verisine ulasilamadi ve yedek veri bulunamadi.")


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class PharmacyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/pharmacies":
            qs = urllib.parse.parse_qs(parsed.query)
            force = "force" in qs or "_ts" in qs
            try:
                payload = get_pharmacies_payload(force_refresh=force)
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                err_body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_body)
        else:
            super().do_GET()


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with ThreadingHTTPServer(("", PORT), PharmacyHandler) as httpd:
        ip = get_local_ip()
        print("=====================================================")
        print(" Polen Eczanesi Nobetci Eczane Sistemi Calisiyor!")
        print(f" Yerel Adres : http://localhost:{PORT}")
        print(f" Ag Adresi   : http://{ip}:{PORT}")
        print(f" Mobil Gorunum: http://{ip}:{PORT}/?mobil=1")
        print("=====================================================")
        httpd.serve_forever()

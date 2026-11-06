"""Servidor local do Planejamento de Rotas (sem cache, para sempre carregar a versão atual)."""
import http.server, os, sys

class SemCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

os.chdir(os.path.dirname(os.path.abspath(__file__)))
porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f'Planejamento de Rotas em http://localhost:{porta}  (feche esta janela para encerrar)')
http.server.ThreadingHTTPServer(('127.0.0.1', porta), SemCache).serve_forever()

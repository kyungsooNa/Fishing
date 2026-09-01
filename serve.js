// docs/ 를 그대로 띄우는 최소 정적 서버. 의존성 없음.
// GitHub Pages 대신 서버에서 직접 볼 때 쓴다.
//   PORT=8080 node serve.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('./docs/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      // 데이터는 매번 새로 읽어야 한다
      'Cache-Control': extname(file) === '.json' ? 'no-store' : 'public, max-age=300',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`http://0.0.0.0:${PORT} 에서 서비스 중`));

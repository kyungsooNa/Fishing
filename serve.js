// docs/ 를 그대로 띄우는 최소 정적 서버. 의존성 없음.
// GitHub Pages 대신 서버에서 직접 볼 때 쓴다.
//   PORT=8080 node serve.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// .pathname 을 쓰면 Windows에서 '/C:/Users/...' 가 나와 아래 경로 검사가 전부 막힌다.
const ROOT = fileURLToPath(new URL('./docs/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  let file;
  try {
    // '/%' 같은 잘못된 인코딩에 decodeURIComponent가 던진다.
    // 이 줄이 try 밖에 있으면 요청 하나로 프로세스가 통째로 죽는다.
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '');
    file = join(ROOT, rel);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

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

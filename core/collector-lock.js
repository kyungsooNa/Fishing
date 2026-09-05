// 별도 CLI 수집과 로컬 감시 서버가 같은 플랫폼을 동시에 긁지 않게 합니다.
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';

export async function acquireCollectorLock(path = 'tmp/collector.lock') {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(String(process.pid));
      await file.close();
      const cleanup = () => {
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
        } catch { /* 이미 정리된 잠금 */ }
      };
      process.once('exit', cleanup);
      return async () => {
        process.removeListener('exit', cleanup);
        if (await readFile(path, 'utf8').catch(() => '') === String(process.pid)) {
          await unlink(path).catch(() => {});
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (e) { if (e.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('수집기 또는 감시 서버가 이미 실행 중입니다. 관리 화면의 수집 다시 실행을 사용하세요.');
      await unlink(path).catch(() => {});
    }
  }
  throw new Error('수집 잠금을 얻지 못했습니다');
}

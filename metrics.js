#!/usr/bin/env node
// registry와 수집 결과를 플랫폼별로 요약합니다.
//
//   node metrics.js
//   node metrics.js --from tmp/data.json
//   node metrics.js --registry tmp/registry.json --from tmp/data.json

import { collectMetrics, formatMetrics } from './core/metrics.js';
import { load, DATA_PATH } from './core/store.js';
import { loadRegistry, REGISTRY_PATH } from './core/runner.js';

const valueOf = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
};

const dataPath = valueOf('--from') ?? DATA_PATH;
const registryPath = valueOf('--registry') ?? REGISTRY_PATH;
const [registry, data] = await Promise.all([loadRegistry(registryPath), load(dataPath)]);

console.log(formatMetrics(collectMetrics(registry, data)));

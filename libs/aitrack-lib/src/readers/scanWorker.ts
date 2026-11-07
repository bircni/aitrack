import { parentPort } from 'node:worker_threads';

import { answerScan, type ScanRequest } from './scanPool.js';

parentPort?.on('message', (request: ScanRequest) => {
  void answerScan(request).then((reply) => parentPort?.postMessage(reply));
});

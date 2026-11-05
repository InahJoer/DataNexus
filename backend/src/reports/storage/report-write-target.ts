import { PassThrough, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ReportWriteTarget {
  writable: PassThrough;
  completed: Promise<number>;
}

export function createReportWriteTarget(
  destination: Writable,
  cleanupOnFailure?: () => Promise<void> | void,
): ReportWriteTarget {
  let bytesWritten = 0;
  const counter = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      bytesWritten += buffer.length;
      callback(null, buffer);
    },
  });
  const writable = new PassThrough();
  const completed = pipeline(writable, counter, destination).then(
    () => bytesWritten,
    async (error: unknown) => {
      try {
        await cleanupOnFailure?.();
      } catch {
        // Preserve the stream error that caused this write to fail.
      }
      throw error;
    },
  );

  return { writable, completed };
}

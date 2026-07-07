import { app } from 'electron';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  try {
    appendFileSync(path.join(app.getPath('userData'), 'app.log'), line + '\n');
  } catch {
    // sem log em disco não é fatal
  }
}

import { connect } from 'net';

export interface ScanResult {
  status: 'CLEAN' | 'INFECTED' | 'ERROR' | 'SKIPPED';
  signature?: string;
}

/** Zararli dastur skaneri "ilgagi". Standart: o'tkazib yuboriladi (NOT_SCANNED) — production uchun clamd sozlang (KNOWN_GAPS). */
export interface ScanProvider {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

export class NoScanProvider implements ScanProvider {
  readonly name = 'none';
  async scan(): Promise<ScanResult> {
    return { status: 'SKIPPED' };
  }
}

/**
 * ClamAV (clamd) INSTREAM protokoli. Env: CLAMD_HOST, CLAMD_PORT (standart 3310).
 * HOLAT: UNTESTED (haqiqiy clamd yo'q) — faqat protokol formati yozilgan.
 */
export class ClamdScanProvider implements ScanProvider {
  readonly name = 'clamd';
  constructor(private host: string, private port = 3310, private timeoutMs = 15_000) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const sock = connect(this.port, this.host);
      let out = '';
      const done = (r: ScanResult) => {
        sock.destroy();
        resolve(r);
      };
      sock.setTimeout(this.timeoutMs, () => done({ status: 'ERROR' }));
      sock.on('error', () => done({ status: 'ERROR' }));
      sock.on('data', (d) => (out += d.toString()));
      sock.on('end', () => {
        const m = /stream:\s*(.+?)\s*(FOUND|OK|ERROR)/.exec(out);
        if (!m) return done({ status: 'ERROR' });
        done(m[2] === 'OK' ? { status: 'CLEAN' } : m[2] === 'FOUND' ? { status: 'INFECTED', signature: m[1] } : { status: 'ERROR' });
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          sock.write(len);
          sock.write(chunk);
        }
        sock.write(Buffer.alloc(4)); // 0-uzunlik = tugadi
      });
    });
  }
}

export const SCAN_PROVIDER = Symbol('SCAN_PROVIDER');

export function createScanProvider(env: NodeJS.ProcessEnv = process.env): ScanProvider {
  return env.CLAMD_HOST ? new ClamdScanProvider(env.CLAMD_HOST, Number(env.CLAMD_PORT) || 3310) : new NoScanProvider();
}

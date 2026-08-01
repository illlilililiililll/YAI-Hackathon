import { createHash } from "node:crypto";
import type { Writable } from "node:stream";

export type RawEventPortReceipt = {
  eventCount: number;
  fileByteLength: number;
  fileSha256: string;
};

export interface RawEventPort {
  write(line: Uint8Array): Promise<void>;
  seal(): Promise<RawEventPortReceipt>;
}

abstract class CountingRawEventPort implements RawEventPort {
  private readonly hash = createHash("sha256");
  private count = 0;
  private byteLength = 0;
  private sealed = false;

  async write(line: Uint8Array): Promise<void> {
    if (this.sealed) {
      throw new Error("RawEventPort는 seal 뒤에 쓸 수 없습니다.");
    }
    const stableLine = Uint8Array.from(line);
    await this.writeLine(stableLine);
    this.hash.update(stableLine);
    this.count += 1;
    this.byteLength += stableLine.byteLength;
  }

  async seal(): Promise<RawEventPortReceipt> {
    if (this.sealed) {
      throw new Error("RawEventPort는 두 번 seal할 수 없습니다.");
    }
    this.sealed = true;
    await this.finish();
    return {
      eventCount: this.count,
      fileByteLength: this.byteLength,
      fileSha256: this.hash.digest("hex"),
    };
  }

  protected abstract writeLine(line: Uint8Array): Promise<void>;

  protected async finish(): Promise<void> {}
}

export class InMemoryRawEventPort extends CountingRawEventPort {
  readonly lines: Uint8Array[] = [];

  protected async writeLine(line: Uint8Array): Promise<void> {
    this.lines.push(Uint8Array.from(line));
  }
}
export class WritableRawEventPort extends CountingRawEventPort {
  constructor(private readonly writable: Writable) {
    super();
  }

  protected async writeLine(line: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.writable.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

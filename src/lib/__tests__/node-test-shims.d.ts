declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:worker_threads' {
  export class Worker {
    constructor(filename: string);
    on(event: string, listener: (value: unknown) => void): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    terminate(): Promise<number>;
  }
}

declare const process: {
  readonly pid: number;
};

interface ImportMeta {
  readonly dirname: string;
}

// Narrow Node interfaces for the cross-origin browser download fixture.
declare module 'node:http' {
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    address(): { port: number } | string | null;
    close(callback: (error?: Error) => void): void;
  }
  export function createServer(
    handler: (
      request: unknown,
      response: {
        writeHead(status: number, headers: Record<string, string | number>): void;
        end(body: Uint8Array): void;
      },
    ) => void,
  ): Server;
}

declare module 'node:zlib' {
  export function gzipSync(bytes: Uint8Array): Uint8Array;
}

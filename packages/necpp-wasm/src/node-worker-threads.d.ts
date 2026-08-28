declare module "node:worker_threads" {
  export class Worker {
    constructor(filename: string | URL, options?: { type?: "module" });
    postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
    terminate(): Promise<number>;
    on(event: "message", listener: (value: unknown) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "exit", listener: (code: number) => void): this;
    off(event: "message", listener: (value: unknown) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "exit", listener: (code: number) => void): this;
  }

  export interface MessagePort {
    postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
    on(event: "message", listener: (value: unknown) => void): this;
  }

  export const parentPort: MessagePort | null;
}

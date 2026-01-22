export interface Transport {
  open(): void;
  close(): void;
  send(data: Buffer): void;

  onData(cb: (data: Buffer) => void): void;
  onError(cb: (err: Error) => void): void;
}

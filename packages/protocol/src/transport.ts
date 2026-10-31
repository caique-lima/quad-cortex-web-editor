/** A raw HID pipe carrying 128-byte report bodies (no report-ID byte). */
export interface Transport {
  /** Send one report body. Implementations MUST swallow the device's benign write-STALL error. */
  send(body: Uint8Array): Promise<void>;
  /** Subscribe to incoming report bodies. Returns an unsubscribe function. */
  onReport(cb: (body: Uint8Array) => void): () => void;
  /** Subscribe to the pipe going away (unplugged / closed). */
  onClose(cb: (reason?: unknown) => void): () => void;
  close(): Promise<void>;
}

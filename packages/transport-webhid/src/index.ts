import { IN_REPORT_ID, OUT_REPORT_ID, REPORT_BODY_SIZE, type Transport } from '@qc/protocol';

export const NEURAL_DSP_VENDOR_ID = 0x152a;
export const QUAD_CORTEX_PRODUCT_ID = 0x880a;

export const isWebHidSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator;

export interface WebHidTransportOptions {
  /** Called for every output-report error we swallow (the unit "fails" every write but acts on it). */
  onWriteError?: (err: unknown, count: number) => void;
}

/** Describe a HIDDevice's collections — Phase 0 diagnostics, and used to pick the right interface. */
export function describeDevice(d: HIDDevice): string {
  const cols = d.collections.map((c) => {
    const ins = (c.inputReports ?? []).map((r) => `in#${r.reportId}`);
    const outs = (c.outputReports ?? []).map((r) => `out#${r.reportId}`);
    return `usagePage=0x${(c.usagePage ?? 0).toString(16)} usage=0x${(c.usage ?? 0).toString(16)} [${[...ins, ...outs].join(' ')}]`;
  });
  return `${d.productName} (${d.vendorId?.toString(16)}:${d.productId?.toString(16)}) ${cols.join(' | ') || 'no collections'}`;
}

/** True if this HID interface exposes the control protocol's report IDs (out #2 and in #1). */
export function looksLikeControlInterface(d: HIDDevice): boolean {
  const hasOut = d.collections.some((c) => (c.outputReports ?? []).some((r) => r.reportId === OUT_REPORT_ID));
  const hasIn = d.collections.some((c) => (c.inputReports ?? []).some((r) => r.reportId === IN_REPORT_ID));
  return hasOut && hasIn;
}

/** Show the browser's device chooser. Must be called from a user gesture. */
export async function requestQuadCortex(): Promise<HIDDevice[]> {
  return navigator.hid.requestDevice({
    filters: [{ vendorId: NEURAL_DSP_VENDOR_ID, productId: QUAD_CORTEX_PRODUCT_ID }],
  });
}

/** Devices the user already granted to this origin. */
export async function grantedQuadCortexes(): Promise<HIDDevice[]> {
  return (await navigator.hid.getDevices()).filter(
    (d) => d.vendorId === NEURAL_DSP_VENDOR_ID && d.productId === QUAD_CORTEX_PRODUCT_ID,
  );
}

export class WebHidTransport implements Transport {
  private reportCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: unknown) => void>();
  private writeErrors = 0;
  private readonly onInput = (e: HIDInputReportEvent) => {
    if (e.reportId !== IN_REPORT_ID) return;
    // Copy: the underlying buffer may be reused by the browser.
    const body = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    for (const cb of [...this.reportCbs]) cb(body);
  };
  private readonly onDisconnect = (e: HIDConnectionEvent) => {
    if (e.device === this.device) this.fireClose('disconnected');
  };

  private constructor(private device: HIDDevice, private opts: WebHidTransportOptions) {}

  static async open(device: HIDDevice, opts: WebHidTransportOptions = {}): Promise<WebHidTransport> {
    if (!device.opened) await device.open();
    const t = new WebHidTransport(device, opts);
    device.addEventListener('inputreport', t.onInput);
    navigator.hid.addEventListener('disconnect', t.onDisconnect);
    return t;
  }

  get info() {
    return describeDevice(this.device);
  }

  async send(body: Uint8Array): Promise<void> {
    if (body.length !== REPORT_BODY_SIZE) throw new Error(`report body must be ${REPORT_BODY_SIZE} bytes, got ${body.length}`);
    try {
      await this.device.sendReport(OUT_REPORT_ID, body as BufferSource);
    } catch (err) {
      // Known behaviour: the unit consumes every output report but stalls the status stage, which the host
      // reports as a write failure. Real failures (unit gone/dead) surface as request timeouts upstream.
      this.writeErrors++;
      this.opts.onWriteError?.(err, this.writeErrors);
    }
  }

  onReport(cb: (b: Uint8Array) => void) {
    this.reportCbs.add(cb);
    return () => this.reportCbs.delete(cb);
  }

  onClose(cb: (r?: unknown) => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  async close(): Promise<void> {
    this.detach();
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      /* already gone */
    }
  }

  private detach() {
    this.device.removeEventListener('inputreport', this.onInput);
    navigator.hid.removeEventListener('disconnect', this.onDisconnect);
  }

  private fireClose(reason: unknown) {
    this.detach();
    for (const cb of [...this.closeCbs]) cb(reason);
  }
}

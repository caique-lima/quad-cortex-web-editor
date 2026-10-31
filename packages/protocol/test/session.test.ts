import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, TimeoutError, SUBSCRIBE_TYPES } from '../src/session';
import * as pa from '../src/gen/ProductionAutomation_pb';
import { FakeDevice } from './fake-device';

afterEach(() => vi.useRealTimers());

describe('Session', () => {
  it('readVersion skips the unit\'s bare second READ and needs no handshake', async () => {
    const dev = new FakeDevice();
    const s = new Session(dev);
    const v = await s.readVersion();
    expect(v.appFwVersion).toBe('d14e');
    expect(dev.sent.map((x) => x.name)).toEqual(['Version']); // nothing else was sent
    await s.close();
  });

  it('connect() performs the handshake in order', async () => {
    const dev = new FakeDevice();
    const s = new Session(dev, { settleMs: 0, ccVersion: '4.0.1' });
    await s.connect();
    const names = dev.sent.map((x) => x.name);
    expect(names.slice(0, 4)).toEqual(['ResetCommsBuffers', 'Version', 'ModelRepo', 'Connection']);
    expect(names.slice(4)).toEqual([...SUBSCRIBE_TYPES]);
    expect(dev.sent[0]!.msg.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(dev.sent[1]!.msg.action).toBe(pa.MessageAction_Enum.UPDATE);
    expect(dev.sent[1]!.msg.cortexControlVersion).toBe('4.0.1');
    expect(dev.sent[3]!.msg.connected).toBe(true);
    for (const x of dev.sent.slice(4)) expect(x.msg.action).toBe(pa.MessageAction_Enum.READ);
    await s.close();
  });

  it('sends keepalives every interval after connect, and a goodbye on close', async () => {
    const dev = new FakeDevice();
    const s = new Session(dev, { settleMs: 0, keepAliveMs: 20 });
    await s.connect();
    const before = dev.sent.length;
    await new Promise((r) => setTimeout(r, 75));
    const ka = dev.sent.slice(before).filter((x) => x.name === 'KeepAlive');
    expect(ka.length).toBeGreaterThanOrEqual(2);
    expect(ka[0]!.msg.isOnline).toBe(true);
    await s.close();
    expect(dev.sent.at(-1)!.name).toBe('Connection');
    expect(dev.sent.at(-1)!.msg.connected).toBe(false);
    expect(dev.closed).toBe(true);
    const n = dev.sent.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(dev.sent.length).toBe(n); // keepalive stopped
  });

  it('times out when the unit is silent (a swallowed write error must not look like success)', async () => {
    const dev = new FakeDevice();
    dev.silent = true;
    const s = new Session(dev, { timeoutMs: 30 });
    await expect(s.readVersion(30)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('decodes gzip-compressed, multi-report messages by magic bytes', async () => {
    const dev = new FakeDevice();
    const s = new Session(dev);
    const got = s.waitFor(pa.VersionMessageSchema, (m) => m.customName !== undefined);
    // big + compressible so it spans several reports after gzip
    dev.emit(pa.VersionMessageSchema, { action: 1, customName: 'x'.repeat(5000), appFwVersion: 'zz' }, { gzip: true });
    const m = await got;
    expect(m.message.customName).toHaveLength(5000);
    await s.close();
  });

  it('delivers every message to listeners, and rejects waiters on unplug via onClose', async () => {
    const dev = new FakeDevice();
    const s = new Session(dev);
    const seen: string[] = [];
    s.on((m) => seen.push(m.typeName));
    const closed = vi.fn();
    s.onClose(closed);
    dev.emit(pa.SceneMessageSchema, { action: 1, selectedScene: 3 });
    expect(seen).toEqual(['Scene']);
    dev.unplug();
    expect(closed).toHaveBeenCalledWith('unplugged');
  });
});

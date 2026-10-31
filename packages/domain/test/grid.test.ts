import { describe, expect, it } from 'vitest';
import { buildGrid } from '../src/grid';
import { bypassRow, catalog, model, preset } from './helpers';

describe('buildGrid', () => {
  it('always returns 4 rows × 8 columns, empty cells flagged', () => {
    const g = buildGrid(preset({}), catalog, 0);
    expect(g).toHaveLength(4);
    for (const r of g) {
      expect(r.cells).toHaveLength(8);
      expect(r.cells.every((c) => c.empty && c.name === '')).toBe(true);
    }
  });

  it('resolves names/params from the catalog by hash, unknown hashes stay visible', () => {
    const g = buildGrid(preset({ '0,2': model(1, { params: [[5], [6], [7]] }), '1,0': model(999999) }), catalog, 0);
    const c = g[0]!.cells[2]!;
    expect(c).toMatchObject({ empty: false, name: 'Myth Drive', category: 'Guitar Overdrive', unknown: false, row: 0, column: 2 });
    expect(c.params.map((p) => [p.name, p.value])).toEqual([['GAIN', 5], ['TREBLE', 6], ['LEVEL', 7]]);
    const u = g[1]!.cells[0]!;
    expect(u).toMatchObject({ empty: false, unknown: true, name: 'Block #999999' });
  });

  it('uses the active scene for scene-mode params only; others read entry 0', () => {
    const p = preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [10, 20, 30]], sceneModeParams: [0] }) });
    expect(buildGrid(p, catalog, 3)[0]!.cells[0]!.params.map((x) => x.value)).toEqual([4, 10]);
    expect(buildGrid(p, catalog, 7)[0]!.cells[0]!.params.map((x) => x.value)).toEqual([8, 10]);
    expect(buildGrid(p, catalog, 0)[0]!.cells[0]!.params[0]!.sceneMode).toBe(true);
  });

  it('bypass: global when sceneMode=false, per-scene when true; positional rows/columns', () => {
    const p = preset(
      { '0,0': model(1), '0,1': model(2), '2,3': model(1) },
      {
        bypass: [
          bypassRow(0, { 0: { states: [true] }, 1: { perScene: true, states: [false, true, false, false, false, false, false, false] } }),
          bypassRow(1, {}),
          bypassRow(2, { 3: { states: [true] } }),
          bypassRow(3, {}),
        ],
      },
    );
    const at = (scene: number) => buildGrid(p, catalog, scene);
    expect(at(0)[0]!.cells[0]!).toMatchObject({ bypassed: true, bypassPerScene: false });
    expect(at(0)[0]!.cells[1]!).toMatchObject({ bypassed: false, bypassPerScene: true });
    expect(at(1)[0]!.cells[1]!.bypassed).toBe(true);
    expect(at(1)[2]!.cells[3]!.bypassed).toBe(true);
  });

  it('honours explicit row/column fields over list position', () => {
    const p = preset({});
    p.chains[0]!.row = 2;
    p.chains[0]!.models[0] = model(1, { column: 5 });
    const g = buildGrid(p, catalog, 0);
    expect(g[2]!.cells[5]!.name).toBe('Myth Drive');
  });

  it('works without a catalog and with NaN / missing values', () => {
    const p = preset({ '0,0': model(1, { params: [[Number.NaN], []] }) });
    const c = buildGrid(p, undefined, 0)[0]!.cells[0]!;
    expect(c.name).toBe('Block #1');
    expect(Number.isNaN(c.params[0]!.value as number)).toBe(true);
    expect(c.params[1]!.value).toBeUndefined();
  });
});

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

// ---- cabs: a cab block sends 21 parameters indexed by the shared layout ----
import { create } from '@bufbuild/protobuf';
import { preset as PB } from '@qc/protocol';

describe('cab blocks', () => {
  const fv = (v: number) => create(PB.ParamValueSchema, { value: { case: 'floatValue', value: v } });
  const sv = (v: string) => create(PB.ParamValueSchema, { value: { case: 'stringValue', value: v } });
  /** A cab as the unit sends it: 21 wire parameters, two of them text (the IR choices). */
  const cabModel = (hash: number) => {
    const vals: Record<number, number | string> = { 1: 'ML_412 D-Cell Front V30 04_Dynamic 57', 9: 'ML_412 D-Cell Front V30 04_Ribbon 160', 19: 'x', 20: 'y' };
    return create(PB.ModelSchema, {
      hash,
      params: Array.from({ length: 21 }, (_, index) => {
        const v = vals[index] ?? 0.5;
        return create(PB.ParamSchema, { index, paramValues: [typeof v === 'string' ? sv(v) : fv(v)] });
      }),
    });
  };
  const cell = (hash: number) => buildGrid(preset({ '0,0': cabModel(hash) }), catalog, 0)[0]!.cells[0]!;
  const byName = (c: ReturnType<typeof cell>, n: string) => c.params.find((p) => p.name === n)!;

  it('names and converts every setting of a mono cab, one set per mic', () => {
    const c = cell(12002); // 412 D-Cell Front V30 04 (M): its own entry has only 2 parameters
    expect(c.params).toHaveLength(21);
    expect(byName(c, 'MIC 1 LEVEL').display.text).toBe('0.0 dB'); // wire 0.5 on the cab law
    expect(byName(c, 'MIC 2 LEVEL').display.text).toBe('0.0 dB');
    expect(byName(c, 'MIC 1 PAN').display.text).toBe('C');
    expect(byName(c, 'MIC 1 bypass').display.text).toBe('On'); // 2-option switch at wire 0.5 -> option 1
    expect(byName(c, 'HPF').meta).toBeDefined();
    expect(byName(c, 'LPF').meta).toBeDefined();
    expect(byName(c, 'OUTPUT VOLUME').meta).toBeDefined();
    // the IR choices are text: shown, never editable
    expect(byName(c, 'MIC 1 ir selector').display.text).toBe('ML_412 D-Cell Front V30 04_Dynamic 57');
    expect(byName(c, 'MIC 2 ir selector').display.text).toMatch(/Ribbon 160/);
    // the unit's internal name fields stay out of the way
    expect(c.params.filter((p) => p.name === 'IR NAME').every((p) => p.hidden)).toBe(true);
  });

  it('every editable-looking setting is actually convertible (so the UI offers a control)', () => {
    const c = cell(12002);
    const editable = c.params.filter((p) => !p.hidden && p.meta && p.meta.type !== 'string' && p.display.converted);
    expect(editable.map((p) => p.name)).toEqual(expect.arrayContaining(['MIC 1 LEVEL', 'MIC 1 PAN', 'MIC 1 DISTANCE', 'MIC 1 POSITION', 'MIC 2 LEVEL', 'HPF', 'LPF', 'OUTPUT VOLUME']));
    expect(editable.length).toBeGreaterThanOrEqual(14);
  });

  it('a stereo cab calls PAN "BALANCE"; the 5 self-describing cabs and IR loaders are left as they are', () => {
    const st = [...catalog.models.values()].find((m) => m.category === 'Cabsim Guitar (ST)' && m.params.length < 21)!;
    expect(cell(st.id).params.some((p) => p.name === 'MIC 1 BALANCE')).toBe(true);
    const loader = cell(29001); // Single (M): 24 entries, wire-indexed by itself
    expect(loader.params.find((p) => p.name === 'LEVEL')?.index).toBe(3);
    expect(loader.params.some((p) => /^MIC /.test(p.name ?? ''))).toBe(false);
  });

  it('non-cab blocks are unchanged', () => {
    const g = buildGrid(preset({ '0,0': model(1, { params: [[5], [6], [7]] }) }), catalog, 0);
    expect(g[0]!.cells[0]!.params.map((p) => p.name)).toEqual(['GAIN', 'TREBLE', 'LEVEL']);
  });
});

// ---- IR loaders: the IR fields are hidden in the catalog; the loaded IR must still be visible ----
describe('IR loader blocks', () => {
  const fv = (v: number) => create(PB.ParamValueSchema, { value: { case: 'floatValue', value: v } });
  const sv = (v: string) => create(PB.ParamValueSchema, { value: { case: 'stringValue', value: v } });
  /** An IR loader as the unit sends it: 24 wire parameters; text at 2/10 (IR PATH) and 22/23 (IR NAME). */
  const loader = (hash: number, text: Record<number, string>) =>
    create(PB.ModelSchema, {
      hash,
      params: Array.from({ length: 24 }, (_, index) => create(PB.ParamSchema, { index, paramValues: [text[index] !== undefined ? sv(text[index]!) : [2, 10, 22, 23].includes(index) ? sv('') : fv(0.5)] })),
    });
  const cellOf = (hash: number, text: Record<number, string>) => buildGrid(preset({ '0,0': loader(hash, text) }), catalog, 0)[0]!.cells[0]!;
  const visible = (c: ReturnType<typeof cellOf>) => c.params.filter((p) => !p.hidden);

  it('a Dual loader shows both IRs, first in the list, with their names (read-only text)', () => {
    const c = cellOf(29003, { 2: 'lib/a.wav', 10: 'lib/b.wav', 22: 'Greenback 57', 23: 'Ribbon 160' });
    const v = visible(c);
    expect(v.slice(0, 2).map((p) => [p.name, p.display.text])).toEqual([['IR 1', 'Greenback 57'], ['IR 2', 'Ribbon 160']]);
    expect(v[0]!.meta!.type).toBe('string'); // so the UI never offers a control for it
    // the knobs are still there and still named
    expect(v.map((p) => p.name)).toEqual(expect.arrayContaining(['IR 1 LEVEL', 'IR 2 LEVEL', 'IR 1 HI PASS', 'IR 2 HI PASS', 'IR 1 LOW PASS', 'IR 2 PAN', 'IR 2 DELAY', 'ROOM MIX', 'SIZE']));
    // settings that exist once are not numbered
    expect(v.map((p) => p.name)).not.toContain('IR 1 ROOM MIX');
    // the two sets of identical names are told apart: no duplicate labels among the visible settings
    const names = v.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    // the raw path fields stay out of the way when the name is available
    expect(c.params.filter((p) => p.meta?.name === 'IR PATH').every((p) => p.hidden)).toBe(true);
  });

  it('a Single loader shows only IR 1', () => {
    const v = visible(cellOf(29001, { 22: 'Greenback 57', 23: 'unused' }));
    expect(v.filter((p) => /^IR \d$/.test(p.name ?? '')).map((p) => [p.name, p.display.text])).toEqual([['IR 1', 'Greenback 57']]);
    expect(v.map((p) => p.name)).toEqual(expect.arrayContaining(['LEVEL', 'HI PASS', 'LOW PASS', 'PAN', 'DELAY'])); // plain names: only one set is shown
    expect(v.some((p) => /^IR \d (LEVEL|PAN)/.test(p.name ?? ''))).toBe(false);
  });

  it('falls back to the path when the name is empty, and says so when nothing is loaded', () => {
    expect(visible(cellOf(29001, { 2: 'lib/user/cab.wav' }))[0]).toMatchObject({ name: 'IR 1', display: { text: 'lib/user/cab.wav' } });
    expect(visible(cellOf(29001, {}))[0]).toMatchObject({ name: 'IR 1', display: { text: 'None loaded' } });
  });

  it('every IR loader model in the real catalog gets 1 (Single) or 2 (Dual) IR rows', () => {
    for (const m of [...catalog.models.values()].filter((x) => x.category === 'IRLoaders')) {
      const rows = visible(cellOf(m.id, { 22: 'a', 23: 'b' })).filter((p) => /^IR \d$/.test(p.name ?? ''));
      expect(rows.length, m.name).toBe(/^Dual/.test(m.name) ? 2 : 1);
    }
  });

  it('cabs and other blocks are not affected', () => {
    const cab = buildGrid(preset({ '0,0': create(PB.ModelSchema, { hash: 12002, params: [create(PB.ParamSchema, { index: 1, paramValues: [sv('x')] })] }) }), catalog, 0)[0]!.cells[0]!;
    expect(cab.params.some((p) => /^IR \d$/.test(p.name ?? ''))).toBe(false);
  });
});

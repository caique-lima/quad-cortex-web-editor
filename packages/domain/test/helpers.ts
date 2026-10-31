import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { parseModelRepoPayload, preset as P } from '@qc/protocol';

export const catalog = parseModelRepoPayload(
  new Uint8Array(readFileSync(new URL('../../protocol/test/fixtures/model_repo_coros_4_0_1.bin', import.meta.url))),
);

const fv = (v: number) => ({ value: { case: 'floatValue' as const, value: v } });

export function model(hash: number, opts: { column?: number; params?: Array<number[]>; sceneModeParams?: number[] } = {}) {
  return create(P.ModelSchema, {
    hash,
    column: opts.column,
    params: (opts.params ?? []).map((vals, index) =>
      create(P.ParamSchema, {
        index,
        sceneMode: opts.sceneModeParams?.includes(index) ?? false,
        paramValues: vals.map((v) => create(P.ParamValueSchema, fv(v))),
      }),
    ),
  });
}

export const emptyModel = () => create(P.ModelSchema, {});

/** 4 rows × 8 columns; `place` maps "row,col" -> Model. Recalled chains carry no explicit `row`. */
export function preset(place: Record<string, ReturnType<typeof model>>, extra: Record<string, unknown> = {}) {
  const chains = [0, 1, 2, 3].map((r) =>
    create(P.ChainSchema, {
      models: Array.from({ length: 8 }, (_, c) => place[`${r},${c}`] ?? emptyModel()),
    }),
  );
  return create(P.BinaryPresetSchema, { name: 'Test', chains, ...extra } as never);
}

export const bypassRow = (row: number, cols: Record<number, { perScene?: boolean; states: boolean[] }>) =>
  create(P.BypassSchema, {
    row,
    colBypass: Array.from({ length: 8 }, (_, c) => {
      const s = cols[c];
      return create(P.ColBypassSchema, {
        sceneMode: s?.perScene ?? false,
        sceneBypass: (s?.states ?? [false]).map((bypass) => create(P.SceneBypassSchema, { bypass })),
      });
    }),
  });

/** Add lane controls like a real preset has: input gate + output control on every row; mixer + splitter on rows 0 and 2. */
export function withLaneControls(p: ReturnType<typeof preset>, values: { gate?: number[]; out?: number[]; mixer?: number[]; splitter?: number[] } = {}) {
  const mk = (hash: number | undefined, vals: number[], sceneModeIdx: number[] = []) =>
    create(P.ModelSchema, {
      hash,
      params: vals.map((v, index) => create(P.ParamSchema, { index, sceneMode: sceneModeIdx.includes(index), paramValues: [create(P.ParamValueSchema, fv(v))] })),
    });
  p.chains.forEach((c, r) => {
    c.inputControl = [mk(28000, values.gate ?? [0.3, 1, 0.5, 0.5])];
    c.outputControl = [mk(23000, values.out ?? [0.76923077, 0.5, 0, 0], [0])];
    if (r % 2 === 0) {
      c.mixer = [mk(11000, values.mixer ?? [0.76923077, 0.5, 0.76923077, 0.5, 0, 0.76923077, 0])];
      c.combinedSplitter = [mk(undefined, values.splitter ?? [0, 0, 0.5, 0.76923077, 0.76923077, 0.5, 0])];
    }
  });
  return p;
}

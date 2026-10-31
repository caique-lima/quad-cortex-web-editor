// The upstream (pyquadcortex, MIT) schema spells proto3 `optional` as an explicit single-field
// `oneof _x { T x = N; }`. That is wire-identical, but generates awkward ADT types. Rewrite those
// to `optional T x = N;` so generated TS gets plain `x?: T`. Real multi-field oneofs are left alone.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'proto-upstream');
const out = join(root, 'proto');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// oneof _name {\n   <one field line>\n  }
const re = /^(\s*)oneof\s+_\w+\s*\{\s*\n\s*([^\n;{}]+;)\s*\n\s*\}/gm;
let total = 0;
for (const f of readdirSync(src).filter((n) => n.endsWith('.proto'))) {
  let n = 0;
  const text = readFileSync(join(src, f), 'utf8').replace(re, (_m, indent, field) => {
    n++;
    return `${indent}optional ${field.trim()}`;
  });
  const left = (text.match(/oneof\s+_\w+/g) ?? []).length;
  console.log(`${f}: rewrote ${n} oneofs, ${left} underscore-oneofs left`);
  total += n;
  writeFileSync(join(out, f), text);
}
writeFileSync(join(out, 'buf.yaml'), 'version: v2\n');
console.log(`total ${total}`);

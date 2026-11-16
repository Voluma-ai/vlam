import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CsgsDecoder,
  csgsStateAfter,
  decodeCsgsSection,
  parseCsgsHeader,
  type CsgsParams,
  type CsgsSection,
  type CsgsState,
} from '../../lib/formats/csgs';
import { encodeCsgsSection } from './encode-csgs';

const FIXTURES = join(import.meta.dirname, '..', '..', 'lib', '__tests__', 'fixtures', 'csgs');

describe('encodeCsgsSection', () => {
  it("re-encodes Faltwerk's fixture sections byte for byte", () => {
    for (const stream of ['synth_res', 'synth_shared']) {
      let state: CsgsState | null = null;
      for (let s = 0; s < 3; s++) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(
            readFileSync(join(FIXTURES, `${stream}_s${String(s).padStart(4, '0')}.csgs`)),
          );
        } catch {
          break;
        }
        const { header } = parseCsgsHeader(bytes);
        const { params, section } = decodeCsgsSection(bytes, header.key ? null : state);
        const encoded = encodeCsgsSection(section, params, {
          state,
          snPred: header.snPred,
          idBase: header.idBase,
        });
        expect(encoded, `${stream} section ${s}`).toEqual(bytes);
        state = csgsStateAfter(section, params);
      }
    }
  });

  it('round-trips key and delta sections, with large values and both knot modes', () => {
    for (const sharedKnot of [false, true]) {
      const params: CsgsParams = {
        L: 16,
        ks: [1, 3, 7],
        groups: [
          ['P', 3],
          ['R', 4],
          ['S', 3],
          ['O', 1],
          ['D', 3],
        ],
        nSn: 45,
        offsets: new Float32Array(14 + 45),
        scales: new Float32Array(14 + 45).fill(0.01),
        sharedKnot,
        keyInterval: 4,
      };
      let seed = 7;
      const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const decoder = new CsgsDecoder();
      let previous: CsgsSection | null = null;
      for (let index = 0; index < 3; index++) {
        const key = index === 0;
        const state = previous ? csgsStateAfter(previous, params) : null;
        const nCont = key ? 5 : state!.ids.length;
        const nNew = 40;
        const n = nCont + nNew;
        const k = params.groups.map(() => new Uint8Array(n));
        const knotOff = params.groups.map(() => new Uint32Array(n + 1));
        const values: number[][] = params.groups.map(() => []);
        for (let i = 0; i < n; i++) {
          params.groups.forEach(([, dims], g) => {
            const K = params.ks[Math.floor(random() * 3)]!;
            k[g]![i] = K;
            for (let j = 0; j < K; j++) {
              for (let c = 0; c < dims; c++) {
                const shared = !key && i < nCont && j === 0 && sharedKnot;
                values[g]!.push(
                  shared
                    ? state!.last[g]![i * dims + c]!
                    : // Mostly small, sometimes past every escape width.
                      Math.round((random() - 0.5) * (random() < 0.05 ? 2 ** 31 : 600)),
                );
              }
            }
            knotOff[g]![i + 1] = values[g]!.length;
          });
        }
        const ids = new Uint32Array(n);
        if (key) for (let i = 0; i < nCont; i++) ids[i] = i * 3 + 1;
        else ids.set(state!.ids);
        for (let i = 0; i < nNew; i++) ids[nCont + i] = 1000 * (index + 1) + i;
        const sn = new Uint8Array(n * 45);
        if (!key) sn.set(state!.sn);
        for (let i = (key ? 0 : nCont) * 45; i < sn.length; i++) sn[i] = Math.floor(random() * 256);
        const section: CsgsSection = {
          index,
          g0: index * 16,
          nframes: 16,
          key,
          n,
          nCont,
          ids,
          birth: Uint16Array.from({ length: nNew }, () => Math.floor(random() * 16)),
          death: Uint16Array.from({ length: n }, () =>
            random() < 0.7 ? 17 : Math.floor(random() * 17),
          ),
          k,
          knotOff,
          knots: values.map((v) => Int32Array.from(v)),
          sn,
        };
        const snPred = Uint8Array.from({ length: 45 }, (_, c) => 100 + c);
        const bytes = encodeCsgsSection(section, params, { state, snPred });
        const decoded = decoder.decode(bytes);
        expect(decoded).toEqual(section);
        expect(decoder.params).toEqual(params);
        previous = section;
      }
    }
  });
});

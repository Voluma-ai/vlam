/**
 * Decode worker of the `.csgs` playback harness: rANS decoding of a 100k-splat
 * section takes several hundred milliseconds, which must not stall the page.
 *
 * One job decodes every section of a scene in stream order (delta sections
 * need the state of their predecessor) and posts each prepared section as it
 * completes, with its typed arrays transferred.
 */
import {
  CsgsDecoder,
  csgsShExtent,
  parseCsgsHeader,
  prepareCsgsSection,
  type CsgsPlaybackSection,
} from '../lib/formats/csgs';

/** Request: the raw bytes of every section of one scene, in stream order. */
export interface CsgsDecodeRequest {
  readonly id: number;
  readonly sections: readonly ArrayBuffer[];
}

/** One decoded section, or the failure that stopped the job. */
export type CsgsDecodeReply =
  | {
      readonly id: number;
      readonly index: number;
      readonly section: CsgsPlaybackSection;
      readonly decodeMs: number;
    }
  | { readonly id: number; readonly error: string };

const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<CsgsDecodeRequest>): void => {
  const { id, sections } = event.data;
  try {
    // One packed-SH range for the whole stream, so the pool never requantizes
    // a later section against the first one's range.
    let shExtent = 0;
    for (const bytes of sections) {
      shExtent = Math.max(shExtent, csgsShExtent(parseCsgsHeader(new Uint8Array(bytes)).params));
    }
    const decoder = new CsgsDecoder();
    sections.forEach((bytes, index) => {
      const started = performance.now();
      const decoded = decoder.decode(new Uint8Array(bytes));
      const section = prepareCsgsSection(decoded, decoder.params!, shExtent);
      const reply: CsgsDecodeReply = {
        id,
        index,
        section,
        decodeMs: performance.now() - started,
      };
      scope.postMessage(reply, [
        section.birthFrame.buffer,
        section.deathFrame.buffer,
        section.shPacked.packed.buffer,
        ...section.knots.map((knots) => knots.buffer),
        ...section.k.map((k) => k.buffer),
        ...section.knotOff.map((off) => off.buffer),
      ]);
    });
  } catch (error) {
    const reply: CsgsDecodeReply = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};

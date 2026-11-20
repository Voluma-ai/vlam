/** Types of the parts of the vendored reference decoder the tests call. */
declare module '*/animated-sog/decode.js' {
  export interface ReferenceAsogData {
    count: number;
    shBands: number;
    sog: Record<string, Uint8Array | number | undefined>;
    motion: { A?: Uint32Array; B?: Uint16Array };
    clips: Float32Array;
    centers: Float32Array | null;
  }
  export function decodeAsog(source: ArrayBuffer | Uint8Array, options?: object): Promise<ReferenceAsogData>;
}
declare module '*/animated-sog/motion.js' {
  export interface ReferenceMotion {
    x: number;
    y: number;
    z: number;
    mu: number;
    sigma: number;
    anchor: Float64Array;
    omega: Float64Array;
    g: Float64Array;
    isStatic: boolean;
    clip: number;
  }
  export function createMotion(): ReferenceMotion;
  export function evaluateSplat(m: ReferenceMotion, t: number, out: Float64Array): number;
  export function clipWeight(clips: ArrayLike<number>, c: number, t: number): number;
  export function readMotion(
    A: Uint32Array,
    Af: Float32Array,
    B: Uint16Array,
    half: Float32Array,
    centers: Float32Array,
    i: number,
    m: ReferenceMotion,
  ): ReferenceMotion;
}
declare module '*/animated-sog/half.js' {
  export function getHalfTable(): Float32Array;
}

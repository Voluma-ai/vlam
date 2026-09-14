/** Benchmark-only WebGL state adapter; no library renderer state is changed. */
export interface ProvokingVertexExtension {
  readonly FIRST_VERTEX_CONVENTION_WEBGL: number;
  readonly LAST_VERTEX_CONVENTION_WEBGL: number;
  readonly PROVOKING_VERTEX_WEBGL: number;
  provokingVertexWEBGL(mode: number): void;
}

export class ProvokingVertexBenchmark {
  readonly extension: ProvokingVertexExtension | null;
  readonly initialConvention: number | null;
  appliedRenders = 0;

  constructor(
    private readonly gl: Pick<WebGL2RenderingContext, 'getExtension' | 'getParameter'>,
    readonly requested: boolean,
  ) {
    this.extension = gl.getExtension('WEBGL_provoking_vertex') as ProvokingVertexExtension | null;
    this.initialConvention = this.extension
      ? (gl.getParameter(this.extension.PROVOKING_VERTEX_WEBGL) as number)
      : null;
  }

  render<T>(callback: () => T): T {
    const ext = this.extension;
    if (!this.requested || !ext) return callback();
    const previous = this.gl.getParameter(ext.PROVOKING_VERTEX_WEBGL) as number;
    ext.provokingVertexWEBGL(ext.FIRST_VERTEX_CONVENTION_WEBGL);
    try {
      this.appliedRenders++;
      return callback();
    } finally {
      ext.provokingVertexWEBGL(previous);
    }
  }

  diagnostics(): {
    requested: boolean;
    supported: boolean;
    initialConvention: number | null;
    currentConvention: number | null;
    appliedRenders: number;
  } {
    return {
      requested: this.requested,
      supported: this.extension !== null,
      initialConvention: this.initialConvention,
      currentConvention: this.extension
        ? (this.gl.getParameter(this.extension.PROVOKING_VERTEX_WEBGL) as number)
        : null,
      appliedRenders: this.appliedRenders,
    };
  }
}

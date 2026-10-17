// Renders a showcase to an MP4 file in the browser.
//
// Frames are rendered one at a time on a fixed clock (frame n is shown at
// n / fps seconds), so the video is smooth at the full frame rate however
// slowly the machine renders. Each frame is composed with the showcase frame (bars, brand, lower third) on a 2D
// canvas, encoded to H.264 with WebCodecs and muxed into an MP4.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export type RecordSpec = { width: number; height: number; fps: number };

// H.264 High profile; level 4.2 covers 1080p at 60 fps
const CODECS = ["avc1.64002A", "avc1.640028", "avc1.4D0028", "avc1.42E01F"];

export class VideoRecorder {
  readonly spec: RecordSpec;
  private canvas: OffscreenCanvas;
  private context: OffscreenCanvasRenderingContext2D;
  private muxer: Muxer<ArrayBufferTarget>;
  private encoder: VideoEncoder;
  private failure: Error | null = null;
  frames = 0;

  private constructor(spec: RecordSpec, codec: string) {
    this.spec = spec;
    this.canvas = new OffscreenCanvas(spec.width, spec.height);
    this.context = this.canvas.getContext("2d")!;
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: spec.width, height: spec.height, frameRate: spec.fps }, fastStart: "in-memory" });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        this.failure = error;
      },
    });
    this.encoder.configure({ codec, width: spec.width, height: spec.height, bitrate: spec.width * spec.height * spec.fps * 0.065, framerate: spec.fps });
  }

  static async create(spec: RecordSpec) {
    if (typeof VideoEncoder === "undefined") throw new Error("This browser cannot encode video. Use a recent Chrome or Edge.");
    for (const codec of CODECS) {
      const support = await VideoEncoder.isConfigSupported({ codec, width: spec.width, height: spec.height, framerate: spec.fps });
      if (support.supported) return new VideoRecorder(spec, codec);
    }
    throw new Error(`No H.264 encoder for ${spec.width}×${spec.height} at ${spec.fps} fps in this browser.`);
  }

  /** True while the encoder has room; the caller renders the same frame again otherwise. */
  get ready() {
    return this.encoder.encodeQueueSize < 8;
  }

  /** Adds the WebGL canvas as the next frame, framed like the live view: bars, brand, lower third, dip to black. */
  addFrame(source: HTMLCanvasElement, third: LowerThird | null, dip: number) {
    if (this.failure) throw this.failure;
    const { width, height, fps } = this.spec;
    const ctx = this.context;
    ctx.globalAlpha = 1;
    ctx.drawImage(source, 0, 0, width, height);
    drawFrame(ctx, width, height, third);
    if (dip > 0) {
      ctx.globalAlpha = dip;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round((this.frames * 1e6) / fps), duration: Math.round(1e6 / fps) });
    this.encoder.encode(frame, { keyFrame: this.frames % (fps * 2) === 0 });
    frame.close();
    this.frames += 1;
  }

  async finish() {
    await this.encoder.flush();
    if (this.failure) throw this.failure;
    this.muxer.finalize();
    this.encoder.close();
    return new Blob([this.muxer.target.buffer], { type: "video/mp4" });
  }

  cancel() {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

export type LowerThird = { title: string; fact?: string; age: number };

const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

/**
 * The showcase frame, as in the live view: black bars with the brand mark
 * (landscape only), and a lower third at the bottom left that fades and rises
 * in when its headline changes.
 */
function drawFrame(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, third: LowerThird | null) {
  const scale = Math.min(width, height) / 1080;
  const landscape = width > height;
  const bar = landscape ? Math.round(height * 0.085) : 0;
  const left = Math.round((landscape ? 64 : 56) * scale);
  if (bar) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, bar);
    ctx.fillRect(0, height - bar, width, bar);
  }
  // brand mark, top left
  const mark = 30 * scale;
  const markY = bar ? (bar - mark) / 2 : 36 * scale;
  const gradient = ctx.createLinearGradient(left, markY, left + mark, markY + mark);
  gradient.addColorStop(0, "#4fd1b5");
  gradient.addColorStop(1, "#3d7fa8");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(left, markY, mark, mark, 8 * scale);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${Math.round(13 * scale)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("DT", left + mark / 2, markY + mark / 2 + 1);
  ctx.textAlign = "left";
  ctx.font = `800 ${Math.round(17 * scale)}px ${FONT}`;
  ctx.fillText("DISPATCH TWIN", left + mark + 12 * scale, markY + mark / 2 + 1);
  if (!third) return;
  const k = Math.min(1, third.age / 0.45);
  const titleSize = Math.round((landscape ? 54 : 50) * scale);
  const factSize = Math.round((landscape ? 25 : 24) * scale);
  const maxWidth = width - left * 2;
  const base = height - bar - (landscape ? 52 : 120) * scale + (1 - k) * 12 * scale;
  ctx.save();
  ctx.globalAlpha = k;
  // a soft shade behind the text keeps it readable over bright floors
  const shade = ctx.createLinearGradient(0, base - titleSize * 3, 0, height - bar);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, base - titleSize * 3, width, height - bar - (base - titleSize * 3));
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 14 * scale;
  ctx.textBaseline = "alphabetic";
  const factLines = third.fact ? wrap(ctx, third.fact, maxWidth, `500 ${factSize}px ${FONT}`) : [];
  const factHeight = factLines.length * factSize * 1.35;
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${titleSize}px ${FONT}`;
  ctx.fillText(third.title, left, base - factHeight - 10 * scale, maxWidth);
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.font = `500 ${factSize}px ${FONT}`;
  factLines.forEach((line, index) => ctx.fillText(line, left, base - factHeight + factSize * 1.35 * (index + 0.8)));
  ctx.restore();
}

function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number, font: string) {
  ctx.font = font;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

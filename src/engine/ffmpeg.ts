import { execFile } from "node:child_process";

/**
 * ffmpeg helpers shared by the Recorder (breakpoint replay) and the Screencaster (motion screencast).
 * Both assemble frames the same way — a concat-demuxer list → an H.264 mp4 — so the invocation shape lives
 * here once. Callers vary only the pixel-format strategy (a `-vf` filter vs `-pix_fmt`).
 */

/** Filename of the concat-demuxer frame list written into each render temp dir. */
export const FRAMES_LIST_FILE = "frames.txt";

/** ffmpeg concat-demuxer input args for a frame-list file. */
export const concatInput = (listFile: string): string[] => ["-f", "concat", "-safe", "0", "-i", listFile];

/** H.264 mp4 output args (30fps, web-friendly faststart). Pass `pixFmt` to force a pixel format. */
export const h264Mp4 = (opts: { pixFmt?: string } = {}): string[] => [
  "-r", "30", "-c:v", "libx264",
  ...(opts.pixFmt ? ["-pix_fmt", opts.pixFmt] : []),
  "-movflags", "+faststart",
];

/** Run ffmpeg with quiet global flags (`-y -hide_banner -loglevel error`); rejects with stderr on failure. */
export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], (err: any, _o, stderr) =>
      err ? rej(new Error(stderr || err.message)) : res());
  });
}

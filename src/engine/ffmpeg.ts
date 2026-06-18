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
export const h264Mp4 = (options: { pixFmt?: string } = {}): string[] => [
  "-r", "30", "-c:v", "libx264",
  ...(options.pixFmt ? ["-pix_fmt", options.pixFmt] : []),
  "-movflags", "+faststart",
];

/** Run ffmpeg with quiet global flags (`-y -hide_banner -loglevel error`); rejects with stderr on failure. */
export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], (error: any, _stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve());
  });
}

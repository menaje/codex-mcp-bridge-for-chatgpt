export function writePrivateFileAtomic(
  filePath: string,
  contents: string | NodeJS.ArrayBufferView,
  options?: { encoding?: BufferEncoding }
): string;

export function readPrivateFile(
  filePath: string,
  options: { encoding: BufferEncoding }
): string;

export function readPrivateFile(filePath: string): Buffer;

export function assertPrivateFile(filePath: string): void;
export function ensurePrivateDirectory(directory: string): void;

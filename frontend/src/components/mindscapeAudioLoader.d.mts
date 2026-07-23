export type AudioResponse = {
  ok: boolean;
  blob: () => Promise<Blob>;
};

export type AudioLoaderDependencies = {
  fetchAudio: (runKey: string) => Promise<AudioResponse>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

export type MindscapeAudioLoader = {
  cancel: () => void;
  load: (track: { run_key: string }) => Promise<string | null>;
};

export function createMindscapeAudioLoader(dependencies: AudioLoaderDependencies): MindscapeAudioLoader;

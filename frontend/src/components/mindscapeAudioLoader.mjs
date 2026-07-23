export function createMindscapeAudioLoader({ fetchAudio, createObjectURL, revokeObjectURL }) {
  let requestId = 0;

  return {
    cancel() {
      requestId += 1;
    },
    async load(track) {
      const requestedId = ++requestId;
      const response = await fetchAudio(track.run_key);
      if (requestedId !== requestId) return null;
      if (!response.ok) throw new Error('Private audio could not be loaded');

      const url = createObjectURL(await response.blob());
      if (requestedId !== requestId) {
        revokeObjectURL(url);
        return null;
      }
      return url;
    },
  };
}

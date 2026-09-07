export const RECOGNITION_MODES = ['whole', 'compressed', 'timed'];
export const MODE_LABELS = {whole:'整段直传', compressed:'分段识别', timed:'兼容识别'};

export function fallbackModes(mode) {
  return RECOGNITION_MODES.slice(Math.max(0, RECOGNITION_MODES.indexOf(mode)));
}

export function canFallback(error) {
  // A different audio format cannot fix credentials, billing, rate limits or a missing model.
  return error?.name !== 'AbortError' && ![401, 402, 403, 404, 429].includes(error?.status);
}

export async function withRecognitionFallback(mode, signal, attempt, onFallback=()=>{}) {
  const modes=fallbackModes(mode);
  for(let i=0;i<modes.length;i++) {
    signal?.throwIfAborted();
    try {return await attempt(modes[i]);}
    catch(error) {
      signal?.throwIfAborted();
      if(i===modes.length-1 || !canFallback(error)) throw error;
      onFallback(modes[i],modes[i+1],error);
    }
  }
}

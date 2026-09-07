import { requestJSON } from './network.js';
import { validateBaseUrl } from './settings.js';

// Starter choices; the account's refreshed speech-to-text list is authoritative.
// Qwen availability was confirmed in the user's account on 2026-09-07.
export const ASR_MODELS = ['Qwen/Qwen3-ASR-1.7B','FunAudioLLM/SenseVoiceSmall','TeleAI/TeleSpeechASR'];
export const TRANSLATION_MODELS = [
  'deepseek-ai/DeepSeek-V4-Flash','Pro/deepseek-ai/DeepSeek-V4','Pro/zai-org/GLM-5.2',
  'moonshotai/Kimi-K2.7-Code','Qwen/Qwen2.5-7B-Instruct',
];

export function modelIds(response) {
  if(!Array.isArray(response?.data)) throw new Error('服务未返回模型列表。');
  return [...new Set(response.data.map(model=>model.id).filter(id=>typeof id==='string' && id.length>0 && id.length<=200))].sort();
}

export async function fetchModels(baseUrl,apiKey,kind) {
  const base=validateBaseUrl(baseUrl);
  if(!apiKey.trim()) throw new Error('请先填写 API 密钥。');
  const siliconflow=new URL(base).hostname==='api.siliconflow.cn';
  const suffix=siliconflow?`?sub_type=${kind==='asr'?'speech-to-text':'chat'}`:'';
  const response=await requestJSON(`${base}/models${suffix}`,{headers:{Authorization:`Bearer ${apiKey.trim()}`}},{timeout:20000,retries:0,label:'模型列表'});
  return modelIds(response);
}

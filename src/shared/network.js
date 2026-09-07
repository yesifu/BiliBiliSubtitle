export function abortError() { return new DOMException('任务已取消。','AbortError'); }
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve,reject) => {
    const stop = () => {clearTimeout(timer);reject(abortError());};
    const timer = setTimeout(() => {signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}

export async function request(url, options = {}, {signal, timeout=90000, retries=2, label='接口'} = {}) {
  for (let attempt=0;attempt<=retries;attempt++) {
    checkAbort(signal);
    const local = new AbortController();
    let timedOut = false;
    const forward = () => local.abort();
    signal?.addEventListener('abort',forward,{once:true});
    const timer = setTimeout(() => {timedOut=true;local.abort();},timeout);
    try {
      const response = await fetch(url,{...options,signal:local.signal});
      if ((response.status===429 || response.status>=500) && attempt<retries) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after'));
        await delay(Math.min(20000,Math.max(1000,retryAfter*1000 || 1500*2**attempt)),signal);
        continue;
      }
      if (!response.ok) {
        // Do not echo provider bodies: some gateways include the Authorization header.
        const detail = response.status===401 ? 'API Key 无效或已过期' : response.status===403 ? '无权限访问或来源被拒绝' : response.status===429 ? '接口限流或额度不足' : response.status===413 ? '音频超过接口大小限制' : '接口请求失败';
        const error=new Error(`${label} · ${new URL(url).hostname}：${detail}（HTTP ${response.status}）。`);
        error.status=response.status;
        throw error;
      }
      // Consume JSON before timeout cancellation is cleared; audio uses a separate streaming reader.
      if (options.responseType === 'json') return await response.json();
      return response;
    } catch(error) {
      checkAbort(signal);
      if (timedOut) {
        const error=new Error(`${label}超时：${new URL(url).hostname}${new URL(url).pathname} 已等待 ${Math.round(timeout/1000)} 秒。`);
        error.code='TIMEOUT';
        throw error;
      }
      if (error instanceof TypeError && attempt<retries) {await delay(1000*2**attempt,signal);continue;}
      if (error instanceof TypeError) throw new Error(`${new URL(url).hostname}：网络请求失败，请检查网络与该服务的访问权限。`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',forward);
    }
  }
}

export async function requestJSON(url,options={},config={}) {
  return request(url,{...options,responseType:'json'},config);
}

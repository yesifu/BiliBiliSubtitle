import { selectableItems, itemKey } from './shared/selection.js';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "options-button", "inline-options-button", "context-loading", "context-empty", "empty-title",
  "empty-description", "context-retry", "video-card", "video-cover", "video-duration", "video-title",
  "video-meta", "generate-form", "scope-select", "scope-help", "collection-count", "force-checkbox",
  "start-button", "start-label", "action-message", "action-error", "job-card", "job-title", "job-state",
  "job-phase", "job-percent", "job-progress", "job-count", "job-current-title", "job-detail", "job-error",
  "job-stats", "cancel-button", "results-details", "results-summary", "results-list", "status-error",
  "track-card", "track-badge", "track-description", "track-info", "track-language", "track-timing", "track-timing-note",
  "track-preview", "export-actions", "export-srt", "export-vtt", "track-retry",
  "translation-toggle", "translation-help",
  "auto-toggle", "follow-toggle", "auto-status", "selection-panel", "selection-search", "selection-list", "selection-count", "select-all", "select-none",
].map((id) => [id, $(id)]));

const state = {
  closed: false, tabId: null, url: "", context: null, contextGeneration: 0,
  track: null, trackLoading: false, trackGeneration: 0,
  job: null, statusKnown: false, statusBusy: false, statusVersion: 0,
  action: "", exporting: false, resultSignature: "", trackJobSignature: "",
  poll: 0, refreshTimer: 0, openedResultsKey: "", downloadUrls: new Map(),
  preferences: null, preferenceLoading: false,
  selected: new Set(),
};

const PHASES = {
  queued: "任务已排队", metadata: "读取视频信息", downloading: "下载音频", decoding: "解码音频",
  preparing_audio: "整理压缩音轨", uploading: "上传音轨",
  transcribing: "识别语音", translating: "翻译字幕", saving: "保存字幕", completed: "处理完成", failed: "处理失败", cancelled: "任务已停止",
};
const STATES = { running: "进行中", completed: "已完成", cancelled: "已取消", failed: "失败" };
const RESULT_STATES = { completed: "已生成", cached: "已缓存", skipped: "原生字幕，已跳过", failed: "失败" };
const TIMINGS = { native: "原生时间轴", precise: "精确时间轴", approximate: "估算时间轴", "whole-approximate": "整段粗略时间轴" };
const TIMING_NOTES = {
  approximate: "时间按分段估算，可能不同步，可在播放器中调整延迟。",
  "whole-approximate": "时间按全片估算，可能不同步。WAV 分段可细化估算。",
};

function text(node, value) {
  const next = String(value ?? "");
  if (node.textContent !== next) node.textContent = next;
}

function errorText(error) {
  if (typeof error === "string" && error) return error;
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof error?.error === "string" && error.error) return error.error;
  return "操作未完成，请稍后重试。";
}

async function request(message) {
  let timer;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("后台响应超时；任务可能仍在继续，请刷新状态后再试。")), 30000);
      }),
    ]);
    if (!response?.ok) throw new Error(errorText(response?.error));
    return response.data;
  } finally { clearTimeout(timer); }
}

function notice(id, message) {
  text(ui[id], message);
  ui[id].hidden = !message;
}

function isVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://www.bilibili.com" && /^\/video\/[^/]+/.test(parsed.pathname);
  } catch { return false; }
}

function durationLabel(value) {
  const duration = Math.floor(Number(value));
  if (!Number.isFinite(duration) || duration < 0) return "";
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor(duration % 3600 / 60);
  const seconds = String(duration % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function elapsedLabel(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `耗时 ${durationLabel(value)}` : "";
}

function coverUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, "https://www.bilibili.com");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.protocol = "https:";
    return url.href;
  } catch { return ""; }
}

function groups() {
  return {
    pages: Array.isArray(state.context?.groups?.pages) ? state.context.groups.pages : [],
    season: Array.isArray(state.context?.groups?.season) ? state.context.groups.season : [],
  };
}

function scopeCount() {
  const scope=ui['scope-select'].value;
  return scope==='selected'?state.selected.size:scope==='current'?1:groups()[scope]?.length || 0;
}

function filteredItems() {
  if(!state.context) return [];
  const query=ui['selection-search'].value.trim().toLowerCase();
  return selectableItems(state.context).filter(item=>!query || `${item.title} p${item.page}`.toLowerCase().includes(query));
}

function renderSelection() {
  text(ui['selection-count'],`已选 ${state.selected.size} 个`);
  const fragment=document.createDocumentFragment();
  for(const item of filteredItems()) {
    const label=document.createElement('label');label.className='selection-item';
    const input=document.createElement('input');input.type='checkbox';input.value=itemKey(item);input.checked=state.selected.has(input.value);
    const title=document.createElement('span');title.textContent=item.title;title.title=item.title;
    label.append(input,title);fragment.append(label);
  }
  ui['selection-list'].replaceChildren(fragment);updateButtons();
}

function saveSelection() {
  if(state.context) void chrome.storage.session.set({[`selection:${state.context.bvid}`]:[...state.selected]});
  renderSelection();updateScope();
}

async function toggleAutomatic(key,id) {
  if(state.action || !state.preferences) return;
  const previous=state.preferences;
  const enabled=ui[id].checked;
  state.preferences={...previous,[key]:enabled};state.action='automatic';updateButtons();
  try {
    state.preferences=await request({type:'SET_AUTO_PREFERENCE',key,enabled});
    notice('action-error','');
    notice('action-message',`${key==='autoEnabled'?'全自动识别':'下一 P 跟随识别'}已${enabled?'开启':'关闭'}。`);
  } catch(error) {state.preferences=previous;notice('action-error',errorText(error));}
  finally {state.action='';updateButtons();void pollStatus();}
}

function updateScope() {
  const scope = ui["scope-select"].value;
  const count = scopeCount();
  ui['selection-panel'].hidden=scope!=='selected';
  let help = scope === "current"
    ? "复用已有结果，字幕就绪后自动显示。"
    : `处理 ${count} 个视频，自动复用缓存。${count > 500 ? "单次最多 500 个，请减少选择。" : ""}`;
  if (ui["force-checkbox"].checked) help = "重新调用接口生成字幕，会再次消耗配额。" + (scope === "current" ? "" : `共 ${count} 个视频。`);
  text(ui["scope-help"], help);
  updateButtons();
}

function updateButtons() {
  const running = state.job?.state === "running";
  const scope = ui["scope-select"].value;
  const count = scopeCount();
  ui["start-button"].disabled = !state.context || !state.statusKnown || !state.preferences || running || Boolean(state.action) || count === 0 || count>500;
  for(const [id,key] of [['auto-toggle','autoEnabled'],['follow-toggle','followNext']]) {
    ui[id].disabled=!state.preferences || Boolean(state.action);
    ui[id].checked=Boolean(state.preferences?.[key]);
  }
  for(const input of ui['selection-panel'].querySelectorAll('input,button')) input.disabled=running || Boolean(state.action);
  ui["translation-toggle"].disabled = !state.preferences || Boolean(state.action) || (running && !state.preferences.translateEnabled);
  ui["translation-toggle"].checked = Boolean(state.preferences?.translateEnabled);
  text(ui["translation-help"], state.preferences?.translateEnabled ? state.preferences.targetLanguage : "仅原文");
  ui["scope-select"].disabled = running || Boolean(state.action);
  ui["force-checkbox"].disabled = running || Boolean(state.action);
  text(ui["start-label"], state.action === "start" ? "正在创建任务…" : running ? "后台正在生成字幕" :
    !state.statusKnown ? "正在同步任务状态…" : scope === "current" ? state.preferences?.translateEnabled ? "生成并翻译字幕" : "生成原文字幕" : `生成 ${count} 个视频的字幕`);
  ui["cancel-button"].hidden = !running;
  ui["cancel-button"].disabled = Boolean(state.action);
  text(ui["cancel-button"], state.action === "cancel" ? "正在取消…" : "取消任务");
  for (const id of ["export-srt", "export-vtt"]) {
    ui[id].disabled = state.exporting || state.trackLoading || !state.track?.cues?.length;
  }
}

async function loadContext() {
  const generation = ++state.contextGeneration;
  ++state.trackGeneration;
  state.context = null;
  state.track = null;
  state.trackLoading = false;
  state.trackJobSignature = "";
  ui["context-loading"].hidden = false;
  ui["context-empty"].hidden = true;
  ui["video-card"].hidden = true;
  ui["generate-form"].hidden = true;
  ui["track-card"].hidden = true;
  ui["context-retry"].disabled = true;
  notice("action-error", "");
  notice("action-message", "");
  updateButtons();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (state.closed || generation !== state.contextGeneration) return;
    state.tabId = tab?.id ?? null;
    state.url = tab?.url || "";
    if (!isVideoUrl(state.url)) {
      text(ui["empty-title"], "打开哔哩哔哩视频");
      text(ui["empty-description"], "进入 B 站视频页后，再打开插件。");
      ui["context-empty"].hidden = false;
      return;
    }
    const context = await request({ type: "GET_VIDEO_CONTEXT", url: state.url });
    if (state.closed || generation !== state.contextGeneration) return;
    if (!context?.bvid || context.cid == null) throw new Error("未能识别视频信息，请等待播放器加载后重试。");
    state.context = context;
    text(ui["video-title"], context.title || "未命名视频");
    ui["video-title"].title = context.title || "未命名视频";
    text(ui["video-meta"], `${context.bvid}${context.page ? ` · P${context.page}` : ""}`);
    const duration = durationLabel(context.duration);
    text(ui["video-duration"], duration);
    ui["video-duration"].hidden = !duration;
    const cover = coverUrl(context.cover);
    ui["video-cover"].hidden = true;
    ui["video-cover"].removeAttribute("src");
    if (cover) ui["video-cover"].src = cover;
    const { pages, season } = groups();
    text(ui["collection-count"], `${pages.length} 个分 P · ${season.length} 个合集视频`);
    const currentOption = ui["scope-select"].querySelector('[value="current"]');
    const pagesOption = ui["scope-select"].querySelector('[value="pages"]');
    const seasonOption = ui["scope-select"].querySelector('[value="season"]');
    text(currentOption, context.page ? `当前视频 · P${context.page}` : "当前视频");
    text(pagesOption, pages.length ? `全部分 P · ${pages.length} 个视频` : "全部分 P · 未检测到");
    text(seasonOption, season.length ? `整个合集 · ${season.length} 个视频` : "整个合集 · 未检测到");
    pagesOption.disabled = pages.length === 0;
    seasonOption.disabled = season.length === 0;
    ui["scope-select"].value = "current";
    state.selected=new Set([itemKey(context)]);
    const stored=(await chrome.storage.session.get(`selection:${context.bvid}`))[`selection:${context.bvid}`];
    if(state.closed || generation!==state.contextGeneration) return;
    if(Array.isArray(stored)) {
      const valid=new Set(selectableItems(context).map(itemKey));
      state.selected=new Set(stored.filter(key=>valid.has(key)));
    }
    ui['selection-search'].value='';renderSelection();
    ui["force-checkbox"].checked = false;
    ui["video-card"].hidden = false;
    ui["generate-form"].hidden = false;
    ui["context-loading"].hidden = true;
    updateScope();
    await loadTrack();
  } catch (error) {
    if (state.closed || generation !== state.contextGeneration) return;
    text(ui["empty-title"], "暂时无法识别视频");
    text(ui["empty-description"], errorText(error));
    ui["context-empty"].hidden = false;
  } finally {
    if (!state.closed && generation === state.contextGeneration) {
      ui["context-loading"].hidden = true;
      ui["context-retry"].disabled = false;
      updateButtons();
    }
  }
}

function renderTrack() {
  const track = state.track;
  const cues = Array.isArray(track?.cues) ? track.cues : [];
  const available = cues.length > 0;
  ui["track-card"].hidden = !state.context;
  ui["track-badge"].className = `badge ${available ? "completed" : "neutral"}`;
  text(ui["track-badge"], available ? !track.targetLanguage ? "原文字幕" : track.settings?.bilingual ? "双语字幕" : "单语字幕" : track ? "空字幕" : "尚未生成");
  text(ui["track-description"], available ? track.translationPending ? `${cues.length} 条原文可用，翻译未完成。` : `${cues.length} 条字幕，可播放或导出。` :
    track ? "字幕为空，请勾选「忽略缓存」重新生成。" : "点击上方按钮生成字幕。");
  ui["track-info"].hidden = !available;
  text(ui["track-language"], track?.targetLanguage ? `目标语言 · ${track.targetLanguage}` : "原文字幕 · 未翻译");
  text(ui["track-timing"], TIMINGS[track?.timing] || "时间轴未标注");
  const timingNote = TIMING_NOTES[track?.timing] || "";
  text(ui["track-timing-note"], timingNote);
  ui["track-timing-note"].hidden = !available || !timingNote;
  const first = cues.find((cue) => typeof cue?.text === "string" && cue.text.trim())
    || cues.find((cue) => typeof cue?.source === "string" && cue.source.trim());
  const preview = first ? (first.text || first.source) : "";
  text(ui["track-preview"], preview);
  ui["track-preview"].hidden = !preview;
  ui["export-actions"].hidden = !available;
  ui["track-retry"].hidden = true;
  updateButtons();
}

async function loadTrack() {
  if (!state.context || state.closed) return;
  const context = state.context;
  const contextGeneration = state.contextGeneration;
  const generation = ++state.trackGeneration;
  state.trackLoading = true;
  state.track = null;
  ui["track-card"].hidden = false;
  ui["track-card"].setAttribute("aria-busy", "true");
  text(ui["track-badge"], "读取中");
  ui["track-badge"].className = "badge neutral";
  text(ui["track-description"], "正在读取字幕缓存…");
  for (const id of ["track-info", "track-timing-note", "track-preview", "export-actions", "track-retry"]) ui[id].hidden = true;
  updateButtons();
  try {
    const track = await request({ type: "GET_TRACK", bvid: context.bvid, cid: context.cid });
    if (state.closed || generation !== state.trackGeneration || contextGeneration !== state.contextGeneration) return;
    if (track && (track.bvid !== context.bvid || String(track.cid) !== String(context.cid))) {
      throw new Error("返回的字幕与当前视频不匹配，请重新读取。");
    }
    state.track = track;
    renderTrack();
  } catch (error) {
    if (state.closed || generation !== state.trackGeneration || contextGeneration !== state.contextGeneration) return;
    text(ui["track-badge"], "读取失败");
    ui["track-badge"].className = "badge failed";
    text(ui["track-description"], errorText(error));
    ui["track-retry"].hidden = false;
  } finally {
    if (!state.closed && generation === state.trackGeneration) {
      state.trackLoading = false;
      ui["track-card"].setAttribute("aria-busy", "false");
      updateButtons();
    }
  }
}

function renderResults(results, finished) {
  const signature = `${finished}:${JSON.stringify(results)}`;
  if (signature === state.resultSignature) return;
  state.resultSignature = signature;
  ui["results-details"].hidden = results.length === 0;
  const failures = results.filter((result) => result.status === "failed").length;
  text(ui["results-summary"], failures ? `${failures} 项失败 · 查看全部 ${results.length} 项结果` : `查看处理结果 · ${results.length} 项`);
  const fragment = document.createDocumentFragment();
  const ordered = finished ? [...results].sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed")) : results;
  for (const result of ordered) {
    const item = document.createElement("li");
    item.className = "result-item";
    const title = document.createElement("span");
    title.className = "result-title";
    text(title, result.title || result.bvid || "未命名视频");
    title.title = title.textContent;
    const status = document.createElement("span");
    status.className = `result-status${result.status === "failed" ? " failed" : ""}`;
    text(status, [RESULT_STATES[result.status] || "已处理", elapsedLabel(result.elapsedSeconds)].filter(Boolean).join(" · "));
    item.append(title, status);
    const failed = result.status === "failed";
    const phase = typeof result.phase === "string" && result.phase ? PHASES[result.phase] || result.phase : "";
    const detail = typeof result.detail === "string" ? result.detail.trim() : "";
    const message = result.error ? errorText(result.error) : "";
    const parts = [
      failed ? `失败阶段：${phase || "未记录"}` : phase ? `阶段：${phase}` : "",
      detail, message !== detail ? message : "",
    ].filter(Boolean);
    if (parts.length) {
      const description = document.createElement("span");
      description.className = failed || result.error ? "result-error" : "field-help";
      description.style.gridColumn = "1 / -1";
      text(description, parts.join(" · "));
      item.append(description);
    }
    fragment.append(item);
  }
  ui["results-list"].replaceChildren(fragment);
}

function renderJobDetail(job) {
  const defaultDetails = {
    running: "正在后台处理，关闭面板不会中断任务。",
    completed: "处理已结束，已生成的字幕会自动载入播放器。",
    cancelled: "任务已取消，已保存的字幕仍可使用。",
    failed: "请检查失败阶段与错误信息后重试；已成功识别的检查点可复用，已保存的字幕仍可使用。",
  };
  const startedAt = job.phaseStartedAt;
  const waiting = job.state === "running" && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0
    ? `本阶段等待 ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s` : "";
  text(ui["job-detail"], [job.detail || defaultDetails[job.state] || defaultDetails.failed,
    elapsedLabel(job.elapsedSeconds), waiting].filter(Boolean).join(" · "));
}

function renderJob() {
  const job = state.job;
  ui["job-card"].hidden = !job;
  if (!job) { updateButtons(); return; }
  const jobState = Object.hasOwn(STATES, job.state) ? job.state : "failed";
  const results = Array.isArray(job.results) ? job.results.filter((result) => result && typeof result === "object") : [];
  const completed = results.filter((result) => result.status === "completed").length;
  const cached = results.filter((result) => result.status === "cached").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const failedResult = results.find((result) => result.status === "failed");
  const failedPhase = jobState === "failed" && job.phase && !["failed", "cancelled", "completed"].includes(job.phase)
    ? job.phase : failedResult?.phase;
  const failureStage = typeof failedPhase === "string" && failedPhase ? PHASES[failedPhase] || failedPhase : "";
  const partialFailure = jobState === "completed" && failed > 0;
  text(ui["job-state"], partialFailure ? "部分失败" : STATES[jobState]);
  ui["job-state"].className = `badge ${partialFailure ? "failed" : jobState}`;
  text(ui["job-title"], jobState === "running" ? job.automatic ? job.autoKind==='next'?'下一 P 预识别':'自动识别进度' : "生成进度" : "最近任务");
  text(ui["job-phase"], partialFailure ? "处理结束 · 有失败项" : jobState === "cancelled" ? "任务已停止" : jobState === "failed" ? failureStage ? `${failureStage} · 失败` : "任务未完成" : PHASES[job.phase] || "正在处理");
  const progress = jobState === "completed" ? 1 : Math.min(1, Math.max(0, Number(job.progress) || 0));
  ui["job-progress"].value = progress;
  text(ui["job-percent"], `${Math.round(progress * 100)}%`);
  const total = Math.max(0, Math.floor(Number(job.total) || 0));
  const index = Math.min(total, Math.max(0, Math.floor(Number(job.currentIndex) || 0)));
  text(ui["job-count"], total ? `${index} / ${total}` : "排队中");
  text(ui["job-current-title"], job.currentTitle || "等待视频信息");
  ui["job-current-title"].title = job.currentTitle || "";
  renderJobDetail(job);
  const jobError = job.error || (jobState === "failed" ? failedResult?.error : null);
  text(ui["job-error"], jobError ? [jobState === "failed" && failureStage ? `失败阶段：${failureStage}` : "", errorText(jobError)].filter(Boolean).join(" · ") : "");
  ui["job-error"].hidden = !jobError;
  text(ui["job-stats"], `已生成 ${completed} · 缓存 ${cached}${skipped?` · 跳过 ${skipped}`:''} · 失败 ${failed}`);
  renderResults(results, jobState !== "running");
  const openedKey = `${job.id}:${jobState}`;
  if (failed && jobState !== "running" && state.openedResultsKey !== openedKey) {
    state.openedResultsKey = openedKey;
    ui["results-details"].open = true;
  }
  updateButtons();
}

function refreshTrackForJob() {
  if (!state.context || !state.job) return;
  const job = state.job;
  const matching = Array.isArray(job.results) ? job.results.find((result) => result &&
    result.bvid === state.context.bvid && String(result.cid) === String(state.context.cid)) : null;
  const signature = `${job.id}:${job.state}:${matching?.status || ""}`;
  if (signature === state.trackJobSignature) return;
  state.trackJobSignature = signature;
  if (["completed", "cached"].includes(matching?.status) || job.state !== "running") void loadTrack();
}

function acceptJob(job) {
  if (job?.id !== state.job?.id) {
    state.resultSignature = "";
    state.openedResultsKey = "";
    ui["results-details"].open = false;
  }
  state.job = job || null;
  state.statusKnown = true;
  notice("status-error", "");
  renderJob();
  refreshTrackForJob();
}

async function pollStatus() {
  if (state.closed || state.statusBusy || state.action) return;
  state.statusBusy = true;
  const version = state.statusVersion;
  try {
    const job = await request({ type: "GET_STATUS" });
    if (state.closed || version !== state.statusVersion) return;
    acceptJob(job);
    if(state.preferences?.autoEnabled || state.preferences?.followNext) {
      const auto=await request({type:'GET_AUTO_STATUS'});
      notice('auto-status',auto.error || (auto.queued?`${auto.queued} 个自动任务等待处理。`:''));
    } else notice('auto-status','');
  } catch (error) {
    if (state.closed || version !== state.statusVersion) return;
    // Disable starting another task until the backend state is known again.
    state.statusKnown = false;
    notice("status-error", `任务状态暂时不可用：${errorText(error)} 正在自动重试。`);
    updateButtons();
  } finally { state.statusBusy = false; }
}

async function startJob(event) {
  event.preventDefault();
  if (!state.context || !state.statusKnown || state.action || state.job?.state === "running") return;
  const url = state.url;
  const scope = ui["scope-select"].value;
  if (!["current", "pages", "season", "selected"].includes(scope) || !scopeCount()) return;
  state.action = "start";
  ++state.statusVersion;
  notice("action-error", "");
  notice("action-message", "");
  updateButtons();
  try {
    const job = await request({ type: "START_JOB", url, scope, selection:[...state.selected], force: ui["force-checkbox"].checked });
    if (state.closed) return;
    if (!job?.id) throw new Error("后台没有返回任务信息，正在重新同步状态。");
    acceptJob(job);
    notice("action-message", job.state === "running" ? "任务已开始。无需播放视频，可关闭此面板。" : "任务状态已更新。");
  } catch (error) {
    if (state.closed) return;
    state.statusKnown = false;
    notice("action-error", errorText(error));
  } finally {
    state.action = "";
    updateButtons();
    if (!state.closed) void pollStatus();
  }
}

async function cancelJob() {
  if (state.action || state.job?.state !== "running") return;
  state.action = "cancel";
  ++state.statusVersion;
  notice("action-error", "");
  notice("action-message", "");
  updateButtons();
  try {
    const job = await request({ type: "CANCEL_JOB" });
    if (state.closed) return;
    if (job?.id && job.state) acceptJob(job);
    notice("action-message", "取消请求已发送，已保存的字幕仍可使用。");
  } catch (error) {
    if (!state.closed) notice("action-error", errorText(error));
  } finally {
    state.action = "";
    updateButtons();
    if (!state.closed) void pollStatus();
  }
}

async function exportTrack(format) {
  if (!state.context || !state.track?.cues?.length || state.trackLoading || state.exporting) return;
  const { bvid, cid } = state.context;
  const generation = state.contextGeneration;
  state.exporting = true;
  notice("action-error", "");
  notice("action-message", "");
  updateButtons();
  try {
    const output = await request({ type: "EXPORT_TRACK", bvid, cid, format });
    if (state.closed || generation !== state.contextGeneration) return;
    if (typeof output?.content !== "string" || !output.content.trim()) throw new Error("后台未返回有效的字幕文件，请重新生成后再试。");
    const mime = format === "vtt" ? "text/vtt" : "application/x-subrip";
    const blob = new Blob([output.content], { type: `${output.mime === mime ? output.mime : mime};charset=utf-8` });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    const filename = typeof output.filename === "string" ? output.filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") : "";
    anchor.download = filename || `${bvid}-${cid}.${format}`;
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
      notice("action-message", `${format.toUpperCase()} 字幕下载已发起。`);
    } finally {
      anchor.remove();
      // Let Chrome consume the Blob before releasing it; also release on popup close.
      state.downloadUrls.set(objectUrl, setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        state.downloadUrls.delete(objectUrl);
      }, 10000));
    }
  } catch (error) {
    if (!state.closed && generation === state.contextGeneration) notice("action-error", errorText(error));
  } finally { state.exporting = false; updateButtons(); }
}

async function openOptions() {
  try { await chrome.runtime.openOptionsPage(); }
  catch (error) { if (!state.closed) notice("action-error", `无法打开设置：${errorText(error)}`); }
}

function scheduleTrackReload() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => { state.refreshTimer = 0; void loadTrack(); }, 120);
}

function onMessage(message) {
  if (message?.type === "TRACK_READY" && state.context && message.bvid === state.context.bvid &&
      String(message.cid) === String(state.context.cid)) scheduleTrackReload();
  else if (message?.type === "SETTINGS_UPDATED") { void loadPreferences(); scheduleTrackReload(); }
  return false;
}

function onStorage(changes) {
  if (Object.keys(changes).some((key) => /settings/i.test(key))) { void loadPreferences(); scheduleTrackReload(); }
}

async function loadPreferences() {
  if(state.closed || state.preferenceLoading || ['translation','automatic'].includes(state.action)) return;
  state.preferenceLoading=true;
  try {const preferences=await request({type:'GET_TRANSLATION_PREFERENCE'});if(!['translation','automatic'].includes(state.action)) state.preferences=preferences;}
  catch(error) {notice('action-error',errorText(error));}
  finally {state.preferenceLoading=false;updateButtons();}
}

async function toggleTranslation() {
  const enabled=ui['translation-toggle'].checked;
  if(state.action || !state.preferences) return;
  const previous=state.preferences;
  state.preferences={...previous,translateEnabled:enabled};
  state.action='translation';
  updateButtons();
  try {
    state.preferences=await request({type:'SET_TRANSLATION_PREFERENCE',enabled});
    notice('action-error','');
    notice('action-message',enabled?'翻译已开启。':'翻译已关闭，使用原文字幕。');
    await loadTrack();
  } catch(error) {state.preferences=previous;notice('action-error',errorText(error));}
  finally {state.action='';updateButtons();void pollStatus();}
}

function onTabUpdated(tabId, changeInfo) {
  if (tabId === state.tabId && changeInfo.url && changeInfo.url !== state.url) void loadContext();
}

function close() {
  state.closed = true;
  ++state.contextGeneration;
  ++state.trackGeneration;
  clearInterval(state.poll);
  clearTimeout(state.refreshTimer);
  for (const [url, timer] of state.downloadUrls) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
  state.downloadUrls.clear();
  chrome.runtime.onMessage.removeListener(onMessage);
  chrome.storage.onChanged.removeListener(onStorage);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
}

ui["video-cover"].addEventListener("load", () => { ui["video-cover"].hidden = false; });
ui["video-cover"].addEventListener("error", () => { ui["video-cover"].hidden = true; });
ui["options-button"].addEventListener("click", openOptions);
ui["inline-options-button"].addEventListener("click", openOptions);
ui["context-retry"].addEventListener("click", () => { void loadContext(); void pollStatus(); });
ui["track-retry"].addEventListener("click", () => void loadTrack());
ui["scope-select"].addEventListener("change", updateScope);
ui["force-checkbox"].addEventListener("change", updateScope);
ui["generate-form"].addEventListener("submit", startJob);
ui["translation-toggle"].addEventListener("change", toggleTranslation);
ui['auto-toggle'].addEventListener('change',()=>void toggleAutomatic('autoEnabled','auto-toggle'));
ui['follow-toggle'].addEventListener('change',()=>void toggleAutomatic('followNext','follow-toggle'));
ui['selection-search'].addEventListener('input',renderSelection);
ui['selection-list'].addEventListener('change',event=>{
  const input=event.target;
  if(input.type!=='checkbox') return;
  if(input.checked) state.selected.add(input.value);else state.selected.delete(input.value);
  saveSelection();
});
ui['select-all'].addEventListener('click',()=>{for(const item of filteredItems()) state.selected.add(itemKey(item));saveSelection();});
ui['select-none'].addEventListener('click',()=>{state.selected.clear();saveSelection();});
ui["cancel-button"].addEventListener("click", cancelJob);
ui["export-srt"].addEventListener("click", () => void exportTrack("srt"));
ui["export-vtt"].addEventListener("click", () => void exportTrack("vtt"));
chrome.runtime.onMessage.addListener(onMessage);
chrome.storage.onChanged.addListener(onStorage);
chrome.tabs.onUpdated.addListener(onTabUpdated);
window.addEventListener("pagehide", close, { once: true });
state.poll = setInterval(() => {
  if (state.job?.state === "running") renderJobDetail(state.job);
  void pollStatus();
}, 1000);
void pollStatus();
void loadPreferences();
void loadContext();

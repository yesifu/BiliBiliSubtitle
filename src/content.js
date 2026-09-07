(() => {
  "use strict";

  const INSTANCE_KEY = "__bstAiSubtitleOverlay";
  globalThis[INSTANCE_KEY]?.destroy();

  const PLAYER_SELECTOR = "#bilibili-player, .bpx-player-container";
  const AD_SELECTOR = [
    ".bpx-player-ad-video", ".bpx-player-ad-wrap", ".bpx-player-video-ad",
    ".bilibili-player-video-ad", ".bilibili-player-ad-video",
  ].join(", ");
  const SHADOW_CSS = `
    :host { all: initial; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .surface { position: absolute; inset: 0; pointer-events: none; color: #f8f5ee;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      text-align: left; letter-spacing: normal; direction: ltr; }
    button { appearance: none; margin: 0; font: inherit; color: inherit; cursor: pointer;
      border: 0; background: transparent; touch-action: manipulation; }
    button:focus-visible { outline: 2px solid #ff8888; outline-offset: 3px; }
    button:disabled { opacity: .4; cursor: default; }
    .captions { position: absolute; left: 50%; bottom: var(--bst-bottom, 62px);
      transform: translateX(-50%); width: max-content; max-width: 88%;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      text-align: center; font-size: var(--bst-font-size, 24px); line-height: 1.45;
      font-weight: 600; text-shadow: 0 1px 3px #000, 0 0 2px #000;
      pointer-events: none; overflow-wrap: anywhere; }
    .caption-line { max-width: 100%; white-space: pre-line; padding: 3px 12px;
      border-radius: 5px; background: rgb(12 13 16 / var(--bst-background-alpha, 76%)); box-decoration-break: clone; }
    .source { font-size: .73em; font-weight: 400; color: #e7e4de; }
    .controls { position: absolute; top: 16px; right: 16px; pointer-events: auto;
      max-width: calc(100% - 32px); }
    .toolbar { display: flex; justify-content: flex-end; gap: 1px; }
    .toggle, .settings-toggle { height: 30px; background: rgb(22 23 27 / 86%);
      border: 1px solid rgb(255 255 255 / 17%); }
    .toggle { display: inline-flex; align-items: center; gap: 7px; padding: 0 10px;
      border-radius: 7px 0 0 7px; font-size: 12px; font-weight: 600; }
    .toggle::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #ed4d4d; }
    .toggle[aria-pressed="false"]::before { background: #939398; }
    .toggle:hover, .settings-toggle:hover { background: #333337; }
    .toggle-status { color: #c3c0bb; font-size: 10px; font-weight: 400; }
    .settings-toggle { width: 31px; border-radius: 0 7px 7px 0; font-size: 20px; line-height: 1; }
    .panel { width: 258px; max-width: 100%; margin-top: 7px; padding: 15px;
      border: 1px solid #4a4742; border-radius: 10px; background: #242321;
      box-shadow: 0 10px 32px rgb(0 0 0 / 30%); }
    .panel-header { display: flex; align-items: center; justify-content: space-between; }
    .panel-title { font-size: 13px; font-weight: 650; letter-spacing: .5px; }
    .close { width: 24px; height: 24px; font-size: 19px; color: #aaa59b; border-radius: 4px; }
    .close:hover { background: #3b3833; }
    .status { margin: 9px 0 14px; color: #bdb7ac; font-size: 11px; line-height: 1.7; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 10px;
      min-height: 38px; border-top: 1px solid #403d37; }
    .row-label { font-size: 12px; }
    .stepper { display: flex; align-items: center; gap: 4px; }
    .stepper button { width: 28px; height: 28px; font-size: 18px; border-radius: 4px; }
    .stepper button:hover { background: #403b35; }
    .transparency-row { flex-wrap: wrap; padding-top: 9px; gap: 2px 10px; }
    .transparency-row input { width: 100%; height: 24px; margin: 0; accent-color: #ed7777; cursor: pointer; }
    .transparency-row input:focus-visible { outline: 2px solid #ff8888; outline-offset: 2px; }
    .transparency-row output { min-width: 36px; text-align: right; }
    output { display: inline-block; min-width: 51px; text-align: center; font-size: 12px;
      color: #f8efe1; font-variant-numeric: tabular-nums; }
    .hint { color: #a69f94; font-size: 10px; margin: 6px 0 12px; }
    .footer { display: flex; align-items: center; justify-content: space-between;
      padding-top: 10px; border-top: 1px solid #403d37; gap: 6px; }
    .text-button { font-size: 11px; color: #d5c9b6; padding: 3px 0; }
    .text-button:hover { color: #ff8888; }
    @media (max-width: 480px) { .captions { max-width: 94%; } }
  `;

  const state = {
    autoVisit: '',
    destroyed: false, url: "", generation: 0, trackRequest: 0,
    context: null, track: null, cues: [], maxEnds: [], loading: false, error: "",
    video: null, player: null, host: null, ui: null, unbind: null,
    enabled: true, delay: 0, fontOverride: null, adPlaying: false,
    backgroundTransparency: 24, displayRevision: 0, displayPending: false,
    displayHint: "100% 全透明，自动保存。",
    raf: 0, mutationTimer: 0, settingsTimer: 0, poll: 0,
    lastCaptionKey: "", lastStatus: "", anchorOwned: false,
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function errorText(error) {
    return typeof error === "string" ? error : error?.message || "暂时无法读取字幕，请稍后重试。";
  }

  async function request(message) {
    let timer;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("读取字幕超时，请稍后重试。")), 20000);
        }),
      ]);
      if (!response?.ok) throw new Error(errorText(response?.error));
      return response.data;
    } finally {
      clearTimeout(timer);
    }
  }

  function isVideoUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://www.bilibili.com" && /^\/video\/[^/]+/.test(parsed.pathname);
    } catch { return false; }
  }

  function currentRequest(generation, url) {
    return !state.destroyed && generation === state.generation && url === location.href;
  }

  function clearTrack() {
    state.track = null;
    state.cues = [];
    state.maxEnds = [];
    state.lastCaptionKey = "";
    hideCaptions();
  }

  async function navigate() {
    const url = location.href;
    const generation = ++state.generation;
    ++state.trackRequest;
    state.url = url;
    state.context = null;
    state.error = "";
    state.loading = isVideoUrl(url);
    state.delay = 0;
    state.fontOverride = null;
    clearTrack();
    detachPlayer();
    if (!state.loading) return;
    void loadDisplaySettings();
    reconcilePlayer();
    try {
      const context = await request({ type: "GET_VIDEO_CONTEXT", url });
      if (!currentRequest(generation, url)) return;
      if (!context?.bvid || context.cid == null) throw new Error("未能识别当前视频，请在扩展面板重试。");
      state.context = context;
      state.autoVisit = '';
      void reportAutoVisit();
      refreshAdState();
      await loadTrack();
    } catch (error) {
      if (!currentRequest(generation, url)) return;
      state.loading = false;
      state.error = errorText(error);
      updateControls();
    }
  }

  async function loadTrack() {
    if (!state.context || state.destroyed) return;
    const { generation, url, context } = state;
    const requestId = ++state.trackRequest;
    state.loading = true;
    state.error = "";
    updateControls();
    try {
      const track = await request({ type: "GET_TRACK", bvid: context.bvid, cid: context.cid });
      if (!currentRequest(generation, url) || requestId !== state.trackRequest) return;
      if (track && (track.bvid !== context.bvid || String(track.cid) !== String(context.cid))) {
        throw new Error("字幕与当前视频不匹配，请重新生成。");
      }
      const cues = (Array.isArray(track?.cues) ? track.cues : []).flatMap((cue) => {
        if (!cue || typeof cue !== "object") return [];
        const start = Number(cue.start);
        const end = Number(cue.end);
        const text = typeof cue.text === "string" ? cue.text.trim() : "";
        const source = typeof cue.source === "string" ? cue.source.trim() : "";
        return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && (text || source)
          ? [{ start, end, text, source }] : [];
      }).sort((a, b) => a.start - b.start || a.end - b.end);
      state.track = track;
      state.cues = cues;
      let maximum = -Infinity;
      state.maxEnds = cues.map((cue) => (maximum = Math.max(maximum, cue.end)));
      state.loading = false;
      state.lastCaptionKey = "";
      applyPresentation();
      render();
      syncAnimation();
    } catch (error) {
      if (!currentRequest(generation, url) || requestId !== state.trackRequest) return;
      state.loading = false;
      state.error = errorText(error);
      clearTrack();
      stopAnimation();
      updateControls();
    }
  }

  function mountPlayer(player) {
    const host = element("div");
    host.id = "bst-ai-subtitle-host";
    // Inline important declarations also cover players created before the manifest CSS loads.
    for (const [property, value] of Object.entries({
      all: "initial", position: "absolute", inset: "0", display: "block", width: "100%", height: "100%",
      margin: "0", padding: "0", border: "0", overflow: "visible", "pointer-events": "none",
      "z-index": "2147483000", isolation: "isolate", contain: "layout style",
    })) host.style.setProperty(property, value, "important");

    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = SHADOW_CSS;
    const surface = element("div", "surface");
    const captions = element("div", "captions");
    // Captions change frequently; a live region would interrupt screen-reader navigation.
    captions.setAttribute("role", "region");
    captions.setAttribute("aria-label", "AI 视频字幕");
    captions.hidden = true;
    const translated = element("div", "caption-line translation");
    const source = element("div", "caption-line source");
    captions.append(translated, source);

    const controls = element("div", "controls");
    const toolbar = element("div", "toolbar");
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "AI 字幕控制");
    const toggle = button("", "toggle", () => {
      state.enabled = !state.enabled;
      render();
      syncAnimation();
      if (!state.cues.length) setPanel(true);
    });
    toggle.append(element("span", "", "AI 字幕"));
    const toggleStatus = element("span", "toggle-status");
    toggle.append(toggleStatus);
    const settingsToggle = button("⋯", "settings-toggle", () => setPanel(state.ui.panel.hidden));
    settingsToggle.setAttribute("aria-label", "字幕显示设置");
    settingsToggle.setAttribute("aria-controls", "bst-ai-display-settings");
    settingsToggle.setAttribute("aria-expanded", "false");
    toolbar.append(toggle, settingsToggle);

    const panel = element("section", "panel");
    panel.id = "bst-ai-display-settings";
    panel.setAttribute("aria-label", "字幕显示设置");
    panel.hidden = true;
    const panelHeader = element("div", "panel-header");
    const close = button("×", "close", () => { setPanel(false); settingsToggle.focus(); });
    close.setAttribute("aria-label", "收起字幕设置");
    panelHeader.append(element("span", "panel-title", "字幕 · 显示设置"), close);
    const status = element("p", "status");
    status.setAttribute("role", "status");
    panel.append(panelHeader, status);

    function stepper(label, minusLabel, plusLabel, decrease, increase) {
      const row = element("div", "row");
      const group = element("div", "stepper");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      const minus = button("−", "", decrease);
      minus.setAttribute("aria-label", minusLabel);
      const plus = button("+", "", increase);
      plus.setAttribute("aria-label", plusLabel);
      const output = element("output");
      output.setAttribute("aria-label", label);
      group.append(minus, output, plus);
      row.append(element("span", "row-label", label), group);
      panel.append(row);
      return { output, minus, plus };
    }
    const delay = stepper("字幕延迟", "字幕提前 0.5 秒", "字幕延后 0.5 秒",
      () => adjustDelay(-0.5), () => adjustDelay(0.5));
    const font = stepper("字体大小", "缩小字幕字体", "放大字幕字体",
      () => adjustFont(-2), () => adjustFont(2));
    panel.append(element("p", "hint", "延迟正值让字幕晚出现；延迟和字号仅用于本页。"));
    const transparencyRow = element("div", "row transparency-row");
    const transparencyLabel = element("label", "row-label", "背景透明度");
    transparencyLabel.htmlFor = "bst-background-transparency";
    const transparency = element("input");
    transparency.id = "bst-background-transparency";
    transparency.type = "range";
    transparency.min = "0";
    transparency.max = "100";
    transparency.step = "1";
    const transparencyOutput = element("output");
    transparencyOutput.htmlFor = transparency.id;
    const transparencyHint = element("p", "hint");
    transparencyHint.id = "bst-transparency-hint";
    transparencyHint.setAttribute("role", "status");
    transparency.setAttribute("aria-describedby", transparencyHint.id);
    transparency.addEventListener("input", () => previewTransparency(transparency.valueAsNumber));
    transparency.addEventListener("change", () => { void saveTransparency(); });
    transparencyRow.append(transparencyLabel, transparencyOutput, transparency);
    panel.append(transparencyRow, transparencyHint);
    const footer = element("div", "footer");
    const reset = button("恢复显示默认值", "text-button", () => {
      state.delay = 0;
      state.fontOverride = null;
      previewTransparency(24);
      void saveTransparency();
      state.lastCaptionKey = "";
      applyPresentation();
      render();
    });
    const options = button("扩展设置 ↗", "text-button", async () => {
      try { await request({ type: "OPEN_OPTIONS" }); }
      catch (error) {
        if (state.ui?.status === status) status.textContent = errorText(error);
      }
    });
    const retry = button("重新读取", "text-button", () => {
      if (state.context && state.url === location.href) void loadTrack();
      else void navigate();
    });
    footer.append(reset, retry, options);
    panel.append(footer);
    controls.append(toolbar, panel);
    surface.append(captions, controls);
    shadow.append(style, surface);

    // Do not let player shortcuts turn a click/Space on our controls into playback or seeking.
    for (const eventName of ["click", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup"]) {
      controls.addEventListener(eventName, (event) => {
        event.stopPropagation();
        if (eventName === "keydown" && event.key === "Escape" && !panel.hidden) {
          setPanel(false);
          settingsToggle.focus();
        }
      });
    }

    state.anchorOwned = getComputedStyle(player).position === "static" && !player.hasAttribute("data-bst-ai-positioned");
    if (state.anchorOwned) player.setAttribute("data-bst-ai-positioned", "true");
    player.append(host);
    state.player = player;
    state.host = host;
    state.ui = { surface, captions, translated, source, toggle, toggleStatus, settingsToggle, panel, status, delay, font, transparency, transparencyOutput, transparencyHint };
    state.lastCaptionKey = "";
    state.lastStatus = "";
    applyPresentation();
    updateControls();
  }

  function setPanel(open) {
    if (!state.ui) return;
    state.ui.panel.hidden = !open;
    state.ui.settingsToggle.setAttribute("aria-expanded", String(open));
  }

  function fontSize() {
    return state.fontOverride ?? clamp(state.track?.settings?.fontSize, 14, 56, 24);
  }

  function applyPresentation() {
    if (!state.ui) return;
    state.ui.surface.style.setProperty("--bst-font-size", `${fontSize()}px`);
    state.ui.surface.style.setProperty("--bst-background-alpha", `${100 - state.backgroundTransparency}%`);
    const bottom = clamp(state.track?.settings?.bottomOffset, 0, 400, 62);
    state.ui.surface.style.setProperty("--bst-bottom", `min(${bottom}px, 65%)`);
    updateControls();
  }

  async function loadDisplaySettings() {
    if (state.destroyed || state.displayPending) return;
    const revision = ++state.displayRevision;
    try {
      const settings = await request({ type: "GET_DISPLAY_SETTINGS" });
      if (state.destroyed || revision !== state.displayRevision) return;
      state.backgroundTransparency = clamp(settings.backgroundTransparency, 0, 100, 24);
      applyPresentation();
    } catch { /* Keep the current appearance if the extension is temporarily unavailable. */ }
  }

  function previewTransparency(value) {
    ++state.displayRevision;
    state.displayPending = true;
    state.backgroundTransparency = Math.round(clamp(value, 0, 100, 24));
    state.displayHint = "100% 全透明，松开自动保存。";
    applyPresentation();
  }

  async function saveTransparency() {
    const revision = state.displayRevision;
    state.displayHint = "正在保存…";
    updateControls();
    try {
      await request({ type: "SET_BACKGROUND_TRANSPARENCY", value: state.backgroundTransparency });
      if (state.destroyed || revision !== state.displayRevision) return;
      state.displayPending = false;
      state.displayHint = "100% 全透明，已保存。";
    } catch {
      if (state.destroyed || revision !== state.displayRevision) return;
      state.displayPending = false;
      state.displayHint = "保存失败，请重新调整滑块重试。";
    }
    updateControls();
  }

  function adjustDelay(amount) {
    state.delay = Math.round(clamp(state.delay + amount, -30, 30, 0) * 2) / 2;
    state.lastCaptionKey = "";
    render();
  }

  function adjustFont(amount) {
    state.fontOverride = clamp(fontSize() + amount, 14, 56, 24);
    applyPresentation();
  }

  function updateControls() {
    const ui = state.ui;
    if (!ui) return;
    let badge = "已开启";
    let status = `已载入 ${state.cues.length} 条${state.track?.settings?.bilingual ? "双语" : "译文"}字幕。`;
    if (state.track?.timing === "approximate") status += "时间轴根据音频片段估算，可能与语音存在偏差，可调整延迟。";
    if (state.track?.timing === "whole-approximate") status += "整段识别未返回时间戳，当前时间轴按全文比例粗略估算；需要同步更准确时可改用压缩分段或带时间戳的识别接口。";
    if (!state.cues.length) {
      badge = "待生成";
      status = state.track ? "这份字幕没有可显示的内容，可在扩展面板重新生成。" : "尚无缓存字幕。点击浏览器工具栏中的扩展，生成后会自动显示。";
    }
    if (state.loading) { badge = "读取中"; status = "正在读取当前视频的字幕…"; }
    if (state.error) { badge = "读取失败"; status = state.error; }
    if (!state.enabled) { badge = "已关闭"; status = "AI 字幕已隐藏，点击「AI 字幕」重新开启。"; }
    if (state.adPlaying) { badge = "等待正片"; status = "广告或非正片播放期间，AI 字幕暂时隐藏。"; }
    if (badge !== ui.toggleStatus.textContent) ui.toggleStatus.textContent = badge;
    if (status !== state.lastStatus) { ui.status.textContent = status; state.lastStatus = status; }
    ui.toggle.setAttribute("aria-pressed", String(state.enabled));
    ui.toggle.setAttribute("aria-label", `${state.enabled ? "隐藏" : "显示"} AI 字幕，${badge}`);
    ui.toggle.title = status;
    ui.delay.output.textContent = `${state.delay > 0 ? "+" : ""}${state.delay.toFixed(1)} s`;
    ui.delay.minus.disabled = state.delay <= -30;
    ui.delay.plus.disabled = state.delay >= 30;
    ui.font.output.textContent = `${fontSize()} px`;
    ui.font.minus.disabled = fontSize() <= 14;
    ui.font.plus.disabled = fontSize() >= 56;
    ui.transparency.value = String(state.backgroundTransparency);
    ui.transparency.setAttribute("aria-valuetext", `${state.backgroundTransparency}%${state.backgroundTransparency === 100 ? "，全透明" : ""}`);
    ui.transparencyOutput.textContent = `${state.backgroundTransparency}%`;
    ui.transparencyHint.textContent = state.displayHint;
  }

  function hideCaptions() {
    if (!state.ui) return;
    state.ui.captions.hidden = true;
    state.ui.translated.textContent = "";
    state.ui.source.textContent = "";
    state.lastCaptionKey = "";
  }

  // Upper-bound lookup works after arbitrary seeks. Prefix end times also support overlapping cues.
  function activeCueIndices(time) {
    let low = 0;
    let high = state.cues.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (state.cues[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    const indices = [];
    for (let index = low - 1; index >= 0 && state.maxEnds[index] > time; index--) {
      if (state.cues[index].end > time) indices.push(index);
    }
    return indices.reverse();
  }

  function renderCaptions() {
    const { video, ui } = state;
    if (!ui) return;
    if (!video || !video.isConnected || !state.enabled || state.adPlaying || !state.cues.length ||
        state.url !== location.href || video.ended || video.readyState < 1 ||
        (Number.isFinite(video.duration) && video.currentTime >= video.duration)) {
      if (!ui.captions.hidden) hideCaptions();
      return;
    }
    const time = video.currentTime - state.delay;
    const indices = activeCueIndices(time);
    if (!indices.length) {
      if (!ui.captions.hidden) hideCaptions();
      return;
    }
    const bilingual = state.track?.settings?.bilingual === true;
    const key = `${bilingual}:${indices.join(",")}`;
    if (state.lastCaptionKey === key && !ui.captions.hidden) return;
    state.lastCaptionKey = key;
    const cues = indices.map((index) => state.cues[index]);
    ui.translated.textContent = cues.map((cue) => cue.text || cue.source).join("\n");
    const source = bilingual ? cues.filter((cue) => cue.source && cue.source !== cue.text && cue.text).map((cue) => cue.source).join("\n") : "";
    ui.source.textContent = source;
    ui.source.hidden = !source;
    ui.captions.hidden = false;
  }

  function render() { renderCaptions(); updateControls(); }

  function stopAnimation() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function shouldAnimate() {
    return !state.destroyed && state.video?.isConnected && !state.video.paused && !state.video.ended &&
      state.enabled && state.cues.length > 0 && !state.adPlaying && !document.hidden && state.url === location.href;
  }

  function tick() {
    state.raf = 0;
    renderCaptions();
    if (shouldAnimate()) state.raf = requestAnimationFrame(tick);
  }

  function syncAnimation() {
    if (!shouldAnimate()) stopAnimation();
    else if (!state.raf) state.raf = requestAnimationFrame(tick);
  }

  function visible(node) {
    if (!node.isConnected || node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function refreshAdState() {
    const { video, player, context } = state;
    let ad = false;
    if (video && player) {
      ad = Boolean(video.closest(AD_SELECTOR)) || Boolean(player.closest(
        '.bpx-state-ad, .bpx-player-state-ad, [data-ad-playing="true"]',
      ));
      if (!ad) ad = Array.from(player.querySelectorAll(AD_SELECTOR)).some((node) =>
        visible(node) && (node.tagName === "VIDEO" || node.childElementCount > 0 || Boolean(node.textContent.trim())),
      );
      // Some prerolls reuse the main <video> without an ad class. Suppress clearly shorter assets.
      const expected = Number(context?.duration);
      if (!ad && expected > 0 && Number.isFinite(video.duration) && video.duration > 0) {
        ad = video.duration <= 120 && video.duration < expected * 0.8 && expected - video.duration > 15;
      }
    }
    if (state.adPlaying !== ad) {
      state.adPlaying = ad;
      render();
      syncAnimation();
    }
  }

  function detachPlayer() {
    stopAnimation();
    state.unbind?.();
    state.unbind = null;
    state.host?.remove();
    if (state.anchorOwned && state.player?.getAttribute("data-bst-ai-positioned") === "true") {
      state.player.removeAttribute("data-bst-ai-positioned");
    }
    state.video = null;
    state.player = null;
    state.host = null;
    state.ui = null;
    state.anchorOwned = false;
    state.adPlaying = false;
  }

  function bindVideo(video, player) {
    detachPlayer();
    state.video = video;
    mountPlayer(player);
    const onTimeline = () => { renderCaptions(); syncAnimation(); };
    const onMedia = () => { refreshAdState(); render(); syncAnimation(); void reportAutoVisit(); };
    const onEmpty = () => { hideCaptions(); stopAnimation(); };
    const bindings = [
      ["timeupdate", onTimeline], ["seeking", onTimeline], ["seeked", onTimeline],
      ["play", onMedia], ["playing", onMedia], ["pause", onMedia], ["ended", onMedia],
      ["loadedmetadata", onMedia], ["durationchange", onMedia], ["loadeddata", onMedia],
      ["emptied", onEmpty], ["loadstart", onEmpty], ["error", onEmpty],
    ];
    for (const [event, handler] of bindings) video.addEventListener(event, handler);
    state.unbind = () => {
      for (const [event, handler] of bindings) video.removeEventListener(event, handler);
    };
    onMedia();
  }

  function reconcilePlayer() {
    if (state.destroyed || !isVideoUrl(location.href)) return;
    if (state.url !== location.href) { void navigate(); return; }
    const videos = Array.from(document.querySelectorAll("#bilibili-player video, .bpx-player-container video"))
      .filter((video) => !video.closest(AD_SELECTOR));
    const video = videos.find((candidate) => visible(candidate) && !candidate.paused)
      || videos.find(visible) || videos[0];
    // closest() keeps the host inside Bilibili's actual player/fullscreen subtree.
    const player = video?.closest(PLAYER_SELECTOR);
    if (!video || !player) { if (state.video) detachPlayer(); return; }
    if (video !== state.video || player !== state.player || !state.host?.isConnected || state.host.parentElement !== player) {
      bindVideo(video, player);
    } else {
      refreshAdState();
    }
  }

  const observer = new MutationObserver(() => {
    if (state.destroyed || state.mutationTimer) return;
    state.mutationTimer = setTimeout(() => {
      state.mutationTimer = 0;
      reconcilePlayer();
    }, 180);
  });

  function scheduleSettingsReload() {
    void loadDisplaySettings();
    state.autoVisit = '';
    void reportAutoVisit();
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(() => {
      state.settingsTimer = 0;
      if (state.url !== location.href) void navigate();
      else if (state.context) void loadTrack();
    }, 120);
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse({ url: location.href });
    } else if (message?.type === "TRACK_READY" && state.context &&
      message.bvid === state.context.bvid && String(message.cid) === String(state.context.cid)) {
      void loadTrack();
    } else if (message?.type === "SETTINGS_UPDATED") scheduleSettingsReload();
    else if (message?.type === "DISPLAY_SETTINGS_UPDATED") void loadDisplaySettings();
    return false;
  }

  async function reportAutoVisit() {
    if(state.destroyed || !state.context || document.hidden || state.url!==location.href) return;
    const playing=Boolean(state.video && !state.video.paused && !state.adPlaying);
    const signature=`${state.context.bvid}:${state.context.cid}:${playing}`;
    if(signature===state.autoVisit) return;
    state.autoVisit=signature;
    try {await request({type:'VIDEO_VISIT',url:location.href,visible:true,playing});}
    catch { /* Automatic task errors remain available in the extension popup. */ }
  }

  function onVisibility() { render(); syncAnimation(); if(!document.hidden) void reportAutoVisit(); }
  function onFullscreen() { reconcilePlayer(); render(); }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    ++state.generation;
    ++state.trackRequest;
    clearInterval(state.poll);
    clearTimeout(state.mutationTimer);
    clearTimeout(state.settingsTimer);
    observer.disconnect();
    detachPlayer();
    chrome.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("fullscreenchange", onFullscreen);
    window.removeEventListener("pagehide", onPageHide);
    if (globalThis[INSTANCE_KEY]?.destroy === destroy) delete globalThis[INSTANCE_KEY];
  }

  function onPageHide(event) { if (!event.persisted) destroy(); }

  globalThis[INSTANCE_KEY] = { destroy };
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("fullscreenchange", onFullscreen);
  window.addEventListener("pagehide", onPageHide);
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "src", "data-ad-playing"],
  });
  state.poll = setInterval(() => {
    if (location.href !== state.url) void navigate();
    else reconcilePlayer();
  }, 1000);
  void navigate();
})();

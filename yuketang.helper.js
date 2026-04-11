// ==UserScript==
// @name         YukeTang Study Summary Helper
// @namespace    codex.ykt.study
// @version      0.1.0
// @description  收集雨课堂结果页题图，并让多模态 AI 直接识图答题。
// @match        https://changjiang-exam.yuketang.cn/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    maxTextLengthPerQuestion: 4000,
    maxImagesPerQuestion: 8,
    minQuestionImageWidth: 120,
    minQuestionImageHeight: 40,
    requestTimeoutMs: 60000,
    questionMode: "single-choice",
    imageFetchConcurrency: 2,
    renderEvery: 3,
    imageMaxWidth: 1400,
    imageMaxHeight: 1400,
    imageQuality: 0.82,
    showImagePreview: true,
    useProxyRequest: typeof GM_xmlhttpRequest === "function",
    ai: {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      apiKey: "YOUR_AI_API_KEY",
      model: "AI_MODEL_NAME",
      temperature: 0.2,
      requestTimeoutMs: 180000,
      retryCount: 2,
      retryDelayMs: 2500
    }
  };

  const STATE = {
    running: false,
    data: [],
    panel: null,
    statusNode: null,
    listNode: null,
    drag: null
  };

  const SELECTORS = {
    questionHints: [
      "\u5355\u9009\u9898",
      "\u591a\u9009\u9898",
      "\u5224\u65ad\u9898",
      "\u586b\u7a7a\u9898",
      "\u7b80\u7b54\u9898",
      "\u8bba\u8ff0\u9898",
      "\u8ba1\u7b97\u9898"
    ],
    questionContainers: ["section", "article", "div", "li"]
  };

  const PANEL_STYLE_ID = "ykt-study-helper-styles";
  const PANEL_FONT_ID = "ykt-study-helper-fonts";
  const PANEL_POSITION_KEY = "ykt-study-helper-panel-position";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setStatus(message) {
    if (STATE.statusNode) {
      STATE.statusNode.textContent = message;
    }
    console.log("[study-helper]", message);
  }

  function normalizeText(text) {
    return (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function dedupeStrings(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function cleanQuestionText(text) {
    const lines = normalizeText(text)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const filtered = lines.filter((line) => {
      const compact = line.replace(/\s+/g, "");
      return !(
        /^(本题得分|得分|分数)[:：]?/i.test(compact) ||
        /^(正确答案|参考答案|你的答案|我的答案)[:：]?/i.test(compact) ||
        /^(查看解析|解析|答案解析|收藏|不懂|反馈|下一题|上一题)$/i.test(
          compact
        ) ||
        /^(已作答|未作答|标记题目|加入错题本)$/i.test(compact)
      );
    });

    return normalizeText(filtered.join("\n"));
  }

  function parseQuestionType(text) {
    const hit = SELECTORS.questionHints.find((item) => text.includes(item));
    return hit || "";
  }

  function parseQuestionIndex(text, fallbackIndex) {
    const match = text.match(/(?:^|\n|\s)(\d+)[\.\uFF0E\u3001]/);
    if (match) {
      return Number(match[1]);
    }
    return fallbackIndex + 1;
  }

  function likelyQuestionBlockText(text) {
    if (!text) {
      return false;
    }
    const compact = text.replace(/\s+/g, "");
    return (
      compact.length > 12 &&
      SELECTORS.questionHints.some((item) => compact.includes(item))
    );
  }

  function pickQuestionBlocks() {
    const nodes = Array.from(
      document.querySelectorAll(SELECTORS.questionContainers.join(","))
    );

    const candidates = nodes.filter((node) => {
      const text = normalizeText(node.innerText);
      if (!likelyQuestionBlockText(text)) {
        return false;
      }

      const imageCount = node.querySelectorAll("img").length;
      return imageCount > 0 || text.length > 80;
    });

    const filtered = [];
    for (const node of candidates) {
      const nestedCandidate = candidates.find(
        (other) => other !== node && node.contains(other)
      );
      if (!nestedCandidate) {
        filtered.push(node);
      }
    }

    const bestByIndex = new Map();
    for (let i = 0; i < filtered.length; i += 1) {
      const node = filtered[i];
      const text = normalizeText(node.innerText);
      const index = parseQuestionIndex(text, i);
      const prev = bestByIndex.get(index);
      if (!prev || text.length > prev.text.length) {
        bestByIndex.set(index, { node, text });
      }
    }

    return [...bestByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1].node);
  }

  function findQuestionImages(block) {
    return Array.from(block.querySelectorAll("img"))
      .filter((img) => isLikelyQuestionImage(img))
      .slice(0, CONFIG.maxImagesPerQuestion);
  }

  function findImageUrls(block) {
    const sources = findQuestionImages(block)
      .map(
        (img) => img.currentSrc || img.src || img.getAttribute("data-src") || ""
      )
      .filter(Boolean);
    return dedupeStrings(sources);
  }

  function isLikelyQuestionImage(img) {
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    if (!src) {
      return false;
    }

    if (src.startsWith("data:")) {
      return true;
    }

    const rect = img.getBoundingClientRect();
    const width = Math.max(
      rect.width || 0,
      img.naturalWidth || 0,
      img.width || 0
    );
    const height = Math.max(
      rect.height || 0,
      img.naturalHeight || 0,
      img.height || 0
    );

    if (
      width < CONFIG.minQuestionImageWidth ||
      height < CONFIG.minQuestionImageHeight
    ) {
      return false;
    }

    const alt = (img.alt || "").toLowerCase();
    const className = String(img.className || "").toLowerCase();
    const hintText = `${src} ${alt} ${className}`;
    if (
      /(icon|avatar|logo|radio|checkbox|button|badge|thumb|small)/.test(
        hintText
      )
    ) {
      return false;
    }

    return true;
  }

  async function imageUrlToBase64(url) {
    try {
      if (typeof GM_xmlhttpRequest === "function") {
        const blob = await fetchImageBlobViaGM(url);
        return blobToDataUrl(blob);
      }
    } catch (error) {
      console.warn(
        "[study-helper] GM image fetch failed, fallback to fetch",
        error
      );
    }

    const response = await fetch(url, {
      credentials: "include"
    });
    if (!response.ok) {
      throw new Error(`图片获取失败：${response.status}`);
    }
    const blob = await response.blob();
    return blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("无法创建画布上下文");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    return { canvas, ctx };
  }

  function getImageElementSize(img) {
    const width =
      img.naturalWidth ||
      img.width ||
      Math.ceil(img.getBoundingClientRect().width);
    const height =
      img.naturalHeight ||
      img.height ||
      Math.ceil(img.getBoundingClientRect().height);
    if (!width || !height) {
      throw new Error("图片尺寸无效");
    }
    return { width, height };
  }

  async function imageElementToDataUrl(img) {
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    if (src.startsWith("data:")) {
      return src;
    }

    if (src) {
      return imageUrlToBase64(src);
    }

    return imageElementToCanvasDataUrl(img);
  }

  function imageElementToCanvasDataUrl(img) {
    let { width, height } = getImageElementSize(img);

    const scale = Math.min(
      1,
      CONFIG.imageMaxWidth / width,
      CONFIG.imageMaxHeight / height
    );
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const { canvas, ctx } = createCanvas(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", CONFIG.imageQuality);
  }

  function fetchImageBlobViaGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: CONFIG.requestTimeoutMs,
        onload: (response) => {
          if (
            response.status >= 200 &&
            response.status < 300 &&
            response.response
          ) {
            resolve(response.response);
            return;
          }
          reject(new Error(`图片获取失败：${response.status}`));
        },
        onerror: () => reject(new Error("图片跨域请求失败")),
        ontimeout: () => reject(new Error("图片获取超时"))
      });
    });
  }

  function buildQuestionPayload(block, index) {
    const rawText = cleanQuestionText(block.innerText).slice(
      0,
      CONFIG.maxTextLengthPerQuestion
    );
    const imageUrls = findImageUrls(block);
    return {
      index: parseQuestionIndex(rawText, index),
      type: parseQuestionType(rawText),
      imageUrls,
      imageDataUrls: [],
      rawBlockText: rawText,
      studySummary: "",
      analysisRaw: ""
    };
  }

  function getAnswerClass(answer) {
    const value = normalizeText(answer);
    if (/^[A-D]$/.test(value)) {
      return "is-ready";
    }
    if (value === "X" || value.includes("未")) {
      return "is-muted";
    }
    return "";
  }

  function renderImagePreview(item) {
    if (!CONFIG.showImagePreview || !item.imageDataUrls?.length) {
      return "";
    }

    const previews = item.imageDataUrls
      .slice(0, 3)
      .map(
        (url, index) =>
          `<img class='ykt-thumb' src='${escapeHtml(url)}' alt='第 ${item.index} 题题图预览 ${index + 1}' loading='lazy'>`
      )
      .join("");
    const extraCount = item.imageDataUrls.length - 3;
    const extra =
      extraCount > 0
        ? `<span class='ykt-thumb-more'>+${extraCount}</span>`
        : "";

    return `<div class='ykt-thumb-row'>${previews}${extra}</div>`;
  }

  function renderResults() {
    if (!STATE.listNode) {
      return;
    }

    const items = STATE.data.filter(Boolean);

    if (!items.length) {
      STATE.listNode.innerHTML =
        "<div class='ykt-empty'>暂无题图结果。先滚动到底部，再开始识图。</div>";
      return;
    }

    const questionCards = items
      .map((item) => {
        const detailPreview = escapeHtml(
          `已获取题图：${item.imageDataUrls?.length || 0} 张`
        );
        const summaryPreview = escapeHtml(item.studySummary || "");
        return [
          "<article class='ykt-question-card'>",
          "<div class='ykt-question-head'>",
          `<span>第 ${item.index} 题</span>`,
          item.type
            ? `<span class='ykt-type'>${escapeHtml(item.type)}</span>`
            : "",
          "</div>",
          "<div class='ykt-meta-row'>",
          `<span>${detailPreview}</span>`,
          `<strong class='${getAnswerClass(summaryPreview)}'>${summaryPreview || "未生成"}</strong>`,
          "</div>",
          renderImagePreview(item),
          "</article>"
        ].join("");
      })
      .join("");

    const answerRows = items
      .map((item) => {
        const answer = normalizeText(item.studySummary || "") || "未生成";
        const safeAnswer = escapeHtml(answer);
        return [
          "<div class='ykt-answer-row'>",
          `<span class='ykt-answer-index'>${item.index}</span>`,
          `<span class='ykt-answer-value ${getAnswerClass(answer)}'>${safeAnswer}</span>`,
          "</div>"
        ].join("");
      })
      .join("");

    STATE.listNode.innerHTML = [
      "<section class='ykt-summary-card'>",
      "<div class='ykt-section-title'>AI 答案汇总</div>",
      `<div class='ykt-answer-grid'>${answerRows}</div>`,
      "</section>",
      "<div class='ykt-question-list'>",
      questionCards,
      "</div>"
    ].join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function requestViaGM(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: details.method || "GET",
        url: details.url,
        headers: details.headers,
        data: details.data,
        timeout: details.timeout ?? CONFIG.requestTimeoutMs,
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error("请求超时"))
      });
    });
  }

  async function requestJson(method, url, body, headers, options = {}) {
    if (CONFIG.useProxyRequest) {
      const response = await requestViaGM({
        method,
        url,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: options.timeout
      });
      if (response.status < 200 || response.status >= 300) {
        const detail = extractErrorDetail(response.responseText);
        throw new Error(
          detail
            ? `请求失败：${response.status}，${detail}`
            : `请求失败：${response.status}`
        );
      }
      return JSON.parse(response.responseText);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: options.signal
    });
    if (!response.ok) {
      const text = await response.text();
      const detail = extractErrorDetail(text);
      throw new Error(
        detail
          ? `请求失败：${response.status}，${detail}`
          : `请求失败：${response.status}`
      );
    }
    return response.json();
  }

  function extractErrorDetail(text) {
    if (!text) {
      return "";
    }
    try {
      const payload = JSON.parse(text);
      return (
        payload?.error?.message ||
        payload?.error?.code ||
        payload?.message ||
        payload?.code ||
        String(text).slice(0, 200)
      );
    } catch {
      return String(text).slice(0, 200);
    }
  }

  async function callAiImageAnswerApi(question) {
    if (!CONFIG.ai.enabled) {
      throw new Error(
        "AI 分析未启用，请先填写 endpoint、apiKey、model，并将 enabled 设为 true。"
      );
    }

    const content = [
      {
        type: "text",
        text: [
          "你是一名高精度数学单选题解题助手。",
          "请直接阅读下面题图，识别完整题干和 A/B/C/D 四个选项。",
          "题图可能包含水印、公式、上下标、分式或页面干扰，请根据图像内容自行理解题意。",
          "如果同一道题有多张图，请按图片出现顺序拼接理解，不要只看第一张图。",
          "下面还会提供页面可见文本作为辅助定位，但最终要以题图中的题干和选项为准。",
          "请在内部完成推理和验算，尽最大可能从 A、B、C、D 中选择一个最合理答案。",
          "不要输出解题过程，不要复述题目，不要输出多个字母，不要输出置信度。",
          "如果图片里有结果页的正确答案、得分、解析等文字，请忽略它们，只根据题干和选项作答。",
          "只有在完全无法看到题干或有效选项时，才输出：X。",
          `题号：${question.index}`,
          `页面可见文本：${cleanQuestionText(question.rawBlockText || "").slice(0, 1200)}`
        ].join("\n")
      },
      ...question.imageDataUrls.map((url) => ({
        type: "image_url",
        image_url: { url }
      }))
    ];

    const body = {
      model: CONFIG.ai.model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content
        }
      ]
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.ai.apiKey}`
    };

    return requestJson("POST", CONFIG.ai.endpoint, body, headers, {
      timeout: CONFIG.ai.requestTimeoutMs
    });
  }

  function normalizeChoiceAnswer(text) {
    const upper = String(text || "").toUpperCase();
    if (/^\s*X\s*$/.test(upper) || /无法判断|无法识别|不完整/.test(text)) {
      return "X";
    }
    const strongPatterns = [
      /(?:答案|选项|选择|应选|正确选项)\s*[:：]?\s*([A-D])\b/,
      /\b([A-D])\b(?=\s*(?:正确|对|即可|$))/,
      /^\s*([A-D])\s*$/
    ];

    for (const pattern of strongPatterns) {
      const match = upper.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    const letters = upper.match(/\b[A-D]\b/g) || [];
    return letters[0] || "未识别到选项";
  }

  async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
      while (cursor < items.length) {
        const currentIndex = cursor;
        cursor += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const runners = Array.from(
      { length: Math.max(1, Math.min(limit, items.length)) },
      () => runner()
    );
    await Promise.all(runners);
    return results;
  }

  async function callAiApiWithRetry(payload, caller = callAiImageAnswerApi) {
    let lastError;
    const attempts = Math.max(1, Number(CONFIG.ai.retryCount || 0) + 1);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await caller(payload);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) {
          break;
        }
        console.warn(
          `[study-helper] AI request failed, retry ${attempt}/${attempts - 1}`,
          error
        );
        await sleep(CONFIG.ai.retryDelayMs);
      }
    }

    throw lastError;
  }

  function extractAiText(result) {
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          return item?.text || "";
        })
        .join("\n")
        .trim();
    }
    return JSON.stringify(result, null, 2);
  }

  function cleanAiAnswer(text) {
    return normalizeText(
      String(text || "")
        .replace(/\[Standard Problem\][\s\S]*?(?=\[Final Answers\]|$)/gi, "")
        .replace(/\[Final Answers\]/gi, "")
        .replace(/\[[^\]]+\]/g, "")
        .replace(/^答案[:：]\s*/gim, "")
        .replace(/^最终答案[:：]\s*/gim, "")
        .replace(/\n{3,}/g, "\n\n")
    );
  }

  async function summarizeWithAi() {
    if (!STATE.data.length) {
      throw new Error("请先获取题图");
    }

    for (let i = 0; i < STATE.data.length; i += 1) {
      const item = STATE.data[i];
      if (!item.imageDataUrls?.length) {
        STATE.data = STATE.data.map((current) =>
          current.index === item.index
            ? {
                ...current,
                analysisRaw: "未获取到题图",
                studySummary: "未获取到题图"
              }
            : current
        );
        renderResults();
        continue;
      }

      setStatus(
        `正在请求 AI 直接识图答题...（第 ${i + 1}/${STATE.data.length} 题）`
      );
      const response = await callAiApiWithRetry(item);
      const text = normalizeChoiceAnswer(
        cleanAiAnswer(extractAiText(response))
      );

      STATE.data = STATE.data.map((current) =>
        current.index === item.index
          ? {
              ...current,
              analysisRaw: text,
              studySummary: text
            }
          : current
      );
      renderResults();
    }

    setStatus("AI 答案生成已完成");
  }

  async function collectQuestionImages() {
    if (STATE.running) {
      return;
    }

    STATE.running = true;
    try {
      const blocks = pickQuestionBlocks();
      if (!blocks.length) {
        throw new Error("没有找到题目块，请先将页面滚动到底部以加载完整内容。");
      }

      STATE.data = [];
      renderResults();
      setStatus(`已发现 ${blocks.length} 道题，开始获取题图...`);

      STATE.data = new Array(blocks.length);
      let completed = 0;

      await runWithConcurrency(
        blocks,
        CONFIG.imageFetchConcurrency,
        async (block, i) => {
          const question = buildQuestionPayload(block, i);
          const questionImages = findQuestionImages(block);
          question.imageDataUrls = [];
          for (
            let imageIndex = 0;
            imageIndex < questionImages.length;
            imageIndex += 1
          ) {
            setStatus(
              `正在获取第 ${question.index} 题题图，第 ${imageIndex + 1}/${questionImages.length} 张...`
            );
            question.imageDataUrls.push(
              await imageElementToDataUrl(questionImages[imageIndex])
            );
          }
          question.studySummary = "";
          question.analysisRaw = "";

          STATE.data[i] = question;
          completed += 1;
          if (
            completed === blocks.length ||
            completed % CONFIG.renderEvery === 0
          ) {
            renderResults();
          }
          return question;
        }
      );

      renderResults();
      setStatus(`题图获取完成，共 ${STATE.data.length} 道题`);
    } finally {
      STATE.running = false;
    }
  }

  async function runVisionAnswerSummary() {
    await collectQuestionImages();
    await summarizeWithAi();
  }

  function createButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ykt-primary-button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      try {
        await onClick();
      } catch (error) {
        console.error(error);
        setStatus(`操作失败：${String(error?.message || error)}`);
      }
    });
    return button;
  }

  function injectPanelFonts() {
    if (document.getElementById(PANEL_FONT_ID)) {
      return;
    }

    const preconnectGoogle = document.createElement("link");
    preconnectGoogle.id = PANEL_FONT_ID;
    preconnectGoogle.rel = "preconnect";
    preconnectGoogle.href = "https://fonts.googleapis.com";

    const preconnectGstatic = document.createElement("link");
    preconnectGstatic.rel = "preconnect";
    preconnectGstatic.href = "https://fonts.gstatic.com";
    preconnectGstatic.crossOrigin = "anonymous";

    const fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;600;700;800&display=swap";

    document.head.appendChild(preconnectGoogle);
    document.head.appendChild(preconnectGstatic);
    document.head.appendChild(fontLink);
  }

  function injectPanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      .ykt-study-panel {
        --ykt-bg: #171717;
        --ykt-card: #212121;
        --ykt-card-soft: #262626;
        --ykt-ink: #ececec;
        --ykt-muted: #a3a3a3;
        --ykt-line: rgba(255, 255, 255, .1);
        --ykt-accent: #10a37f;
        --ykt-accent-strong: #19c37d;
        --ykt-warn: #f2a60d;
        --ykt-shadow: 0 22px 60px rgba(0, 0, 0, .42);
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: min(392px, calc(100vw - 24px));
        max-height: min(74vh, 680px);
        z-index: 999999;
        color: var(--ykt-ink);
        background:
          radial-gradient(circle at 100% 0%, rgba(16, 163, 127, .1), transparent 34%),
          linear-gradient(180deg, rgba(35, 35, 35, .96), rgba(20, 20, 20, .94));
        border: 1px solid var(--ykt-line);
        border-radius: 18px;
        box-shadow: var(--ykt-shadow);
        overflow: hidden;
        font-family: "Inter", "Noto Sans SC", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        backdrop-filter: blur(12px) saturate(1.08);
        -webkit-backdrop-filter: blur(12px) saturate(1.08);
        isolation: isolate;
      }

      .ykt-study-panel::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: -1;
        border-radius: inherit;
        background:
          linear-gradient(135deg, rgba(255, 255, 255, .08), rgba(255, 255, 255, .025) 38%, rgba(0, 0, 0, .12)),
          radial-gradient(circle at 18% 8%, rgba(255, 255, 255, .06), transparent 28%);
        pointer-events: none;
      }

      .ykt-study-panel * {
        box-sizing: border-box;
      }

      .ykt-study-panel.is-dragging {
        user-select: none;
        box-shadow: 0 28px 72px rgba(0, 0, 0, .54);
      }

      .ykt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--ykt-line);
        background: rgba(255, 255, 255, .04);
        cursor: grab;
        touch-action: none;
      }

      .ykt-study-panel.is-dragging .ykt-header {
        cursor: grabbing;
      }

      .ykt-title {
        font-size: 15px;
        font-weight: 760;
        letter-spacing: .02em;
      }

      .ykt-badge {
        padding: 4px 8px;
        border: 1px solid rgba(16, 163, 127, .26);
        border-radius: 999px;
        color: var(--ykt-accent-strong);
        background: rgba(16, 163, 127, .1);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .06em;
        text-transform: uppercase;
      }

      .ykt-body {
        padding: 12px;
      }

      .ykt-status {
        min-height: 34px;
        margin-bottom: 10px;
        padding: 8px 10px;
        border: 1px solid var(--ykt-line);
        border-radius: 12px;
        color: var(--ykt-muted);
        background: rgba(0, 0, 0, .28);
        font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace;
      }

      .ykt-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .ykt-primary-button {
        border: 1px solid rgba(25, 195, 125, .28);
        border-radius: 12px;
        padding: 9px 12px;
        color: #06140f;
        background: linear-gradient(180deg, #19c37d, #10a37f);
        box-shadow: 0 12px 24px rgba(16, 163, 127, .22), inset 0 1px rgba(255, 255, 255, .26);
        cursor: pointer;
        font: 760 12px/1 "Inter", "Noto Sans SC", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
      }

      .ykt-primary-button:hover {
        transform: translateY(-1px);
        filter: saturate(1.04);
        box-shadow: 0 16px 30px rgba(16, 163, 127, .28), inset 0 1px rgba(255, 255, 255, .32);
      }

      .ykt-primary-button:active {
        transform: translateY(0);
      }

      .ykt-primary-button:focus-visible {
        outline: 2px solid rgba(25, 195, 125, .45);
        outline-offset: 3px;
      }

      .ykt-tips {
        margin-bottom: 12px;
        color: var(--ykt-muted);
        font-size: 12px;
        line-height: 1.55;
      }

      .ykt-results {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: 44vh;
        overflow: auto;
        padding-right: 2px;
        font-size: 12px;
        line-height: 1.5;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, .22) transparent;
      }

      .ykt-empty {
        padding: 14px;
        border: 1px dashed rgba(255, 255, 255, .16);
        border-radius: 14px;
        color: var(--ykt-muted);
        background: rgba(255, 255, 255, .055);
      }

      .ykt-summary-card {
        flex: 0 0 auto;
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, .1);
        border-radius: 14px;
        background: #262626;
        box-shadow: 0 12px 26px rgba(0, 0, 0, .22);
      }

      .ykt-section-title {
        margin-bottom: 8px;
        color: var(--ykt-accent-strong);
        font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .08em;
      }

      .ykt-answer-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .ykt-answer-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 6px 7px;
        border: 1px solid rgba(255, 255, 255, .08);
        border-radius: 10px;
        background: #303030;
      }

      .ykt-answer-index {
        color: var(--ykt-muted);
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .ykt-answer-value {
        min-width: 34px;
        overflow: hidden;
        color: var(--ykt-ink);
        font: 800 12px/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ykt-answer-value.is-ready,
      .ykt-meta-row strong.is-ready {
        color: var(--ykt-good);
      }

      .ykt-answer-value.is-muted,
      .ykt-meta-row strong.is-muted {
        color: var(--ykt-warn);
      }

      .ykt-question-list {
        display: grid;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, .08);
      }

      .ykt-question-card {
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, .08);
        border-radius: 14px;
        background: #1f1f1f;
      }

      .ykt-question-head,
      .ykt-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .ykt-question-head {
        margin-bottom: 7px;
        font-weight: 760;
      }

      .ykt-type {
        color: var(--ykt-muted);
        font-size: 11px;
        font-weight: 600;
      }

      .ykt-meta-row {
        color: var(--ykt-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace;
        font-size: 11px;
      }

      .ykt-meta-row strong {
        color: var(--ykt-ink);
        font-size: 12px;
      }

      .ykt-thumb-row {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        overflow: hidden;
      }

      .ykt-thumb {
        width: 54px;
        height: 42px;
        object-fit: cover;
        border: 1px solid rgba(255, 255, 255, .1);
        border-radius: 9px;
        background: rgba(255, 255, 255, .05);
      }

      .ykt-thumb-more {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 42px;
        height: 42px;
        border: 1px solid rgba(255, 255, 255, .1);
        border-radius: 9px;
        color: var(--ykt-muted);
        background: rgba(255, 255, 255, .05);
        font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      @media (max-width: 520px) {
        .ykt-study-panel {
          width: calc(100vw - 24px);
        }

      }

      @media (prefers-reduced-motion: reduce) {
        .ykt-primary-button {
          transition: none;
        }

        .ykt-primary-button:hover {
          transform: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function clampPanelPosition(left, top, panel) {
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function savePanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(
      PANEL_POSITION_KEY,
      JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      })
    );
  }

  function applyPanelPosition(panel, position) {
    const next = clampPanelPosition(position.left, position.top, panel);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function restorePanelPosition(panel) {
    try {
      const stored = JSON.parse(
        localStorage.getItem(PANEL_POSITION_KEY) || "null"
      );
      if (Number.isFinite(stored?.left) && Number.isFinite(stored?.top)) {
        applyPanelPosition(panel, stored);
      }
    } catch (error) {
      console.warn("[study-helper] restore panel position failed", error);
    }
  }

  function bindPanelDrag(panel, handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      STATE.drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };

      panel.classList.add("is-dragging");
      handle.setPointerCapture(event.pointerId);
      applyPanelPosition(panel, { left: rect.left, top: rect.top });
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!STATE.drag || STATE.drag.pointerId !== event.pointerId) {
        return;
      }

      applyPanelPosition(panel, {
        left: event.clientX - STATE.drag.offsetX,
        top: event.clientY - STATE.drag.offsetY
      });
    });

    function finishDrag(event) {
      if (!STATE.drag || STATE.drag.pointerId !== event.pointerId) {
        return;
      }

      STATE.drag = null;
      panel.classList.remove("is-dragging");
      savePanelPosition(panel);
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    }

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    window.addEventListener("resize", () => {
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(panel, { left: rect.left, top: rect.top });
      savePanelPosition(panel);
    });
  }

  function buildPanel() {
    injectPanelFonts();
    injectPanelStyles();

    const panel = document.createElement("div");
    panel.className = "ykt-study-panel";

    const header = document.createElement("div");
    header.className = "ykt-header";

    const title = document.createElement("div");
    title.className = "ykt-title";
    title.textContent = "学习整理助手";

    const badge = document.createElement("div");
    badge.className = "ykt-badge";
    badge.textContent = "Vision";

    header.appendChild(title);
    header.appendChild(badge);

    const body = document.createElement("div");
    body.className = "ykt-body";

    const status = document.createElement("div");
    status.className = "ykt-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = "等待开始";

    const actions = document.createElement("div");
    actions.className = "ykt-actions";
    actions.appendChild(
      createButton("识图答题 + 汇总", runVisionAnswerSummary)
    );

    const tips = document.createElement("div");
    tips.className = "ykt-tips";
    tips.textContent =
      "当前版本会先收集每道题的题图，再让多模态 AI 直接阅读图片并推断 A/B/C/D 答案。";

    const list = document.createElement("div");
    list.className = "ykt-results";

    body.appendChild(status);
    body.appendChild(actions);
    body.appendChild(tips);
    body.appendChild(list);
    panel.appendChild(header);
    panel.appendChild(body);

    STATE.panel = panel;
    STATE.statusNode = status;
    STATE.listNode = list;
    renderResults();
    document.body.appendChild(panel);
    restorePanelPosition(panel);
    bindPanelDrag(panel, header);
  }

  function waitForPageStable() {
    return new Promise((resolve) => {
      const timer = window.setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  }

  async function init() {
    await waitForPageStable();
    buildPanel();
    setStatus("脚本已就绪。建议先把页面滚动到底部，再点击“识图答题 + 汇总”。");
    window.__YKT_STUDY_HELPER__ = {
      config: CONFIG,
      state: STATE,
      collectQuestionImages,
      summarizeWithAi,
      runVisionAnswerSummary
    };
  }

  init().catch((error) => {
    console.error("[study-helper] init failed", error);
  });
})();

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
    renderEvery: 1,
    maxEnhancedImagesPerQuestion: 12,
    enhancedSearchPadding: 220,
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
    orbNode: null,
    statusNode: null,
    listNode: null,
    answeringIndex: null,
    retryingIndex: null,
    renderedQuestionIndexes: new Set(),
    workflowRunning: false,
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

  function isInsideHelperUi(node) {
    return Boolean(node?.closest?.(".ykt-study-panel, .ykt-mini-orb"));
  }

  function pickQuestionBlocks() {
    const nodes = Array.from(
      document.querySelectorAll(SELECTORS.questionContainers.join(","))
    );

    const candidates = nodes.filter((node) => {
      if (isInsideHelperUi(node)) {
        return false;
      }

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
      .filter((img) => !isInsideHelperUi(img))
      .filter((img) => isLikelyQuestionImage(img))
      .slice(0, CONFIG.maxImagesPerQuestion);
  }

  function countQuestionMarkers(text) {
    const compact = normalizeText(text);
    return SELECTORS.questionHints.reduce((count, hint) => {
      const matches = compact.match(new RegExp(hint, "g")) || [];
      return count + matches.length;
    }, 0);
  }

  function findExpandedQuestionBlock(block) {
    let best = block;
    let current = block.parentElement;
    let depth = 0;

    while (current && depth < 4) {
      if (isInsideHelperUi(current)) {
        break;
      }

      const text = cleanQuestionText(current.innerText || "");
      const imageCount = current.querySelectorAll("img").length;
      const markerCount = countQuestionMarkers(text);
      const isReasonableScope =
        text.length <= CONFIG.maxTextLengthPerQuestion * 1.5 &&
        imageCount <= CONFIG.maxEnhancedImagesPerQuestion * 2 &&
        markerCount <= 2;

      if (
        isReasonableScope &&
        imageCount >= best.querySelectorAll("img").length
      ) {
        best = current;
      }

      current = current.parentElement;
      depth += 1;
    }

    return best;
  }

  function rectsNear(a, b, padding) {
    return !(
      b.right < a.left - padding ||
      b.left > a.right + padding ||
      b.bottom < a.top - padding ||
      b.top > a.bottom + padding
    );
  }

  function dedupeImageElements(images) {
    const seen = new Set();
    return images.filter((img) => {
      const src =
        img.currentSrc || img.src || img.getAttribute("data-src") || "";
      const rect = img.getBoundingClientRect();
      const key =
        src ||
        `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function findEnhancedQuestionImages(block) {
    const expandedBlock = findExpandedQuestionBlock(block);
    const baseImages = Array.from(expandedBlock.querySelectorAll("img"));
    const blockRect = expandedBlock.getBoundingClientRect();
    const nearbyImages = Array.from(document.querySelectorAll("img")).filter(
      (img) => {
        if (isInsideHelperUi(img) || !isLikelyQuestionImage(img)) {
          return false;
        }
        return rectsNear(
          blockRect,
          img.getBoundingClientRect(),
          CONFIG.enhancedSearchPadding
        );
      }
    );

    return dedupeImageElements([...baseImages, ...nearbyImages])
      .filter((img) => !isInsideHelperUi(img))
      .filter((img) => isLikelyQuestionImage(img))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top === br.top ? ar.left - br.left : ar.top - br.top;
      })
      .slice(0, CONFIG.maxEnhancedImagesPerQuestion);
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
      sourceBlock: block,
      enhancedRetryCount: 0,
      rawBlockText: rawText,
      studySummary: "",
      analysisRaw: ""
    };
  }

  async function hydrateQuestionImages(question, block, options = {}) {
    const enhanced = Boolean(options.enhanced);
    const sourceBlock = enhanced ? findExpandedQuestionBlock(block) : block;
    const questionImages = enhanced
      ? findEnhancedQuestionImages(sourceBlock)
      : findQuestionImages(sourceBlock);

    if (enhanced) {
      const expandedText = cleanQuestionText(sourceBlock.innerText || "").slice(
        0,
        CONFIG.maxTextLengthPerQuestion
      );
      question.rawBlockText = expandedText || question.rawBlockText;
      question.type = question.type || parseQuestionType(expandedText);
    }

    question.imageUrls = dedupeStrings(
      questionImages.map(
        (img) => img.currentSrc || img.src || img.getAttribute("data-src") || ""
      )
    );
    question.imageDataUrls = [];

    for (
      let imageIndex = 0;
      imageIndex < questionImages.length;
      imageIndex += 1
    ) {
      setStatus(
        `${enhanced ? "增强获取" : "正在获取"}第 ${question.index} 题题图，第 ${imageIndex + 1}/${questionImages.length} 张...`
      );
      question.imageDataUrls.push(
        await imageElementToDataUrl(questionImages[imageIndex])
      );
    }

    return question;
  }

  function getAnswerClass(answer, options = {}) {
    const value = normalizeText(answer);
    if (/^[A-D]$/.test(value)) {
      return "is-ready";
    }
    if (
      value === "X" ||
      value.includes("未") ||
      (options.pendingMuted && value.includes("生成中"))
    ) {
      return "is-muted";
    }
    return "";
  }

  function isRetryableAnswer(answer) {
    const value = normalizeText(answer);
    return (
      !value ||
      value === "X" ||
      value.includes("未识别") ||
      value.includes("未获取") ||
      value.includes("无法")
    );
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
        "<div class='ykt-empty'><span>暂无题图结果。先滚动到底部，再开始识图。</span></div>";
      return;
    }

    const questionCards = items
      .map((item) => {
        const shouldAnimate = !STATE.renderedQuestionIndexes.has(item.index);
        const detailPreview = escapeHtml(
          `已获取题图：${item.imageDataUrls?.length || 0} 张${
            item.enhancedRetryCount ? " · 已增强采集" : ""
          }`
        );
        const summaryPreview = escapeHtml(item.studySummary || "");
        return [
          `<article class='ykt-question-card${shouldAnimate ? " is-entering" : ""}' style='--ykt-card-order: ${Math.min(
            item.index,
            10
          )};'>`,
          "<div class='ykt-question-head'>",
          `<span>第 ${item.index} 题</span>`,
          item.type
            ? `<span class='ykt-type'>${escapeHtml(item.type)}</span>`
            : "",
          "</div>",
          "<div class='ykt-meta-row'>",
          `<span>${detailPreview}</span>`,
          `<strong class='${getAnswerClass(summaryPreview || "生成中")}'>${summaryPreview || "生成中"}</strong>`,
          "</div>",
          renderImagePreview(item),
          "</article>"
        ].join("");
      })
      .join("");
    items.forEach((item) => STATE.renderedQuestionIndexes.add(item.index));

    const visibleSummaryItems = items.filter(
      (item) => item.studySummary || item.index === STATE.answeringIndex
    );
    const answerRows = visibleSummaryItems
      .map((item) => {
        const answer = normalizeText(item.studySummary || "") || "生成中";
        const safeAnswer = escapeHtml(answer);
        const retryButton =
          item.studySummary && isRetryableAnswer(item.studySummary)
            ? `<button class='ykt-retry-button' type='button' data-ykt-retry='${item.index}'${
                STATE.retryingIndex === item.index ? " disabled" : ""
              }>${
                STATE.retryingIndex === item.index ? "重试中" : "重试本题"
              }</button>`
            : "";
        return [
          "<div class='ykt-answer-row'>",
          `<span class='ykt-answer-index'>${item.index}</span>`,
          "<span class='ykt-answer-right'>",
          `<span class='ykt-answer-value ${getAnswerClass(answer, { pendingMuted: true })}'>${safeAnswer}</span>`,
          retryButton,
          "</span>",
          "</div>"
        ].join("");
      })
      .join("");
    const summarySection = answerRows
      ? [
          "<section class='ykt-summary-card'>",
          "<div class='ykt-section-title'>AI 答案汇总</div>",
          `<div class='ykt-answer-grid'>${answerRows}</div>`,
          "</section>"
        ].join("")
      : "";

    STATE.listNode.innerHTML = [
      summarySection,
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

  async function requestAnswerForQuestion(item, options = {}) {
    const enhanced = Boolean(options.enhanced);
    const nextItem = { ...item };

    if (enhanced) {
      if (!nextItem.sourceBlock) {
        throw new Error("找不到该题原始区域，无法增强采集");
      }
      nextItem.enhancedRetryCount = (nextItem.enhancedRetryCount || 0) + 1;
      await hydrateQuestionImages(nextItem, nextItem.sourceBlock, {
        enhanced: true
      });
    }

    if (!nextItem.imageDataUrls?.length) {
      return {
        ...nextItem,
        analysisRaw: "未获取到题图",
        studySummary: "未获取到题图"
      };
    }

    const response = await callAiApiWithRetry(nextItem);
    const text = normalizeChoiceAnswer(cleanAiAnswer(extractAiText(response)));
    return {
      ...nextItem,
      analysisRaw: text,
      studySummary: text
    };
  }

  async function animateEmptyExit() {
    const empty = STATE.listNode?.querySelector(".ykt-empty");
    if (!empty) {
      return;
    }

    empty.classList.remove("is-hovering");
    empty.classList.add("is-launching");
    await sleep(1180);
  }

  async function summarizeWithAi() {
    if (!STATE.data.length) {
      throw new Error("请先获取题图");
    }

    STATE.answeringIndex = null;
    for (let i = 0; i < STATE.data.length; i += 1) {
      const item = STATE.data[i];
      STATE.answeringIndex = item.index;
      renderResults();

      setStatus(
        `正在请求 AI 直接识图答题...（第 ${i + 1}/${STATE.data.length} 题）`
      );
      let answeredItem = await requestAnswerForQuestion(item);

      if (isRetryableAnswer(answeredItem.studySummary) && item.sourceBlock) {
        setStatus(`第 ${item.index} 题未识别完整，正在增强采集后重试...`);
        answeredItem = await requestAnswerForQuestion(answeredItem, {
          enhanced: true
        });
      }

      STATE.data = STATE.data.map((current) =>
        current.index === item.index ? answeredItem : current
      );
      renderResults();
    }

    STATE.answeringIndex = null;
    renderResults();
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

      STATE.answeringIndex = null;
      STATE.renderedQuestionIndexes.clear();
      STATE.data = [];
      renderResults();
      setStatus(`已发现 ${blocks.length} 道题，开始获取题图...`);
      await animateEmptyExit();

      STATE.data = new Array(blocks.length);
      let completed = 0;

      await runWithConcurrency(
        blocks,
        CONFIG.imageFetchConcurrency,
        async (block, i) => {
          const question = buildQuestionPayload(block, i);
          await hydrateQuestionImages(question, block);
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

  async function retryQuestion(index) {
    if (STATE.workflowRunning) {
      setStatus("正在处理当前任务，请稍等完成后再重试单题。");
      return;
    }

    const item = STATE.data.find((current) => current?.index === index);
    if (!item) {
      setStatus(`未找到第 ${index} 题，无法重试。`);
      return;
    }

    STATE.workflowRunning = true;
    STATE.retryingIndex = index;
    STATE.answeringIndex = index;
    try {
      renderResults();
      setStatus(`正在增强采集第 ${index} 题并重新请求 AI...`);
      const answeredItem = await requestAnswerForQuestion(item, {
        enhanced: true
      });
      STATE.data = STATE.data.map((current) =>
        current?.index === index ? answeredItem : current
      );
      renderResults();
      setStatus(`第 ${index} 题重试完成`);
    } catch (error) {
      console.error(error);
      setStatus(`第 ${index} 题重试失败：${String(error?.message || error)}`);
    } finally {
      STATE.retryingIndex = null;
      STATE.answeringIndex = null;
      STATE.workflowRunning = false;
      renderResults();
    }
  }

  async function runVisionAnswerSummary() {
    if (STATE.workflowRunning) {
      setStatus("正在处理当前任务，请稍等完成后再重新开始。");
      return;
    }

    STATE.workflowRunning = true;
    try {
      await collectQuestionImages();
      await summarizeWithAi();
    } finally {
      STATE.workflowRunning = false;
    }
  }

  function createButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ykt-primary-button";
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);
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
        --ykt-radius-window: 28px;
        --ykt-radius-panel: 22px;
        --ykt-radius-card: 18px;
        --ykt-radius-control: 15px;
        --ykt-radius-small: 11px;
        --ykt-font-sans: "Inter", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", ui-sans-serif, sans-serif;
        --ykt-font-mono: "SFMono-Regular", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, ui-monospace, monospace;
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: min(392px, calc(100vw - 24px));
        max-height: min(74vh, 680px);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        color: var(--ykt-ink);
        background:
          radial-gradient(circle at 100% 0%, rgba(16, 163, 127, .1), transparent 34%),
          linear-gradient(180deg, rgba(42, 42, 42, .98), rgba(19, 19, 19, .97));
        border: 1px double rgba(255, 255, 255, .12);
        border-radius: var(--ykt-radius-window);
        box-shadow:
          inset 2px -2px 1px -1px rgba(255, 255, 255, .18),
          inset -2px 2px 1px -1px rgba(255, 255, 255, .1),
          inset 0 0 1px rgba(255, 255, 255, .42),
          inset 0 -22px 36px rgba(0, 0, 0, .24),
          var(--ykt-shadow);
        overflow: hidden;
        font-family: var(--ykt-font-sans);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        isolation: isolate;
      }

      .ykt-study-panel::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: -1;
        border-radius: inherit;
        background:
          linear-gradient(45deg, rgba(255, 255, 255, .16) 0%, rgba(255, 255, 255, .04) 24%, rgba(255, 255, 255, .02) 72%, rgba(255, 255, 255, .14) 100%),
          linear-gradient(90deg, rgba(255, 255, 255, .028), transparent 18%, transparent 82%, rgba(255, 255, 255, .035)),
          radial-gradient(circle at 18% 8%, rgba(255, 255, 255, .08), transparent 26%),
          radial-gradient(circle at 88% 12%, rgba(25, 195, 125, .09), transparent 28%);
        pointer-events: none;
      }

      .ykt-study-panel > * {
        position: relative;
        z-index: 1;
      }

      .ykt-study-panel::after {
        content: "";
        position: absolute;
        z-index: -1;
        inset: 10px;
        border-radius: var(--ykt-radius-panel);
        border: 1px solid rgba(255, 255, 255, .1);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .16),
          inset 0 0 18px rgba(255, 255, 255, .035);
        filter: blur(.2px);
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
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 18px 13px;
        border-bottom: 0;
        background: linear-gradient(180deg, rgba(255, 255, 255, .045), rgba(255, 255, 255, .012));
        cursor: grab;
        touch-action: none;
      }

      .ykt-study-panel.is-dragging .ykt-header {
        cursor: grabbing;
      }

      .ykt-window-controls {
        display: inline-flex;
        align-items: center;
      }

      .ykt-control-dot {
        position: relative;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 1px solid rgba(16, 163, 127, .26);
        border-radius: 50%;
        cursor: pointer;
        background: rgba(16, 163, 127, .1);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .08),
          0 5px 12px rgba(0, 0, 0, .16);
        transition: transform .18s ease, filter .18s ease, box-shadow .18s ease;
      }

      .ykt-control-dot::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 8px;
        height: 2px;
        border-radius: 999px;
        background: var(--ykt-accent-strong);
        box-shadow: 0 0 8px rgba(25, 195, 125, .45);
        transform: translate(-50%, -50%);
      }

      .ykt-control-dot:hover {
        transform: translateY(-1px);
        filter: saturate(1.08);
        background: rgba(16, 163, 127, .16);
        border-color: rgba(16, 163, 127, .38);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .1),
          0 7px 16px rgba(0, 0, 0, .18);
      }

      .ykt-control-dot:focus-visible {
        outline: 2px solid rgba(255, 255, 255, .32);
        outline-offset: 3px;
      }

      .ykt-badge {
        padding: 4px 8px;
        border: 1px solid rgba(16, 163, 127, .26);
        border-radius: 999px;
        color: var(--ykt-accent-strong);
        background: rgba(16, 163, 127, .1);
        font: 700 10px/1 var(--ykt-font-mono);
        letter-spacing: .06em;
        text-transform: uppercase;
      }

      .ykt-mini-orb {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 999999;
        width: 62px;
        height: 62px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        color: #19c37d;
        appearance: none;
        -webkit-appearance: none;
        background:
          radial-gradient(circle at 34% 22%, rgba(255, 255, 255, 1), rgba(255, 255, 255, .72) 18%, transparent 34%),
          linear-gradient(145deg, #ffffff 0%, #f4f4f4 48%, #d8d8d8 100%);
        box-shadow:
          inset 0 4px 1px rgba(255, 255, 255, .88),
          inset 0 -5px 2px rgba(120, 120, 120, .32),
          inset -7px 8px 12px rgba(0, 0, 0, .08),
          0 7px 1px #b9b9b9,
          4px 10px 3px rgba(255, 255, 255, .62),
          0 20px 30px rgba(0, 0, 0, .26);
        cursor: pointer;
        display: none;
        place-items: center;
        overflow: hidden;
        isolation: isolate;
        font: italic 900 15px/1 var(--ykt-font-mono);
        letter-spacing: -.04em;
        transition: transform .22s ease, box-shadow .22s ease, filter .22s ease;
      }

      .ykt-mini-orb::before {
        content: "";
        position: absolute;
        z-index: 0;
        inset: 7px;
        border-radius: inherit;
        background: linear-gradient(145deg, #ffffff, #dedede);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, .96),
          inset 5px 10px 2px rgba(255, 255, 255, .32),
          inset 0 -1px 1px rgba(110, 110, 110, .28),
          0 0 18px rgba(255, 255, 255, .42);
        backdrop-filter: blur(8px) saturate(1.2);
        -webkit-backdrop-filter: blur(8px) saturate(1.2);
      }

      .ykt-mini-orb::after {
        content: "";
        position: absolute;
        z-index: 1;
        left: 17px;
        top: 13px;
        width: 20px;
        height: 9px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(255, 255, 255, .95), rgba(255, 255, 255, .18));
        filter: blur(1.2px);
        transform: rotate(-18deg);
      }

      .ykt-orb-label {
        position: relative;
        z-index: 2;
        color: #19c37d;
        font: italic 900 15px/1 var(--ykt-font-mono);
        letter-spacing: -.04em;
        text-shadow:
          0 1px 0 rgba(255, 255, 255, .72),
          0 -1px 0 rgba(0, 0, 0, .42),
          0 0 8px rgba(25, 195, 125, .62),
          0 0 18px rgba(16, 163, 127, .36);
        pointer-events: none;
      }

      .ykt-mini-orb:hover {
        transform: translateY(5px);
        filter: brightness(.99) contrast(1.04);
        background:
          radial-gradient(circle at 32% 20%, rgba(255, 255, 255, .92), rgba(255, 255, 255, .44) 18%, transparent 34%),
          linear-gradient(145deg, #f7f7f7 0%, #e5e5e5 46%, #bfc0c2 100%);
        box-shadow:
          inset 0 4px 1px rgba(255, 255, 255, .82),
          inset 0 -7px 3px rgba(112, 112, 112, .28),
          inset -8px 9px 14px rgba(0, 0, 0, .1),
          0 3px 1px #9f9f9f,
          3px 7px 5px rgba(255, 255, 255, .42),
          0 13px 24px rgba(0, 0, 0, .3);
      }

      .ykt-mini-orb:hover::before {
        background: linear-gradient(145deg, #ffffff, #cfcfcf);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, .86),
          inset 5px 10px 3px rgba(255, 255, 255, .24),
          inset 0 -2px 2px rgba(92, 92, 92, .24),
          0 0 12px rgba(255, 255, 255, .28);
      }

      .ykt-mini-orb:hover::after {
        opacity: .72;
      }

      .ykt-mini-orb:active {
        transform: translateY(12px) scale(.96);
        background:
          radial-gradient(circle at 36% 24%, rgba(255, 255, 255, .76), rgba(255, 255, 255, .3) 16%, transparent 32%),
          linear-gradient(145deg, #e7e7e7 0%, #d1d1d1 50%, #aeb0b3 100%);
        box-shadow:
          inset 0 6px 2px rgba(255, 255, 255, .58),
          inset 0 14px 8px rgba(120, 120, 120, .24),
          inset 0 -4px 2px rgba(255, 255, 255, .2),
          0 1px 1px #8f8f8f,
          0 7px 14px rgba(0, 0, 0, .28);
      }

      .ykt-body {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-height: 0;
        max-height: calc(min(74vh, 680px) - 52px);
        overflow: hidden;
        padding: 12px;
      }

      .ykt-status {
        min-height: 34px;
        max-height: 78px;
        flex: 0 0 auto;
        margin-bottom: 10px;
        padding: 8px 10px;
        border: 1px solid var(--ykt-line);
        border-radius: var(--ykt-radius-control);
        color: var(--ykt-muted);
        background: rgba(0, 0, 0, .28);
        font: 500 12px/1.45 var(--ykt-font-sans);
        overflow-y: auto;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, .18) transparent;
      }

      .ykt-status::-webkit-scrollbar,
      .ykt-results::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }

      .ykt-status::-webkit-scrollbar-track,
      .ykt-results::-webkit-scrollbar-track {
        background: transparent;
      }

      .ykt-status::-webkit-scrollbar-thumb,
      .ykt-results::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255, 255, 255, .18);
        background-clip: content-box;
      }

      .ykt-status::-webkit-scrollbar-thumb:hover,
      .ykt-results::-webkit-scrollbar-thumb:hover {
        background: rgba(25, 195, 125, .3);
        background-clip: content-box;
      }

      .ykt-actions {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .ykt-primary-button {
        position: relative;
        overflow: hidden;
        z-index: 0;
        border: 1px solid rgba(16, 163, 127, .26);
        border-radius: 999px;
        padding: 10px 17px;
        color: var(--ykt-accent-strong);
        background:
          radial-gradient(circle at 24% 18%, rgba(255, 255, 255, .08), transparent 32%),
          rgba(16, 163, 127, .1);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .08),
          0 8px 18px rgba(0, 0, 0, .18);
        cursor: pointer;
        font: 800 12px/1 var(--ykt-font-sans);
        letter-spacing: .02em;
        transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease, background .22s ease;
      }

      .ykt-primary-button:hover {
        transform: translateY(-1px);
        border-color: rgba(16, 163, 127, .42);
        background:
          radial-gradient(circle at 24% 18%, rgba(255, 255, 255, .11), transparent 32%),
          rgba(16, 163, 127, .15);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .1),
          0 10px 22px rgba(0, 0, 0, .2),
          0 0 24px rgba(16, 163, 127, .08);
      }

      .ykt-primary-button::after {
        content: "";
        position: absolute;
        z-index: 1;
        left: 0;
        bottom: 0;
        width: 180px;
        height: 180px;
        border-radius: 999px;
        background:
          radial-gradient(circle at 34% 28%, rgba(255, 255, 255, .96), rgba(255, 255, 255, .48) 22%, transparent 42%),
          linear-gradient(145deg, rgba(255, 255, 255, .92), rgba(232, 232, 232, .72) 58%, rgba(196, 198, 201, .58));
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, .72),
          inset 0 -6px 3px rgba(130, 130, 130, .16);
        transform: translate(-105%, 55%);
        transition: transform .34s ease, border-radius .34s ease;
        pointer-events: none;
      }

      .ykt-primary-button span {
        position: relative;
        z-index: 2;
        color: var(--ykt-accent-strong);
        text-shadow: 0 0 10px rgba(25, 195, 125, .16);
      }

      .ykt-primary-button:hover span {
        color: #06140f;
        text-shadow: 0 1px 0 rgba(255, 255, 255, .45);
      }

      .ykt-primary-button:hover::after {
        border-radius: 0;
        transform: translate(0, 0);
      }

      .ykt-primary-button:active {
        transform: translateY(0);
      }

      .ykt-primary-button:focus-visible {
        outline: 2px solid rgba(25, 195, 125, .45);
        outline-offset: 3px;
      }

      .ykt-tips {
        flex: 0 0 auto;
        margin-bottom: 12px;
        color: var(--ykt-muted);
        font-size: 12px;
        line-height: 1.55;
      }

      .ykt-results {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 12px;
        min-height: 0;
        max-height: none;
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 6px;
        padding-bottom: 8px;
        font-size: 12px;
        line-height: 1.5;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, .22) transparent;
        scrollbar-gutter: stable;
        contain: layout;
      }

      .ykt-empty {
        --ykt-empty-x: 50%;
        --ykt-empty-y: 50%;
        --ykt-empty-rx: 0deg;
        --ykt-empty-ry: 0deg;
        align-self: center;
        position: relative;
        width: fit-content;
        max-width: calc(100% - 12px);
        margin: 2px auto 4px;
        padding: 10px 12px;
        border: 1px dashed rgba(255, 255, 255, .16);
        border-radius: 999px;
        color: var(--ykt-muted);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, .045), rgba(255, 255, 255, .018)),
          rgba(255, 255, 255, .042);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .06),
          0 8px 18px rgba(0, 0, 0, .1);
        overflow: hidden;
        text-align: center;
        transform: perspective(720px) rotateX(var(--ykt-empty-rx)) rotateY(var(--ykt-empty-ry));
        transform-style: preserve-3d;
        transition:
          transform .28s ease,
          border-color .28s ease,
          box-shadow .28s ease,
          background .28s ease;
        white-space: normal;
      }

      .ykt-empty::before {
        content: "";
        position: absolute;
        inset: -45%;
        background:
          radial-gradient(circle at var(--ykt-empty-x) var(--ykt-empty-y), rgba(25, 195, 125, .22), transparent 28%),
          conic-gradient(from 160deg, transparent, rgba(255, 255, 255, .12), transparent 32%);
        opacity: 0;
        filter: blur(18px);
        pointer-events: none;
        transition: opacity .28s ease;
      }

      .ykt-empty::after {
        content: "";
        position: absolute;
        inset: 1px;
        border-radius: inherit;
        background:
          radial-gradient(circle at var(--ykt-empty-x) var(--ykt-empty-y), rgba(255, 255, 255, .14), transparent 24%),
          linear-gradient(120deg, rgba(255, 255, 255, .08), transparent 34%, rgba(16, 163, 127, .05));
        opacity: .45;
        pointer-events: none;
        transition: opacity .28s ease;
      }

      .ykt-empty span {
        position: relative;
        z-index: 1;
      }

      .ykt-empty.is-hovering {
        border-color: rgba(25, 195, 125, .36);
        background:
          radial-gradient(circle at var(--ykt-empty-x) var(--ykt-empty-y), rgba(25, 195, 125, .16), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, .045), rgba(255, 255, 255, .018)),
          rgba(255, 255, 255, .042);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .1),
          0 10px 22px rgba(0, 0, 0, .16),
          0 0 24px rgba(16, 163, 127, .08);
      }

      .ykt-empty.is-hovering::before {
        opacity: .9;
      }

      .ykt-empty.is-hovering::after {
        opacity: .72;
      }

      .ykt-empty.is-launching {
        pointer-events: none;
        border-color: rgba(25, 195, 125, .4);
        background:
          radial-gradient(circle at 74% 50%, rgba(25, 195, 125, .18), transparent 38%),
          linear-gradient(180deg, rgba(255, 255, 255, .05), rgba(255, 255, 255, .018)),
          rgba(255, 255, 255, .042);
        animation: ykt-empty-launch-card 1.18s cubic-bezier(.18, .9, .2, 1) forwards;
      }

      .ykt-empty.is-launching span {
        display: inline-block;
        animation: ykt-empty-launch-text .98s .12s cubic-bezier(.2, .9, .2, 1) forwards;
      }

      .ykt-empty.is-launching::before {
        opacity: .92;
        animation: ykt-empty-launch-aura 1.18s ease forwards;
      }

      .ykt-empty.is-launching::after {
        opacity: .8;
        animation: ykt-empty-launch-sheen 1.18s ease forwards;
      }

      @keyframes ykt-empty-launch-card {
        0% {
          opacity: 1;
          transform: perspective(720px) translateY(0) scale(1);
        }
        38% {
          opacity: 1;
          transform: perspective(720px) translateY(6px) scale(.985);
        }
        68% {
          opacity: .72;
          transform: perspective(720px) translateY(-8px) scale(.965);
        }
        100% {
          opacity: 0;
          transform: perspective(720px) translateY(-18px) scale(.92);
        }
      }

      @keyframes ykt-empty-launch-text {
        0% {
          opacity: 1;
          transform: translateY(0);
        }
        100% {
          opacity: 0;
          transform: translateY(-46px);
        }
      }

      @keyframes ykt-empty-launch-aura {
        0% {
          transform: translateY(0) scale(1);
        }
        100% {
          transform: translateY(-34px) scale(1.25);
        }
      }

      @keyframes ykt-empty-launch-sheen {
        0% {
          transform: translateX(-10%);
        }
        100% {
          transform: translateX(24%);
        }
      }

      .ykt-summary-card {
        flex: 0 0 auto;
        padding: 10px 8px;
        border: 1px solid rgba(255, 255, 255, .075);
        border-radius: var(--ykt-radius-card);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, .035), rgba(255, 255, 255, .015)),
          rgba(24, 24, 24, .72);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .055),
          0 10px 22px rgba(0, 0, 0, .14);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      .ykt-section-title {
        margin-bottom: 8px;
        color: var(--ykt-accent-strong);
        font: 800 11px/1 var(--ykt-font-sans);
        letter-spacing: .08em;
      }

      .ykt-answer-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 7px;
      }

      .ykt-answer-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 8px 11px;
        border: 1px solid rgba(16, 163, 127, .11);
        border-radius: 999px;
        background:
          radial-gradient(circle at 14% 18%, rgba(255, 255, 255, .07), transparent 32%),
          linear-gradient(180deg, rgba(255, 255, 255, .055), rgba(255, 255, 255, .025)),
          rgba(29, 29, 29, .68);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .075),
          inset 0 -1px rgba(0, 0, 0, .14),
          0 6px 14px rgba(0, 0, 0, .12);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        animation: ykt-row-enter .28s ease both;
      }

      @keyframes ykt-row-enter {
        from {
          opacity: 0;
          transform: translateY(8px) scale(.985);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .ykt-answer-index {
        color: rgba(25, 195, 125, .92);
        font: 800 11px/1 var(--ykt-font-mono);
        text-shadow: 0 0 10px rgba(25, 195, 125, .16);
      }

      .ykt-answer-right {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        min-width: 0;
      }

      .ykt-answer-value {
        min-width: 34px;
        overflow: hidden;
        color: var(--ykt-ink);
        font: 800 12px/1.15 var(--ykt-font-sans);
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ykt-answer-value.is-ready,
      .ykt-meta-row strong.is-ready {
        color: rgba(25, 195, 125, .92);
      }

      .ykt-answer-value.is-muted,
      .ykt-meta-row strong.is-muted {
        color: var(--ykt-warn);
      }

      .ykt-retry-button {
        border: 1px solid rgba(242, 166, 13, .24);
        border-radius: 999px;
        padding: 5px 8px;
        color: var(--ykt-warn);
        background: rgba(242, 166, 13, .08);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .06),
          0 6px 14px rgba(0, 0, 0, .12);
        cursor: pointer;
        font: 800 10px/1 var(--ykt-font-sans);
        white-space: nowrap;
        transition: transform .18s ease, border-color .18s ease, background .18s ease;
      }

      .ykt-retry-button:hover {
        transform: translateY(-1px);
        border-color: rgba(242, 166, 13, .42);
        background: rgba(242, 166, 13, .13);
      }

      .ykt-retry-button:disabled {
        cursor: wait;
        opacity: .72;
        transform: none;
      }

      .ykt-retry-button:focus-visible {
        outline: 2px solid rgba(242, 166, 13, .42);
        outline-offset: 2px;
      }

      .ykt-question-list {
        display: grid;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, .08);
      }

      .ykt-question-card {
        padding: 12px;
        border: 1px solid rgba(16, 163, 127, .13);
        border-radius: var(--ykt-radius-card);
        background:
          radial-gradient(circle at 100% 0%, rgba(16, 163, 127, .025), transparent 38%),
          linear-gradient(145deg, rgba(255, 255, 255, .045), rgba(255, 255, 255, .018) 42%, rgba(0, 0, 0, .14)),
          rgba(18, 18, 18, .96);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .08),
          inset 0 0 18px rgba(255, 255, 255, .018),
          0 10px 24px rgba(0, 0, 0, .18),
          0 0 20px rgba(16, 163, 127, .025);
        backdrop-filter: blur(10px) saturate(1.08);
        -webkit-backdrop-filter: blur(10px) saturate(1.08);
        overflow: hidden;
        contain: layout;
      }

      .ykt-question-card.is-entering {
        animation: ykt-card-enter .92s cubic-bezier(.16, .84, .24, 1) both;
        animation-delay: calc(min(var(--ykt-card-order, 1), 10) * 90ms);
      }

      @keyframes ykt-card-enter {
        0% {
          opacity: 0;
          transform: translateY(14px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .ykt-question-head,
      .ykt-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }

      .ykt-question-head > span,
      .ykt-meta-row > span {
        min-width: 0;
      }

      .ykt-question-head {
        margin-bottom: 7px;
        font-weight: 760;
      }

      .ykt-type {
        color: rgba(236, 236, 236, .76);
        font-size: 11px;
        font-weight: 600;
      }

      .ykt-meta-row {
        color: var(--ykt-muted);
        font-family: var(--ykt-font-sans);
        font-size: 11px;
      }

      .ykt-meta-row strong {
        flex: 0 0 auto;
        color: var(--ykt-ink);
        font-size: 12px;
      }

      .ykt-thumb-row {
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
        margin-top: 8px;
        overflow: hidden;
        max-width: 100%;
      }

      .ykt-thumb {
        display: block;
        flex: 0 0 54px;
        width: 54px !important;
        height: 42px !important;
        min-width: 54px;
        max-width: 54px !important;
        min-height: 42px;
        max-height: 42px !important;
        object-fit: cover;
        border: 1px solid rgba(255, 255, 255, .16);
        border-radius: var(--ykt-radius-small);
        background: rgba(255, 255, 255, .08);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .14),
          0 6px 14px rgba(0, 0, 0, .18);
      }

      .ykt-thumb-more {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 42px;
        height: 42px;
        border: 1px solid rgba(16, 163, 127, .14);
        border-radius: var(--ykt-radius-small);
        color: var(--ykt-muted);
        background:
          radial-gradient(circle at 30% 20%, rgba(255, 255, 255, .08), transparent 38%),
          rgba(255, 255, 255, .045);
        box-shadow:
          inset 0 1px rgba(255, 255, 255, .08),
          0 6px 14px rgba(0, 0, 0, .14);
        font: 800 11px/1 var(--ykt-font-mono);
      }

      @media (max-width: 520px) {
        .ykt-study-panel {
          width: calc(100vw - 24px);
          max-height: min(78vh, 680px);
        }

        .ykt-body {
          max-height: calc(min(78vh, 680px) - 52px);
        }

      }

      @media (prefers-reduced-motion: reduce) {
        .ykt-primary-button {
          transition: none;
        }

        .ykt-primary-button:hover {
          transform: none;
        }

        .ykt-question-card,
        .ykt-answer-row,
        .ykt-empty.is-launching,
        .ykt-empty.is-launching span,
        .ykt-empty.is-launching::before,
        .ykt-empty.is-launching::after {
          animation: none;
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
      if (event.target.closest("button")) {
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
      if (panel.style.display === "none") {
        return;
      }
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(panel, { left: rect.left, top: rect.top });
      savePanelPosition(panel);
    });
  }

  function setPanelMinimized(minimized) {
    if (!STATE.panel || !STATE.orbNode) {
      return;
    }

    STATE.panel.style.display = minimized ? "none" : "";
    STATE.orbNode.style.display = minimized ? "grid" : "none";
    if (!minimized) {
      const rect = STATE.panel.getBoundingClientRect();
      applyPanelPosition(STATE.panel, { left: rect.left, top: rect.top });
    }
  }

  function createMiniOrb() {
    const orb = document.createElement("button");
    orb.type = "button";
    orb.className = "ykt-mini-orb";
    orb.title = "恢复学习整理助手";
    orb.setAttribute("aria-label", "恢复学习整理助手");
    const label = document.createElement("span");
    label.className = "ykt-orb-label";
    label.textContent = "ON";
    orb.appendChild(label);
    orb.addEventListener("click", () => setPanelMinimized(false));
    return orb;
  }

  function buildPanel() {
    injectPanelFonts();
    injectPanelStyles();

    const panel = document.createElement("div");
    panel.className = "ykt-study-panel";

    const header = document.createElement("div");
    header.className = "ykt-header";

    const controls = document.createElement("div");
    controls.className = "ykt-window-controls";

    const minimizeButton = document.createElement("button");
    minimizeButton.type = "button";
    minimizeButton.className = "ykt-control-dot";
    minimizeButton.title = "最小化";
    minimizeButton.setAttribute("aria-label", "最小化学习整理助手");
    minimizeButton.addEventListener("click", () => setPanelMinimized(true));

    const badge = document.createElement("div");
    badge.className = "ykt-badge";
    badge.textContent = "Vision";

    controls.appendChild(minimizeButton);
    header.appendChild(controls);
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
    list.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const button = event.target.closest("[data-ykt-retry]");
      if (!button) {
        return;
      }
      const index = Number(button.getAttribute("data-ykt-retry"));
      if (Number.isFinite(index)) {
        retryQuestion(index);
      }
    });
    list.addEventListener("pointermove", (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const empty = event.target.closest(".ykt-empty");
      if (!empty) {
        const currentEmpty = list.querySelector(".ykt-empty.is-hovering");
        if (currentEmpty) {
          currentEmpty.classList.remove("is-hovering");
          currentEmpty.style.setProperty("--ykt-empty-x", "50%");
          currentEmpty.style.setProperty("--ykt-empty-y", "50%");
          currentEmpty.style.setProperty("--ykt-empty-rx", "0deg");
          currentEmpty.style.setProperty("--ykt-empty-ry", "0deg");
        }
        return;
      }

      const rect = empty.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      empty.classList.add("is-hovering");
      empty.style.setProperty("--ykt-empty-x", `${Math.round(x * 100)}%`);
      empty.style.setProperty("--ykt-empty-y", `${Math.round(y * 100)}%`);
      empty.style.setProperty("--ykt-empty-rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
      empty.style.setProperty("--ykt-empty-ry", `${((x - 0.5) * 9).toFixed(2)}deg`);
    });
    list.addEventListener("pointerleave", () => {
      const empty = list.querySelector(".ykt-empty");
      if (!empty) {
        return;
      }
      empty.classList.remove("is-hovering");
      empty.style.setProperty("--ykt-empty-x", "50%");
      empty.style.setProperty("--ykt-empty-y", "50%");
      empty.style.setProperty("--ykt-empty-rx", "0deg");
      empty.style.setProperty("--ykt-empty-ry", "0deg");
    });

    body.appendChild(status);
    body.appendChild(actions);
    body.appendChild(tips);
    body.appendChild(list);
    panel.appendChild(header);
    panel.appendChild(body);

    STATE.panel = panel;
    STATE.orbNode = createMiniOrb();
    STATE.statusNode = status;
    STATE.listNode = list;
    renderResults();
    document.body.appendChild(panel);
    document.body.appendChild(STATE.orbNode);
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
      runVisionAnswerSummary,
      retryQuestion,
      setPanelMinimized
    };
  }

  init().catch((error) => {
    console.error("[study-helper] init failed", error);
  });
})();

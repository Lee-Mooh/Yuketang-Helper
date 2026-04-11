# YukeTang Study Summary Helper

一个用于雨课堂结果页的 Tampermonkey 用户脚本。脚本会在页面右下角生成一个悬浮面板，收集每道题的题图，并调用多模态 AI 直接根据题干和 A/B/C/D 选项推断答案，最后以列表形式汇总。

> 当前版本已经不走传统 OCR 文本识别，不再依赖百度 OCR、Tesseract 或“先 OCR 再答题”的流程。

## 功能

- 自动扫描雨课堂结果页中的题目块。
- 收集每道题的题图，保留页面出现顺序，避免小选项图被丢失。
- 将题图直接发送给支持图片输入的 AI 模型。
- 要求 AI 只返回单选答案：`A`、`B`、`C`、`D`，无法判断时返回 `X`。
- 在面板顶部以“一行一题”的方式展示 `AI 答案汇总`。
- 在每题详情中显示已收集题图数量和题图缩略图，方便排查是否抓错图。
- 黑色 ChatGPT 风格悬浮 UI，字体栈偏 Claude / Anthropic 风格。

## 使用方式

1. 安装浏览器扩展 Tampermonkey。
2. 新建用户脚本。
3. 将 `yuketang.helper.js` 的内容粘贴进去并保存。
4. 打开雨课堂结果页：

```text
https://changjiang-exam.yuketang.cn/result/*
```

5. 先把页面滚动到底部，确保 20 道题都已经加载出来。
6. 点击右下角面板里的 `识图答题 + 汇总`。
7. 等待脚本完成题图收集和 AI 答题。

## 配置

主要配置位于 `yuketang.helper.js` 顶部的 `CONFIG`：
可在[火山引擎](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=model)中获取免费的多模态AI api key

```js
const CONFIG = {
  maxImagesPerQuestion: 8,
  imageFetchConcurrency: 2,
  imageMaxWidth: 1400,
  imageMaxHeight: 1400,
  imageQuality: 0.82,
  showImagePreview: true,
  ai: {
    enabled: true,
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    apiKey: "你的 API Key",
    model: "你的多模态模型 ID",
    requestTimeoutMs: 180000,
    retryCount: 2,
    retryDelayMs: 2500
  }
};
```

常用配置说明：

- `maxImagesPerQuestion`：每题最多发送多少张图片。题干和选项被拆成多张图时，建议保持 `8` 或更高。
- `imageFetchConcurrency`：并发获取题图数量。太高可能触发网络或接口限制，建议 `1` 到 `2`。
- `imageMaxWidth` / `imageMaxHeight`：图片压缩尺寸上限。
- `imageQuality`：JPEG 压缩质量，数值越高越清晰，但请求体越大。
- `showImagePreview`：是否在面板里显示已发送题图缩略图。
- `ai.model`：多模态模型 ID。模型能力会明显影响数学题识别和推理效果。

## 准确率说明

如果答案大量显示 `X`，通常不是单一原因，优先检查这几项：

- 面板里的题图缩略图是否包含完整题干和 A/B/C/D 选项。
- 页面是否没有滚动到底部，导致后面的题目还没加载。
- 当前模型是否支持高质量图片理解和数学公式推理。
- `maxImagesPerQuestion` 是否太小，导致选项图没有发送给 AI。
- 图片是否过于模糊、被水印遮挡，或者页面本身只渲染了残缺题图。

如果缩略图完整但仍大量返回 `X`，更可能是模型能力不足。可以尝试把 `ai.model` 换成更强的视觉/数学推理模型，例如同平台的 pro / thinking / vision 能力更强的模型。

## 安全提醒

- 不建议把真实 `apiKey` 提交到公开仓库。
- 如果要分享脚本，请先把 `CONFIG.ai.apiKey` 改成占位符。
- 脚本会把题目图片发送给你配置的 AI 服务，请确认这些内容允许被发送到对应服务。

## 常见问题

### 为什么不是 OCR？

之前 OCR 经常漏掉公式、上下标、分式和 A/B/C/D 选项。当前方案改为直接把题图交给多模态 AI，让模型自己看图、理解题干和选项，再推断答案。

### 为什么要先滚动到底部？

雨课堂结果页可能是懒加载。没有滚动到底部时，后面的题目图片可能还没有插入 DOM，脚本就抓不到完整 20 道题。

### 为什么有些题显示“未获取到题图”？

可能是题目没有使用 `<img>` 渲染，或者图片尺寸太小被过滤。可以适当调低：

```js
minQuestionImageWidth: 120,
minQuestionImageHeight: 40
```

### 为什么 AI 会答错？

这个脚本只负责收集题图、发送给 AI、整理返回结果。最终答案质量取决于：

- 图片是否完整。
- 模型是否真的看懂公式和选项。
- 模型数学推理能力。
- 请求是否超时或被限流。

如果你想优先提升正确率，建议先用更强的多模态模型；如果想优先提升速度，可以降低图片尺寸、降低 `maxImagesPerQuestion` 或减少重试次数。

## 文件

- `yuketang.helper.js`：Tampermonkey 用户脚本主体。

## License

`MIT`

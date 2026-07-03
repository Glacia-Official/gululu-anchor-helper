// ==UserScript==
// @name         Gululu 收安价助手 - Backend 自动填充检查版
// @namespace    https://www.gululu.world/
// @version      0.7.4
// @description  给每个 ContentCard 正文卡片末尾加入“收安价”；优先从 __NEXT_DATA__ 的 directory 按楼层号填充 floorId，支持加权回复与右侧检查区
// @author       ChatGPT
// @match        https://www.gululu.world/*
// @match        http://www.gululu.world/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      backend.gululu.world
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /**
   * 请求时机：
   * - 页面加载、按钮注入阶段：不主动访问 backend。
   * - 点击“收安价”：打开面板，并优先从 __NEXT_DATA__.props.pageProps.bookFloorsStore.directory 按楼层号填充 floorId。
   * - 若 __NEXT_DATA__ 方案失败，才备用触发本楼原生评论按钮并嗅探网站自己的评论接口请求。
   * - 点击“开始收集”：脚本才主动请求 backend 的完整评论列表。
   *
   * 计入规则：
   * - 评论以“高级设置”里的任一安价前缀开头时，会被计入。
   * - 回复内容与“高级设置”里的任一加权关键词全文相同时，如果直接父评论本身写了某种安价，
   *   则该回复按父评论同一安价计入；计入用户为回复者。
   */

  const CONFIG = {
    backendBase: 'https://backend.gululu.world',

    contentCardSelector: 'div.ContentCard_card__g8pgx, div[class*="ContentCard_card__"]',
    commentButtonSelector: 'button.ContentCard_comment__CvEWO, button[class*="ContentCard_comment__"], [class*="ContentCard_comment__"]',

    sniffWaitMs: 2500,
    sniffNearestAncestorDepth: 6,

    defaultPageSize: 1000,
    maxPages: 20,
    maxChildDepth: 4,
    childFetchConcurrency: 5,

    defaultStartNumber: 1,
    localStartKey: 'gll-anjia-backend-start-number',
    localPolicyKey: 'gll-anjia-backend-user-policy',
    localPrefixesKey: 'gll-anjia-backend-prefixes',
    localWeightedKey: 'gll-anjia-backend-weighted-keywords',
    localAutoCollectKey: 'gll-anjia-backend-auto-collect',

    defaultAnjiaPrefixesText: '安价:/安价 /安价：/安阶:/安阶：',
    defaultWeightedKeywordsText: '加权/加權/加权。/加權。',

    injectDebounceMs: 400,
  };

  const POLICY_LABELS = {
    all: '全部接受',
    first: '保留最早的',
    last: '保留最晚的',
    merge: '合并至同一选项',
  };

  const COMMENT_PAGE_PATH = '/reader/opus/comment/page';
  const COMMENT_CHILDREN_PATH = '/reader/opus/comment/page-children';

  let injectTimer = 0;

  injectPageNetworkSnifferBridge();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      addStyle();
      scheduleInject();
      observePage();
      hookHistoryChange();
    }, { once: true });
  } else {
    addStyle();
    scheduleInject();
    observePage();
    hookHistoryChange();
  }

  /**
   * 注入页面上下文脚本，监听页面真实 fetch/XHR。
   * 这段本身不发起任何请求，只在站点自己请求评论接口时派发事件。
   */
  function injectPageNetworkSnifferBridge() {
    const script = document.createElement('script');
    script.textContent = `
      (() => {
        if (window.__gllAnjiaNetworkSnifferInstalled) return;
        window.__gllAnjiaNetworkSnifferInstalled = true;

        const TARGET = '/reader/opus/comment/page';

        function toUrl(input) {
          try {
            if (typeof input === 'string') return input;
            if (input && typeof input.url === 'string') return input.url;
            return String(input || '');
          } catch (_) {
            return '';
          }
        }

        function normalizeUrl(url) {
          try {
            return new URL(url, location.href).href;
          } catch (_) {
            return String(url || '');
          }
        }

        function notify(rawUrl, via) {
          try {
            const url = normalizeUrl(rawUrl);
            if (!url || !url.includes(TARGET)) return;

            window.dispatchEvent(new CustomEvent('gll-anjia-comment-api-url', {
              detail: {
                url,
                via,
                time: Date.now()
              }
            }));
          } catch (_) {}
        }

        try {
          const rawFetch = window.fetch;
          if (typeof rawFetch === 'function' && !rawFetch.__gllAnjiaWrapped) {
            const wrappedFetch = function(input, init) {
              const url = toUrl(input);
              notify(url, 'fetch-before');

              const result = rawFetch.apply(this, arguments);

              try {
                if (result && typeof result.then === 'function') {
                  return result.then((response) => {
                    try {
                      notify(response && response.url ? response.url : url, 'fetch-after');
                    } catch (_) {}
                    return response;
                  });
                }
              } catch (_) {}

              return result;
            };

            wrappedFetch.__gllAnjiaWrapped = true;
            window.fetch = wrappedFetch;
          }
        } catch (_) {}

        try {
          const XHR = window.XMLHttpRequest;
          if (XHR && XHR.prototype && !XHR.prototype.__gllAnjiaWrapped) {
            const rawOpen = XHR.prototype.open;
            XHR.prototype.open = function(method, url) {
              try {
                this.__gllAnjiaUrl = url;
                notify(url, 'xhr-open');
              } catch (_) {}

              return rawOpen.apply(this, arguments);
            };
            XHR.prototype.__gllAnjiaWrapped = true;
          }
        } catch (_) {}
      })();
    `;

    const target = document.documentElement || document.head || document.body;
    if (target) {
      target.appendChild(script);
      script.remove();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        const fallbackTarget = document.documentElement || document.head || document.body;
        fallbackTarget.appendChild(script);
        script.remove();
      }, { once: true });
    }
  }

  function addStyle() {
    if (document.getElementById('gll-anjia-style')) return;

    const style = document.createElement('style');
    style.id = 'gll-anjia-style';
    style.textContent = `
      .gll-anjia-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 12px 0 0;
        padding: 8px 0 0;
        border-top: 1px dashed rgba(120, 120, 120, .25);
        position: relative;
        z-index: 10;
      }

      .gll-anjia-btn,
      .gll-anjia-panel button {
        border: 1px solid rgba(90, 90, 90, .35);
        border-radius: 8px;
        background: #fff;
        color: #222;
        padding: 5px 10px;
        font-size: 13px;
        line-height: 1.4;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,.08);
      }

      .gll-anjia-btn:hover,
      .gll-anjia-panel button:hover {
        background: #f3f3f3;
      }

      .gll-anjia-btn[disabled],
      .gll-anjia-panel button[disabled] {
        opacity: .55;
        cursor: not-allowed;
      }

      .gll-anjia-mask {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, .42);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
      }

      .gll-anjia-panel {
        width: min(1180px, 96vw);
        max-height: 92vh;
        overflow: auto;
        background: #fff;
        color: #222;
        border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0,0,0,.28);
        padding: 16px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .gll-anjia-panel h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }

      .gll-anjia-controls {
        display: grid;
        grid-template-columns: max-content minmax(120px, 1fr) max-content minmax(120px, 1fr);
        gap: 10px;
        align-items: center;
        margin-bottom: 10px;
      }

      .gll-anjia-controls input,
      .gll-anjia-controls select {
        border: 1px solid #ccc;
        border-radius: 8px;
        padding: 5px 8px;
        font-size: 13px;
        background: #fff;
        color: #222;
        min-width: 0;
      }

      .gll-anjia-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 10px 0;
      }

      .gll-anjia-main {
        display: grid;
        grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
        gap: 12px;
        align-items: stretch;
      }

      .gll-anjia-column-title {
        margin: 0 0 6px;
        font-size: 13px;
        font-weight: 650;
      }

      .gll-anjia-output {
        width: 100%;
        min-height: 420px;
        box-sizing: border-box;
        resize: vertical;
        border: 1px solid #ccc;
        border-radius: 10px;
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 14px;
        line-height: 1.55;
        background: #fafafa;
        color: #111;
      }

      .gll-anjia-check {
        min-height: 420px;
        max-height: 62vh;
        overflow: auto;
        box-sizing: border-box;
        border: 1px solid #ccc;
        border-radius: 10px;
        padding: 8px;
        background: #fafafa;
      }

      .gll-anjia-check-empty {
        color: #777;
        font-size: 13px;
        padding: 10px;
      }

      .gll-anjia-check-comment {
        display: flex;
        gap: 8px;
        padding: 8px;
        margin: 0 0 8px;
        border: 1px solid rgba(0,0,0,.08);
        border-radius: 10px;
        background: #fff;
      }

      .gll-anjia-check-comment--child {
        margin-left: 34px;
      }

      .gll-anjia-check-comment--counted {
        background: #f3f3f3;
      }

      .gll-anjia-check-avatar {
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        object-fit: cover;
        background: #ddd;
      }

      .gll-anjia-check-body {
        min-width: 0;
        flex: 1 1 auto;
      }

      .gll-anjia-check-meta {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 3px;
      }

      .gll-anjia-check-name {
        font-size: 13px;
        font-weight: 650;
        color: #222;
      }

      .gll-anjia-check-name--counted {
        color: #999;
      }

      .gll-anjia-check-time {
        font-size: 12px;
        color: #999;
      }

      .gll-anjia-check-badge {
        font-size: 12px;
        color: #999;
        border: 1px solid rgba(0,0,0,.12);
        border-radius: 999px;
        padding: 0 6px;
      }

      .gll-anjia-check-content {
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .gll-anjia-check-comment--counted > .gll-anjia-check-avatar,
      .gll-anjia-check-comment--counted > .gll-anjia-check-body > .gll-anjia-check-meta,
      .gll-anjia-check-comment--counted > .gll-anjia-check-body > .gll-anjia-check-content {
        color: #888;
      }

      .gll-anjia-check-comment--counted > .gll-anjia-check-avatar {
        opacity: .55;
      }

      .gll-anjia-check-children {
        margin-top: 6px;
      }

      .gll-anjia-small {
        font-size: 12px;
        color: #666;
      }


      .gll-anjia-advanced {
        margin-top: 10px;
        border: 1px solid rgba(0,0,0,.12);
        border-radius: 10px;
        background: #fff;
        padding: 8px 10px;
        font-size: 13px;
      }

      .gll-anjia-advanced summary {
        cursor: pointer;
        font-weight: 650;
      }

      .gll-anjia-advanced-help {
        margin: 8px 0;
        color: #666;
        line-height: 1.55;
      }

      .gll-anjia-advanced label {
        display: block;
        margin: 8px 0 4px;
        font-weight: 650;
      }

      .gll-anjia-advanced textarea {
        width: 100%;
        min-height: 52px;
        box-sizing: border-box;
        resize: vertical;
        border: 1px solid #ccc;
        border-radius: 8px;
        padding: 7px 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 13px;
        line-height: 1.45;
        background: #fafafa;
        color: #111;
      }

      .gll-anjia-advanced-check {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0;
        font-weight: 400;
      }

      .gll-anjia-advanced-check input {
        width: 16px;
        height: 16px;
      }

      .gll-anjia-advanced-reset {
        margin-top: 10px;
      }

      .gll-anjia-title {
        min-height: 24px;
      }

      @media (max-width: 860px) {
        .gll-anjia-controls {
          grid-template-columns: 1fr;
          justify-items: stretch;
        }

        .gll-anjia-main {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function observePage() {
    const observer = new MutationObserver(() => scheduleInject());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function hookHistoryChange() {
    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const ret = rawPushState.apply(this, args);
      scheduleInject();
      return ret;
    };

    history.replaceState = function (...args) {
      const ret = rawReplaceState.apply(this, args);
      scheduleInject();
      return ret;
    };

    window.addEventListener('popstate', () => scheduleInject());
  }

  function scheduleInject() {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(injectButtonsIntoContentCards, CONFIG.injectDebounceMs);
  }

  function injectButtonsIntoContentCards() {
    const cards = findContentCards();

    cards.forEach((card, index) => {
      if (card.dataset.gllAnjiaBackendBound === '1') return;

      card.dataset.gllAnjiaBackendBound = '1';
      attachButtonToContentCard(card, {
        cardIndex: index + 1,
        label: `第 ${index + 1} 个正文卡片`,
      });
    });
  }

  function findContentCards() {
    return safeQueryAll(document, CONFIG.contentCardSelector)
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => !el.closest('.gll-anjia-mask'));
  }

  function attachButtonToContentCard(card, ctx) {
    const bar = document.createElement('div');
    bar.className = 'gll-anjia-toolbar';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gll-anjia-btn';
    btn.textContent = '收安价';
    btn.title = '收集本楼评论中的安价/安阶';

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      openCollector({
        scope: card,
        label: ctx.label || `第 ${ctx.cardIndex || '?'} 个正文卡片`,
        autoSniff: true,
      });
    });

    const hint = document.createElement('span');
    hint.className = 'gll-anjia-small';
    hint.textContent = '收集本楼评论';

    bar.appendChild(btn);
    bar.appendChild(hint);
    card.appendChild(bar);
  }

  function openCollector(ctx) {
    const mask = document.createElement('div');
    mask.className = 'gll-anjia-mask';

    const panel = document.createElement('div');
    panel.className = 'gll-anjia-panel';
    panel.innerHTML = `
      <h2 class="gll-anjia-title" data-role="title">收安价</h2>

      <div class="gll-anjia-controls">
        <label>初始编号</label>
        <input data-role="start" type="number" step="1" />

        <label>同 userid 处理</label>
        <select data-role="policy">
          <option value="all">全部接受</option>
          <option value="first">保留最早的</option>
          <option value="last">保留最晚的</option>
          <option value="merge">合并至同一选项</option>
        </select>

        <span class="gll-anjia-small" data-role="scope"></span>
      </div>

      <div class="gll-anjia-actions">
        <button type="button" data-role="collect">开始收集</button>
        <button type="button" data-role="copy">复制输出</button>
        <button type="button" data-role="close">关闭</button>
      </div>

      <div class="gll-anjia-main">
        <div>
          <div class="gll-anjia-column-title">输出</div>
          <textarea class="gll-anjia-output" data-role="output" spellcheck="false"></textarea>

        </div>

        <div>
          <div class="gll-anjia-column-title">检查用：未计入安价的评论/回复</div>
          <div class="gll-anjia-check" data-role="check"></div>
        </div>
      </div>

          <details class="gll-anjia-advanced" data-role="advanced">
            <summary>高级设置（单击展开/单击收起）</summary>

            <label class="gll-anjia-advanced-check">
              <input type="checkbox" data-role="autoCollect" />
              点击“收安价”按钮后，自动开始收集
            </label>

            <div class="gll-anjia-advanced-help">
              下面两个输入框都用斜杠 <strong>/</strong> 分隔多项。比如 <strong>安价:/安阶:</strong> 表示有两项：“安价:”和“安阶:”。<br>
              如果某一项里本来就要包含斜杠，请把那个斜杠写成连续两个斜杠 <strong>//</strong>。
              例如 <strong>A//B</strong> 会被当成一个完整内容 <strong>A/B</strong>，不会被拆成 A 和 B。<br>
              除了用来分隔的斜杠以外，其它内容都会按普通文字理解；例如 <strong>.*</strong> 只会匹配真的 <strong>.*</strong>，不会变成任意内容。
            </div>

            <label>安价关键词（前缀匹配）</label>
            <textarea data-role="prefixes" spellcheck="false"></textarea>

            <label>加权关键词（全文匹配）</label>
            <textarea data-role="weighted" spellcheck="false"></textarea>

            <div class="gll-anjia-advanced-reset">
              <button type="button" data-role="resetAdvanced">重置高级设置</button>
            </div>
          </details>
    `;

    mask.appendChild(panel);
    document.documentElement.appendChild(mask);

    const title = panel.querySelector('[data-role="title"]');
    const startInput = panel.querySelector('[data-role="start"]');
    const policySelect = panel.querySelector('[data-role="policy"]');
    const output = panel.querySelector('[data-role="output"]');
    const checkBox = panel.querySelector('[data-role="check"]');
    const status = { textContent: '' };
    const scopeInfo = panel.querySelector('[data-role="scope"]');
    const collectBtn = panel.querySelector('[data-role="collect"]');
    const prefixesInput = panel.querySelector('[data-role="prefixes"]');
    const weightedInput = panel.querySelector('[data-role="weighted"]');
    const autoCollectInput = panel.querySelector('[data-role="autoCollect"]');
    const resetAdvancedBtn = panel.querySelector('[data-role="resetAdvanced"]');

    const internalIds = {
      opusId: '',
      floorId: '',
    };

    let titleResetTimer = 0;
    let latestRawEntries = [];
    let latestFinalEntries = [];
    let hasCollectedAtLeastOnce = false;
    let collectInProgress = false;

    startInput.value = String(readNumber(CONFIG.localStartKey, CONFIG.defaultStartNumber));
    policySelect.value = localStorage.getItem(CONFIG.localPolicyKey) || 'all';
    prefixesInput.value = localStorage.getItem(CONFIG.localPrefixesKey) || CONFIG.defaultAnjiaPrefixesText;
    weightedInput.value = localStorage.getItem(CONFIG.localWeightedKey) || CONFIG.defaultWeightedKeywordsText;
    autoCollectInput.checked = localStorage.getItem(CONFIG.localAutoCollectKey) !== 'false';

    prefixesInput.addEventListener('input', () => {
      localStorage.setItem(CONFIG.localPrefixesKey, prefixesInput.value);
    });

    weightedInput.addEventListener('input', () => {
      localStorage.setItem(CONFIG.localWeightedKey, weightedInput.value);
    });

    autoCollectInput.addEventListener('change', () => {
      localStorage.setItem(CONFIG.localAutoCollectKey, autoCollectInput.checked ? 'true' : 'false');
    });

    resetAdvancedBtn.addEventListener('click', () => {
      const ok = window.confirm(
        '确定要重置高级设置吗？\n\n这会恢复默认的安价关键词、加权关键词，并重新开启“点击收安价按钮后自动开始收集”。'
      );

      if (!ok) return;

      prefixesInput.value = CONFIG.defaultAnjiaPrefixesText;
      weightedInput.value = CONFIG.defaultWeightedKeywordsText;
      autoCollectInput.checked = true;

      localStorage.setItem(CONFIG.localPrefixesKey, prefixesInput.value);
      localStorage.setItem(CONFIG.localWeightedKey, weightedInput.value);
      localStorage.setItem(CONFIG.localAutoCollectKey, 'true');
    });

    startInput.addEventListener('input', () => {
      rerenderOutputFromLatest();
    });

    policySelect.addEventListener('change', () => {
      rerenderOutputFromLatest();
    });

    scopeInfo.textContent = `范围：${ctx.label || '当前正文卡片'}。`;
    renderCheckEmpty(checkBox, '尚未收集。开始收集后，这里会显示需要人工检查的评论。');

    function setTitleStage(stage, autoReset) {
      clearTimeout(titleResetTimer);

      title.textContent = stage ? `收安价（${stage}）` : '收安价';

      if (autoReset) {
        titleResetTimer = setTimeout(() => {
          if (mask.isConnected) {
            title.textContent = '收安价';
          }
        }, 5000);
      }
    }

    function rerenderOutputFromLatest() {
      const start = normalizeInt(startInput.value, CONFIG.defaultStartNumber);
      const policy = policySelect.value;

      localStorage.setItem(CONFIG.localStartKey, String(start));
      localStorage.setItem(CONFIG.localPolicyKey, policy);

      if (latestRawEntries.length > 0) {
        latestFinalEntries = applyUserPolicy(latestRawEntries, policy);
        output.value = formatOutput(latestFinalEntries, start);
      }
    }


    async function runSniff() {
      setTitleStage('正在自动填充', false);
      status.textContent = '正在自动填充本楼信息：优先读取页面数据；如失败会展开评论区且需要稍等 ...';

      try {
        const result = await autoFillIdsForCard(ctx.scope, (msg) => {
          status.textContent = msg;
        });

        if (result && result.opusId) internalIds.opusId = String(result.opusId);
        if (result && result.floorId) internalIds.floorId = String(result.floorId);

        if (result && result.floorId) {
          setTitleStage('已识别，正在准备收集', false);
          status.textContent = [
            '自动填充完成。',
            result.floorNumber ? `已识别：${result.floorNumber}F` : '已识别本楼。',
          ].join('\n');

          if (autoCollectInput.checked) {
            await runCollect();
          } else {
            setTitleStage('已识别', true);
          }
        } else {
          setTitleStage('识别失败', true);
          status.textContent = [
            '自动填充失败：未能识别本楼信息。',
            '可先确认当前楼层在页面中正常显示，然后关闭面板重新点击“收安价”。',
          ].join('\n');
        }
      } catch (err) {
        setTitleStage('识别失败', true);
        status.textContent = `自动填充失败：${err && err.message ? err.message : String(err)}`;
      }
    }

    async function runCollect() {
      if (collectInProgress) return;
      collectInProgress = true;

      const opusId = normalizePositiveInt(internalIds.opusId);
      const floorId = normalizePositiveInt(internalIds.floorId);
      const start = normalizeInt(startInput.value, CONFIG.defaultStartNumber);
      const size = CONFIG.defaultPageSize;
      const policy = policySelect.value;
      const settings = readAdvancedSettings(prefixesInput.value, weightedInput.value);

      localStorage.setItem(CONFIG.localStartKey, String(start));
      localStorage.setItem(CONFIG.localPolicyKey, policy);
      localStorage.setItem(CONFIG.localPrefixesKey, prefixesInput.value);
      localStorage.setItem(CONFIG.localWeightedKey, weightedInput.value);

      if (!settings.anjiaPrefixes.length) {
        status.textContent = '高级设置里的“安价关键词（前缀匹配）”为空，无法收集。';
        collectInProgress = false;
        return;
      }

      if (!opusId || !floorId) {
        status.textContent = '未能识别本楼信息。请关闭面板后重新点击“收安价”。';
        collectInProgress = false;
        return;
      }

      collectBtn.disabled = true;
      latestRawEntries = [];
      latestFinalEntries = [];
      output.value = '';
      renderCheckEmpty(checkBox, '正在收集评论 ...');
      status.textContent = '正在请求顶层评论 ...';
      setTitleStage('正在收集顶层评论', false);

      try {
        const comments = await fetchAllFloorComments({
          opusId,
          floorId,
          size,
          onProgress: (msg) => {
            status.textContent = msg;
          },
          onPhase: (stage) => {
            setTitleStage(stage, false);
          },
        });

        const analysis = analyzeComments(comments, settings);
        const rawEntries = analysis.entries;
        latestRawEntries = rawEntries;
        const finalEntries = applyUserPolicy(rawEntries, policy);
        latestFinalEntries = finalEntries;
        output.value = formatOutput(finalEntries, start);

        const countedUserKeys = new Set(rawEntries.map((e) => e.userKey));
        const checkStats = renderCheckPanel(checkBox, analysis, countedUserKeys);

        const childCount = comments.filter((c) => c.__isChild).length;
        const userCount = countedUserKeys.size;
        const weightedCount = rawEntries.filter((e) => e.source === 'weighted').length;

        status.textContent = [
          '请求完成。',
          `评论总数：${comments.length}`,
          `其中子评论：${childCount}`,
          `匹配安价/安阶原始项：${rawEntries.length}`,
          `其中“加权”继承项：${weightedCount}`,
          `涉及用户：${userCount}`,
          `输出项：${finalEntries.length}`,
          `检查区顶层评论：${checkStats.topShown}`,
          `检查区回复：${checkStats.childShown}`,
          `同 userid 处理：${POLICY_LABELS[policy]}`,
          rawEntries.length === 0 ? '注意：没有匹配到安价/安阶。' : '',
        ].filter(Boolean).join('\n');

        hasCollectedAtLeastOnce = true;
        collectBtn.textContent = '重新收集';
        setTitleStage('收集完成', true);

        output.focus();
        output.select();
      } catch (err) {
        status.textContent = `请求或解析失败：${err && err.message ? err.message : String(err)}`;
        setTitleStage('收集失败', true);
      } finally {
        collectInProgress = false;
        collectBtn.disabled = false;
        if (hasCollectedAtLeastOnce) {
          collectBtn.textContent = '重新收集';
        }
      }
    }

    collectBtn.addEventListener('click', runCollect);

    panel.querySelector('[data-role="copy"]').addEventListener('click', async () => {
      await copyText(output.value);
      status.textContent = `${status.textContent}\n已复制输出到剪贴板。`;
    });

    function close() {
      clearTimeout(titleResetTimer);
      mask.remove();
    }

    panel.querySelector('[data-role="close"]').addEventListener('click', close);

    mask.addEventListener('click', (ev) => {
      if (ev.target === mask) close();
    });

    document.addEventListener('keydown', function onEsc(ev) {
      if (ev.key === 'Escape' && mask.isConnected) {
        close();
        document.removeEventListener('keydown', onEsc);
      }
    });

    status.textContent = ctx.autoSniff
      ? '正在自动填充本楼信息：优先读取页面数据；如失败会展开评论区且需要稍等 ...'
      : '正在等待自动识别本楼信息。';

    if (ctx.autoSniff) {
      setTimeout(() => {
        if (!mask.isConnected) return;
        runSniff();
      }, 80);
    }
  }

  async function autoFillIdsForCard(card, onProgress) {
    const fromNextData = getIdsFromNextDataForCard(card);

    if (fromNextData && fromNextData.floorId) {
      return fromNextData;
    }

    if (onProgress) {
      onProgress('未能从页面数据自动识别，正在尝试展开评论区识别，需要稍等 ...');
    }

    const fromRequest = await sniffIdsByClickingLocalCommentButton(card);

    if (fromRequest && fromRequest.floorId) {
      return {
        ...fromRequest,
        source: '评论接口请求 URL',
      };
    }

    return null;
  }

  function getIdsFromNextDataForCard(card) {
    const nextData = parseNextData();
    if (!nextData) return null;

    const floorNumber = extractFloorNumberFromCard(card);
    if (!floorNumber) return null;

    const directory = getBookFloorDirectory(nextData);
    if (!Array.isArray(directory)) return null;

    const floorItem = directory[floorNumber - 1];
    if (!floorItem) return null;

    const floorId = normalizePositiveInt(
      floorItem.floorId ||
      floorItem.id ||
      floorItem.floor_id
    );

    if (!floorId) return null;

    const opusId = getOpusIdForBackend(nextData);

    return {
      source: '__NEXT_DATA__.props.pageProps.bookFloorsStore.directory',
      floorNumber,
      opusId,
      floorId,
    };
  }

  function parseNextData() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;

    try {
      return JSON.parse(script.textContent || '{}');
    } catch (_) {
      return null;
    }
  }

  function getBookFloorDirectory(nextData) {
    return (
      nextData?.props?.pageProps?.bookFloorsStore?.directory ||
      nextData?.props?.pageProps?.bookFloorsStore?.bookFloorsStore?.directory ||
      null
    );
  }

  function getOpusIdForBackend(nextData) {
    const fromPath = extractBookIdFromLocationPath();
    if (fromPath) return fromPath;

    const pageProps = nextData?.props?.pageProps || {};
    const candidates = [
      pageProps.opusId,
      pageProps.bookId,
      pageProps.bookInfo?.opusId,
      pageProps.bookInfo?.bookId,
      pageProps.bookInfo?.id,
      pageProps.book?.opusId,
      pageProps.book?.bookId,
      pageProps.book?.id,
      nextData?.query?.opusId,
      nextData?.query?.bookId,
    ];

    for (const value of candidates) {
      const n = normalizePositiveInt(value);
      if (n) return n;
    }

    return '';
  }

  function extractBookIdFromLocationPath() {
    const match = location.pathname.match(/\/book\/(\d+)/i);
    return match ? normalizePositiveInt(match[1]) : '';
  }

  function extractFloorNumberFromCard(card) {
    const candidates = [];
    const seen = new Set();
    const refRect = card && card.getBoundingClientRect ? card.getBoundingClientRect() : null;

    function addScope(scope, scopeWeight) {
      if (!scope || !(scope instanceof Element) || seen.has(scope)) return;
      seen.add(scope);

      const elements = [scope, ...safeQueryAll(scope, '*')];

      for (const el of elements) {
        const own = getOwnText(el);
        const full = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        const texts = [];

        if (own) texts.push(own);
        if (full && full.length <= 24) texts.push(full);

        for (const text of texts) {
          const match = text.match(/^#?\s*(\d{1,6})\s*F\s*$/i);
          if (!match) continue;

          const floorNumber = normalizePositiveInt(match[1]);
          if (!floorNumber) continue;

          let score = scopeWeight;
          if (refRect && el.getBoundingClientRect) {
            const rect = el.getBoundingClientRect();
            const dx = Math.abs((rect.left + rect.right) / 2 - (refRect.left + refRect.right) / 2);
            const dy = Math.abs((rect.top + rect.bottom) / 2 - refRect.top);
            score += dx / 1000 + dy / 100;

            // 楼层数常在右上角；轻微偏好位于 card 上方或右侧的短文本元素。
            if (rect.top <= refRect.top + 80) score -= 0.5;
            if (rect.left >= refRect.left) score -= 0.2;
          }

          candidates.push({ floorNumber, score, text });
        }
      }
    }

    addScope(card, 0);

    let cur = card ? card.parentElement : null;
    let depth = 1;
    while (cur && cur !== document.body && cur !== document.documentElement && depth <= 6) {
      addScope(cur, depth * 5);
      cur = cur.parentElement;
      depth += 1;
    }

    if (candidates.length === 0) {
      // 兜底：只扫描当前卡片自身文本，避免跨楼误取。
      const text = String(card?.textContent || '').replace(/\s+/g, ' ');
      const match = text.match(/(?:^|\s)#?\s*(\d{1,6})\s*F(?:\s|$)/i);
      if (match) return normalizePositiveInt(match[1]);
      return '';
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].floorNumber;
  }

  function getOwnText(el) {
    if (!el || !el.childNodes) return '';

    return Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function sniffIdsByClickingLocalCommentButton(card) {
    const commentButton = findLocalCommentButton(card);

    if (!commentButton) {
      throw new Error('没有在当前正文卡片附近找到评论按钮。');
    }

    const captured = [];
    let done = false;

    function handler(ev) {
      if (done) return;

      const detail = ev.detail || {};
      const parsed = parseCommentApiUrl(detail.url);

      if (!parsed || parsed.isChildrenEndpoint) return;
      if (!parsed.floorId) return;

      captured.push({
        ...parsed,
        via: detail.via,
        time: detail.time || Date.now(),
      });
    }

    window.addEventListener('gll-anjia-comment-api-url', handler);

    try {
      triggerUserLikeClick(commentButton);
      await sleep(CONFIG.sniffWaitMs);
      done = true;

      if (captured.length === 0) return null;

      captured.sort((a, b) => a.time - b.time);
      return captured[captured.length - 1];
    } finally {
      done = true;
      window.removeEventListener('gll-anjia-comment-api-url', handler);
    }
  }

  function findLocalCommentButton(card) {
    const inCard = safeQueryAll(card, CONFIG.commentButtonSelector)
      .filter((el) => el instanceof HTMLElement);

    if (inCard.length > 0) return inCard[0];

    let scope = card.parentElement;
    let depth = 1;

    while (
      scope &&
      scope !== document.body &&
      scope !== document.documentElement &&
      depth <= CONFIG.sniffNearestAncestorDepth
    ) {
      const buttons = safeQueryAll(scope, CONFIG.commentButtonSelector)
        .filter((el) => el instanceof HTMLElement);

      if (buttons.length > 0) {
        return chooseNearestElement(card, buttons);
      }

      scope = scope.parentElement;
      depth += 1;
    }

    return null;
  }

  function chooseNearestElement(reference, elements) {
    const refRect = reference.getBoundingClientRect();

    let best = null;
    let bestScore = Infinity;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const dx = Math.abs((rect.left + rect.right) / 2 - (refRect.left + refRect.right) / 2);
      const dy = Math.abs((rect.top + rect.bottom) / 2 - (refRect.top + refRect.bottom) / 2);
      const score = dx + dy * 2;

      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best || elements[0] || null;
  }

  function triggerUserLikeClick(el) {
    const events = [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ];

    for (const type of events) {
      try {
        const event = type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true, cancelable: true, view: window })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(event);
      } catch (_) {
        // ignore
      }
    }

    try {
      el.click();
    } catch (_) {
      // ignore
    }
  }

  function parseCommentApiUrl(rawUrl) {
    if (!rawUrl) return null;

    try {
      const url = new URL(rawUrl, location.href);
      const pathname = url.pathname;

      if (!pathname.includes(COMMENT_PAGE_PATH)) return null;

      const isChildrenEndpoint = pathname.includes(COMMENT_CHILDREN_PATH);
      const opusId = normalizePositiveInt(url.searchParams.get('opusId'));
      const floorId = normalizePositiveInt(url.searchParams.get('floorId'));
      const current = normalizePositiveInt(url.searchParams.get('current'));
      const size = normalizePositiveInt(url.searchParams.get('size'));
      const parentId = normalizePositiveInt(url.searchParams.get('parentId'));

      return {
        url: url.href,
        isChildrenEndpoint,
        opusId,
        floorId,
        current,
        size,
        parentId,
      };
    } catch (_) {
      return null;
    }
  }

  async function fetchAllFloorComments({ opusId, floorId, size, onProgress, onPhase }) {
    if (onPhase) onPhase('正在收集顶层评论');

    const topRecords = await fetchPaged({
      kind: 'page',
      opusId,
      floorId,
      size,
      onProgress: (msg) => onProgress(`顶层评论：${msg}`),
    });

    const all = topRecords.map((record) => ({
      ...record,
      __isChild: false,
      __parentFetchedFrom: 0,
      __depth: 0,
    }));

    const parents = topRecords.filter((record) => Number(record.childrenNum || 0) > 0);
    let fetchedParentCount = 0;

    await mapLimit(parents, CONFIG.childFetchConcurrency, async (parent) => {
      fetchedParentCount += 1;
      onProgress(
        `正在请求子评论：${fetchedParentCount}/${parents.length}\n` +
        `parentId=${parent.id}, childrenNum=${parent.childrenNum}`
      );

      if (onPhase) onPhase(`正在收集${parent.id}的子评论`);

      const children = await fetchChildrenRecursive({
        opusId,
        parent,
        size,
        depth: 1,
        onProgress,
        onPhase,
      });

      all.push(...children);
    });

    return all.sort(compareCommentOrder);
  }

  async function fetchChildrenRecursive({ opusId, parent, size, depth, onProgress, onPhase }) {
    if (!parent || !parent.id) return [];
    if (depth > CONFIG.maxChildDepth) return [];

    if (onPhase) onPhase(`正在收集${parent.id}的子评论`);

    const records = await fetchPaged({
      kind: 'children',
      opusId,
      parentId: parent.id,
      size,
      onProgress: (msg) => {
        onProgress(`${parent.id} 的子评论：${msg}`);
      },
    });

    const children = records.map((record) => ({
      ...record,
      __isChild: true,
      __parentFetchedFrom: parent.id,
      __depth: depth,
    }));

    const deeperParents = records.filter((record) => Number(record.childrenNum || 0) > 0);

    for (const deeper of deeperParents) {
      const deeperChildren = await fetchChildrenRecursive({
        opusId,
        parent: deeper,
        size,
        depth: depth + 1,
        onProgress,
        onPhase,
      });
      children.push(...deeperChildren);
    }

    return children;
  }

  async function fetchPaged({ kind, opusId, floorId, parentId, size, onProgress }) {
    const all = [];
    let current = 1;
    let total = Infinity;

    while (current <= CONFIG.maxPages && all.length < total) {
      const url = kind === 'page'
        ? buildCommentPageUrl({ opusId, floorId, current, size })
        : buildChildrenPageUrl({ opusId, parentId, current, size });

      onProgress(`请求第 ${current} 页 ...`);

      const json = await requestJSON(url);
      const data = json && json.data ? json.data : {};
      const records = Array.isArray(data.records) ? data.records : [];

      const reportedTotal = Number(data.total);
      if (Number.isFinite(reportedTotal)) total = reportedTotal;

      all.push(...records);

      if (records.length === 0) break;
      if (records.length < size) break;
      if (Number.isFinite(total) && all.length >= total) break;

      current += 1;
    }

    return all;
  }

  function buildCommentPageUrl({ opusId, floorId, current, size }) {
    const url = new URL('/reader/opus/comment/page', CONFIG.backendBase);
    url.searchParams.set('opusId', String(opusId));
    url.searchParams.set('floorId', String(floorId));
    url.searchParams.set('current', String(current));
    url.searchParams.set('size', String(size));
    return url.toString();
  }

  function buildChildrenPageUrl({ opusId, parentId, current, size }) {
    const url = new URL('/reader/opus/comment/page-children', CONFIG.backendBase);
    url.searchParams.set('opusId', String(opusId));
    url.searchParams.set('parentId', String(parentId));
    url.searchParams.set('current', String(current));
    url.searchParams.set('size', String(size));
    return url.toString();
  }

  function requestJSON(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
        anonymous: false,
        timeout: 30000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`HTTP ${res.status}: ${url}`));
            return;
          }

          try {
            resolve(JSON.parse(res.responseText));
          } catch (err) {
            reject(new Error(`JSON 解析失败：${err.message}`));
          }
        },
        onerror: () => reject(new Error(`网络错误：${url}`)),
        ontimeout: () => reject(new Error(`请求超时：${url}`)),
      });
    });
  }

  function analyzeComments(comments, settings) {
    const byId = new Map();
    const childrenByParent = new Map();
    const directOptionsById = new Map();
    const effectiveById = new Map();

    comments.forEach((comment, index) => {
      comment.__anjiaOrder = index;
      comment.__anjiaUserKey = getUserKey(comment, index);
      comment.__anjiaUserLabel = getUserLabel(comment);

      if (comment.id) byId.set(Number(comment.id), comment);

      const directOptions = extractOptions(comment.content || '', settings.anjiaPrefixes);
      directOptionsById.set(Number(comment.id || 0), directOptions);

      const parentId = getParentId(comment);
      if (!childrenByParent.has(parentId)) {
        childrenByParent.set(parentId, []);
      }
      childrenByParent.get(parentId).push(comment);
    });

    for (const list of childrenByParent.values()) {
      list.sort(compareCommentOrder);
    }

    function getEffective(comment) {
      if (!comment) return { options: [], source: 'none', inheritedFrom: 0 };
      const id = Number(comment.id || 0);

      if (effectiveById.has(id)) return effectiveById.get(id);

      const directOptions = directOptionsById.get(id) || [];
      if (directOptions.length > 0) {
        const ret = {
          options: directOptions,
          source: 'direct',
          inheritedFrom: 0,
        };
        effectiveById.set(id, ret);
        return ret;
      }

      const parentId = getParentId(comment);
      const parent = byId.get(parentId);
      const parentDirectOptions = parent ? (directOptionsById.get(Number(parent.id || 0)) || []) : [];

      if (isWeightedContent(comment.content, settings.weightedKeywords) && parent && parentDirectOptions.length > 0) {
        const ret = {
          options: parentDirectOptions,
          source: 'weighted',
          inheritedFrom: Number(parent.id || 0),
        };
        effectiveById.set(id, ret);
        return ret;
      }

      const ret = {
        options: [],
        source: 'none',
        inheritedFrom: 0,
      };
      effectiveById.set(id, ret);
      return ret;
    }

    const entries = [];

    comments.forEach((comment, index) => {
      const effective = getEffective(comment);
      if (effective.options.length === 0) return;

      const userKey = comment.__anjiaUserKey || getUserKey(comment, index);
      const userLabel = comment.__anjiaUserLabel || getUserLabel(comment);
      const timeMs = parseCommentTime(comment.createTime) || index;

      effective.options.forEach((option, optionIndex) => {
        entries.push({
          option,
          userKey,
          userLabel,
          commentId: comment.id || 0,
          parentId: getParentId(comment),
          createTime: comment.createTime || '',
          timeMs,
          order: index + optionIndex / 1000,
          isChild: Boolean(comment.__isChild),
          source: effective.source,
          inheritedFrom: effective.inheritedFrom,
          raw: comment,
        });
      });
    });

    return {
      comments,
      byId,
      childrenByParent,
      directOptionsById,
      effectiveById,
      getEffective,
      entries,
    };
  }

  function renderCheckPanel(container, analysis, countedUserKeys) {
    container.textContent = '';

    const stats = {
      topShown: 0,
      childShown: 0,
    };

    const topComments = (analysis.childrenByParent.get(0) || [])
      .slice()
      .sort(compareCommentOrder);

    for (const topComment of topComments) {
      const rendered = buildCheckNode(topComment, analysis, countedUserKeys, 0, stats);

      if (rendered) {
        container.appendChild(rendered);
      }
    }

    if (stats.topShown === 0 && stats.childShown === 0) {
      renderCheckEmpty(container, '没有需要检查的评论。');
    }

    return stats;
  }

  function buildCheckNode(comment, analysis, countedUserKeys, depth, stats) {
    const effective = analysis.getEffective(comment);
    const counted = effective.options.length > 0;

    const children = (analysis.childrenByParent.get(Number(comment.id || 0)) || [])
      .slice()
      .sort(compareCommentOrder);

    const renderedChildren = [];

    for (const child of children) {
      const childNode = buildCheckNode(child, analysis, countedUserKeys, depth + 1, stats);
      if (childNode) renderedChildren.push(childNode);
    }

    const shouldShow = depth === 0
      ? (!counted || renderedChildren.length > 0)
      : (!counted || renderedChildren.length > 0);

    if (!shouldShow) return null;

    if (depth === 0) stats.topShown += 1;
    else stats.childShown += 1;

    const node = renderCommentCard(comment, {
      counted,
      countedUser: countedUserKeys.has(comment.__anjiaUserKey || getUserKey(comment, comment.__anjiaOrder || 0)),
      depth,
      effective,
    });

    if (renderedChildren.length > 0) {
      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'gll-anjia-check-children';
      for (const childNode of renderedChildren) {
        childrenWrap.appendChild(childNode);
      }
      node.querySelector('.gll-anjia-check-body').appendChild(childrenWrap);
    }

    return node;
  }

  function renderCommentCard(comment, opts) {
    const card = document.createElement('div');
    card.className = 'gll-anjia-check-comment';

    if (opts.depth > 0) {
      card.classList.add('gll-anjia-check-comment--child');
    }

    if (opts.counted) {
      card.classList.add('gll-anjia-check-comment--counted');
    }

    const avatar = document.createElement('img');
    avatar.className = 'gll-anjia-check-avatar';
    avatar.alt = '';
    avatar.src = getUserAvatar(comment) || 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" rx="15" fill="#ddd"/></svg>'
    );

    const body = document.createElement('div');
    body.className = 'gll-anjia-check-body';

    const meta = document.createElement('div');
    meta.className = 'gll-anjia-check-meta';

    const name = document.createElement('span');
    name.className = 'gll-anjia-check-name';
    if (opts.countedUser) {
      name.classList.add('gll-anjia-check-name--counted');
    }
    name.textContent = getUserNickname(comment);

    const time = document.createElement('span');
    time.className = 'gll-anjia-check-time';
    time.textContent = comment.createTime || '';

    meta.appendChild(name);
    if (time.textContent) meta.appendChild(time);

    if (opts.counted) {
      const badge = document.createElement('span');
      badge.className = 'gll-anjia-check-badge';
      badge.textContent = opts.effective && opts.effective.source === 'weighted'
        ? '加权已计入'
        : '本评论已计入';
      meta.appendChild(badge);
    }

    const content = document.createElement('div');
    content.className = 'gll-anjia-check-content';
    content.textContent = String(comment.content || '');

    body.appendChild(meta);
    body.appendChild(content);

    card.appendChild(avatar);
    card.appendChild(body);

    return card;
  }

  function renderCheckEmpty(container, text) {
    container.textContent = '';

    const empty = document.createElement('div');
    empty.className = 'gll-anjia-check-empty';
    empty.textContent = text;

    container.appendChild(empty);
  }

  function readAdvancedSettings(prefixesText, weightedText) {
    return {
      anjiaPrefixes: normalizePrefixList(parseSlashSeparatedList(prefixesText, { trimItems: false })),
      weightedKeywords: normalizeKeywordList(parseSlashSeparatedList(weightedText, { trimItems: true })),
    };
  }

  function parseSlashSeparatedList(raw, options) {
    const trimItems = Boolean(options && options.trimItems);
    const text = String(raw || '');
    const items = [];
    let current = '';

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (ch === '/') {
        if (text[i + 1] === '/') {
          current += '/';
          i += 1;
        } else {
          items.push(trimItems ? current.trim() : current);
          current = '';
        }
      } else {
        current += ch;
      }
    }

    items.push(trimItems ? current.trim() : current);

    return items.filter((item) => item.length > 0);
  }

  function normalizePrefixList(items) {
    const seen = new Set();
    const out = [];

    for (const item of items) {
      const value = String(item || '').replace(/\r?\n/g, '');
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }

    return out.sort((a, b) => b.length - a.length);
  }

  function normalizeKeywordList(items) {
    const seen = new Set();
    const out = [];

    for (const item of items) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }

    return out;
  }

  function extractOptions(content, prefixes) {
    /*
     * 前缀按纯字符串匹配，不使用正则表达式。
     * 因此高级设置中的 .、*、?、[]、() 等字符没有特殊含义。
     */
    const text = String(content || '').replace(/\u00A0/g, ' ');
    const list = Array.isArray(prefixes) && prefixes.length
      ? prefixes
      : normalizePrefixList(parseSlashSeparatedList(CONFIG.defaultAnjiaPrefixesText, { trimItems: false }));

    const out = [];
    let index = 0;

    while (index < text.length) {
      const prefix = findPrefixAt(text, index, list);

      if (!prefix) {
        index += 1;
        continue;
      }

      const start = index + prefix.length;
      const end = findOptionEnd(text, start, list);
      const option = normalizeOption(text.slice(start, end));

      if (option) out.push(option);

      index = Math.max(end, start + 1);
    }

    return out;
  }

  function findPrefixAt(text, index, prefixes) {
    for (const prefix of prefixes) {
      if (prefix && text.startsWith(prefix, index)) {
        return prefix;
      }
    }

    return '';
  }

  function findOptionEnd(text, start, prefixes) {
    for (let i = start; i < text.length; i += 1) {
      if (findPrefixAt(text, i, prefixes)) {
        return i;
      }
    }

    return text.length;
  }

  function isWeightedContent(content, keywords) {
    /*
     * 加权关键词也是全文纯字符串匹配，不使用正则表达式。
     */
    const text = String(content || '').trim();
    const list = Array.isArray(keywords) && keywords.length
      ? keywords
      : normalizeKeywordList(parseSlashSeparatedList(CONFIG.defaultWeightedKeywordsText, { trimItems: true }));

    return list.includes(text);
  }

  function normalizeOption(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^[：:∶，,。；;、\s]+/, '')
      .replace(/[\s]+$/, '')
      .trim();
  }

  function getParentId(comment) {
    const parentId = Number(comment && comment.parentId ? comment.parentId : 0);
    if (parentId > 0) return parentId;

    const fetchedFrom = Number(comment && comment.__parentFetchedFrom ? comment.__parentFetchedFrom : 0);
    if (fetchedFrom > 0) return fetchedFrom;

    return 0;
  }

  function getUserKey(comment, fallbackIndex) {
    const id =
      comment.fromUserId ||
      comment.fromUser?.userId ||
      comment.userId ||
      comment.user?.userId;

    if (id !== undefined && id !== null && String(id) !== '0') {
      return `uid:${id}`;
    }

    const gid = comment.fromUser?.gid || comment.user?.gid;
    if (gid) return `gid:${gid}`;

    const name = comment.fromUser?.nickName || comment.user?.nickName;
    if (name) return `name:${name}`;

    return `unknown:${fallbackIndex}`;
  }

  function getUserLabel(comment) {
    const id =
      comment.fromUserId ||
      comment.fromUser?.userId ||
      comment.userId ||
      comment.user?.userId ||
      '';

    const name =
      comment.fromUser?.nickName ||
      comment.user?.nickName ||
      '';

    if (name && id) return `${name}(${id})`;
    if (name) return name;
    if (id) return String(id);
    return '未知用户';
  }

  function getUserNickname(comment) {
    return (
      comment.fromUser?.nickName ||
      comment.user?.nickName ||
      getUserLabel(comment)
    );
  }

  function getUserAvatar(comment) {
    return (
      comment.fromUser?.headPic ||
      comment.user?.headPic ||
      ''
    );
  }

  function applyUserPolicy(entries, policy) {
    if (policy === 'all') {
      return entries
        .slice()
        .sort(compareEntryOrder)
        .map((entry) => ({
          option: entry.option,
          order: entry.order,
          timeMs: entry.timeMs,
          users: [entry.userLabel],
          sourceEntries: [entry],
        }));
    }

    const groups = new Map();

    for (const entry of entries) {
      if (!groups.has(entry.userKey)) {
        groups.set(entry.userKey, []);
      }
      groups.get(entry.userKey).push(entry);
    }

    const items = [];

    for (const groupEntries of groups.values()) {
      groupEntries.sort(compareEntryTimeThenOrder);

      if (policy === 'first') {
        const first = groupEntries[0];
        items.push({
          option: first.option,
          order: first.order,
          timeMs: first.timeMs,
          users: [first.userLabel],
          sourceEntries: [first],
        });
      } else if (policy === 'last') {
        const last = groupEntries[groupEntries.length - 1];
        items.push({
          option: last.option,
          order: last.order,
          timeMs: last.timeMs,
          users: [last.userLabel],
          sourceEntries: [last],
        });
      } else if (policy === 'merge') {
        const sorted = groupEntries.slice().sort(compareEntryTimeThenOrder);
        const uniqueOptions = uniqueStrings(sorted.map((entry) => entry.option));
        const first = sorted[0];

        items.push({
          option: uniqueOptions.join('/'),
          order: first.order,
          timeMs: first.timeMs,
          users: [first.userLabel],
          sourceEntries: sorted,
        });
      }
    }

    return items.sort(compareEntryOrder);
  }

  function formatOutput(items, startNumber) {
    return items.map((item, idx) => `${startNumber + idx}. ${item.option}`).join('\n');
  }

  function compareCommentOrder(a, b) {
    const at = parseCommentTime(a.createTime);
    const bt = parseCommentTime(b.createTime);

    if (at !== bt) return at - bt;

    const aid = Number(a.id || 0);
    const bid = Number(b.id || 0);
    return aid - bid;
  }

  function compareEntryOrder(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    return a.timeMs - b.timeMs;
  }

  function compareEntryTimeThenOrder(a, b) {
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return a.order - b.order;
  }

  function parseCommentTime(value) {
    if (!value) return 0;

    const normalized = String(value).replace(/-/g, '/');
    const ms = Date.parse(normalized);

    return Number.isFinite(ms) ? ms : 0;
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.style.position = 'fixed';
    tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }

  async function mapLimit(items, limit, fn) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index], index);
      }
    }

    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    );

    await Promise.all(workers);
    return results;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeQueryAll(root, selector) {
    if (!root || !selector) return [];

    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function normalizePositiveInt(value) {
    const n = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : '';
  }

  function normalizeInt(value, fallback) {
    const n = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function readNumber(key, fallback) {
    const n = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];

    for (const value of values) {
      const key = String(value).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }

    return out;
  }
})();

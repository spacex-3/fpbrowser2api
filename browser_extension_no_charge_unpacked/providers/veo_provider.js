import { ensureTab as ensureGenericTab, fetchJson, compactErrorResponse, simulateHumanActivity, uploadDataUrlToAliyunOss } from "./common.js";

const URLS = {
  credits: "https://aisandbox-pa.googleapis.com/v1/credits",
  uploadImage: "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
  videoT2V: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
  videoI2VStart: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage",
  videoI2VStartEnd: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage",
  videoR2V: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
  videoEdit: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoEditVideo",
  videoPoll: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
  uploadVideoStart: "https://labs.google/fx/api/upload-video?action=start",
  uploadVideoChunk: "https://labs.google/fx/api/upload-video?action=upload",
  updateVideoOffset: "https://labs.google/fx/api/trpc/videoFx.updateVideoOffset",
  upsampleImage: "https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage",
  workflows: "https://aisandbox-pa.googleapis.com/v1/flowWorkflows"
};

function authHeaders(at) {
  return { "Accept": "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${at}` };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sessionId() { return `;${Date.now()}`; }
function randSeed(max = 99999) { return 1 + Math.floor(Math.random() * max); }

// VEO supports concurrent jobs in the same fingerprint-browser window. When
// several jobs reuse one labs.google tab, job B's submit/done refresh can
// destroy the frame while job A is running a MAIN-world fetch via
// chrome.scripting.executeScript; Chrome may then resolve with an undefined
// result ("pageFetchJson returned empty result ..."). Serialize per-tab
// navigation/refresh with frame-dependent executeScript calls, without locking
// the whole workflow, so video polling and separate jobs can still overlap.
const veoTabOpLocks = new Map();
const VEO_RUN_ID = Symbol("veoRunId");
const activeVeoTaskRuns = new Map();
const HUMAN_ACTIVITY_ACTIONS = new Set([
  "human_activity",
  "simulate_human_activity"
]);
const VEO_EDIT_OUTPUT_FPS = 24;
let veoTaskRunSeq = 0;
let veoHumanActivityPromise = null;
let veoHumanActivityInfo = null;

function beginVeoTaskRun(msg, runtime) {
  const taskId = String((runtime && runtime.taskId) || (msg && msg.task_id) || "unknown");
  const runId = `${taskId}:${Date.now()}:${++veoTaskRunSeq}`;
  activeVeoTaskRuns.set(runId, {
    task_id: taskId,
    provider: "veo",
    started_at: Date.now()
  });
  if (runtime) {
    try { runtime[VEO_RUN_ID] = runId; } catch (_) {}
  }
  return runId;
}

function endVeoTaskRun(runId, runtime) {
  if (runId) activeVeoTaskRuns.delete(runId);
  if (runtime) {
    try {
      if (runtime[VEO_RUN_ID] === runId) delete runtime[VEO_RUN_ID];
    } catch (_) {}
  }
}

function countOtherActiveVeoTaskRuns(runtime) {
  const currentRunId = runtime && runtime[VEO_RUN_ID];
  let n = 0;
  for (const runId of activeVeoTaskRuns.keys()) {
    if (runId !== currentRunId) n++;
  }
  return n;
}

async function waitForVeoHumanActivityIdle(runtime) {
  const p = veoHumanActivityPromise;
  if (!p) return false;
  try {
    await runtime.progress(1, {
      stage: "wait_human_activity",
      reason: "human_activity_running",
      human_activity: veoHumanActivityInfo || {}
    });
  } catch (_) {}
  try {
    await p;
  } catch (_) {}
  try {
    await runtime.progress(1, { stage: "wait_human_activity_done" });
  } catch (_) {}
  return true;
}

async function runVeoHumanActivityAction(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || p.target_url || p.veo_url || "https://labs.google/fx";
  if (activeVeoTaskRuns.size > 0) {
    try {
      await runtime.progress(100, {
        stage: "human_activity_skipped",
        reason: "veo_task_running",
        active_veo_tasks: activeVeoTaskRuns.size
      });
    } catch (_) {}
    return {
      type: "veo_human_activity",
      skipped: true,
      reason: "veo_task_running",
      active_veo_tasks: activeVeoTaskRuns.size
    };
  }
  if (veoHumanActivityPromise) {
    try {
      await runtime.progress(100, {
        stage: "human_activity_skipped",
        reason: "human_activity_already_running",
        human_activity: veoHumanActivityInfo || {}
      });
    } catch (_) {}
    return {
      type: "veo_human_activity",
      skipped: true,
      reason: "human_activity_already_running"
    };
  }

  const minMs = Math.max(1000, Number(p.human_activity_min_ms || p.min_ms || 10000) || 10000);
  const maxMs = Math.max(minMs + 1, Number(p.human_activity_max_ms || p.max_ms || 15000) || 15000);
  const startedAt = Date.now();
  veoHumanActivityInfo = {
    task_id: String((msg && msg.task_id) || (runtime && runtime.taskId) || ""),
    project_page: projectPage,
    started_at: startedAt,
    min_ms: minMs,
    max_ms: maxMs
  };
  const activityRuntime = {
    ...(runtime || {}),
    progress: async (progress, data = {}) => {
      try {
        if (runtime && typeof runtime.progress === "function") {
          await runtime.progress(progress, data);
        }
      } catch (_) {}
    }
  };

  veoHumanActivityPromise = (async () => {
    await activityRuntime.progress(2, { stage: "human_activity_ensure_tab", url: projectPage });
    const tabId = await ensureVeoProjectTab(projectPage, {
      navigate: p.navigate !== false,
      active: p.active !== false
    });
    const shouldReload = p.reload !== false && p.reload_page !== false;
    let reloaded = false;
    if (shouldReload) {
      reloaded = await reloadProjectPage(4, tabId, projectPage, activityRuntime, { skipActiveCheck: true });
    }
    const result = await simulateHumanActivity(tabId, activityRuntime, minMs, maxMs, {
      stage: "veo_human_activity",
      progress: 8,
      clickInputs: true,
      scroll: true,
      moveMouse: true
    });
    const elapsedMs = Date.now() - startedAt;
    await activityRuntime.progress(100, {
      stage: "human_activity_done",
      url: projectPage,
      tab_id: tabId,
      reloaded,
      elapsed_ms: elapsedMs,
      result
    });
    return {
      type: "veo_human_activity",
      skipped: false,
      project_page: projectPage,
      tab_id: tabId,
      reloaded,
      elapsed_ms: elapsedMs,
      result
    };
  })();

  try {
    return await veoHumanActivityPromise;
  } finally {
    veoHumanActivityPromise = null;
    veoHumanActivityInfo = null;
  }
}

async function shouldSkipProjectPageRefresh(progress, runtime, stage, url) {
  const otherActiveTasks = countOtherActiveVeoTaskRuns(runtime);
  if (!otherActiveTasks) return false;
  try {
    await runtime.progress(progress, {
      stage: `${stage}_skipped`,
      url,
      reason: "other_tasks_running",
      active_veo_tasks: activeVeoTaskRuns.size,
      other_active_veo_tasks: otherActiveTasks
    });
  } catch (_) {}
  return true;
}

async function withVeoTabOpLock(tabId, label, fn) {
  const key = `veo-tab:${String(tabId || "unknown")}`;
  const prev = veoTabOpLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prev.catch(() => {}).then(() => gate);
  veoTabOpLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    try { release(); } catch (_) {}
    if (veoTabOpLocks.get(key) === tail) veoTabOpLocks.delete(key);
  }
}

function isTransientPageFetchError(e) {
  const s = String((e && e.message) || e || "");
  return /empty result|frame.*(removed|detached|destroyed)|cannot access.*contents|extension context invalidated|no tab with id|tab.*closed|target closed|execution context.*destroyed/i.test(s);
}

function isNonRetryableVeoSubmitError(e) {
  const s = String((e && e.message) || e || "");
  if (!/\bVEO\s+(?:image|video)\s+submit\s+failed:/i.test(s)) return false;
  return /\bINVALID_ARGUMENT\b/i.test(s) || /\bPUBLIC_ERROR_USER_QUOTA_REACHED\b/i.test(s);
}

function archiveEnabled(p, key = "archive_workflow") {
  const v = p && Object.prototype.hasOwnProperty.call(p, key) ? p[key] : true;
  return v !== false;
}

function isVeoFlowPageUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && u.hostname === "labs.google" && u.pathname.startsWith("/fx/tools/flow");
  } catch (_) {
    return false;
  }
}

async function getCurrentWindowActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (Array.isArray(tabs) && tabs[0]) return tabs[0];
  } catch (_) {}
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    const tabs = Array.isArray(win && win.tabs) ? win.tabs : [];
    return tabs.find(t => t && t.active) || tabs[0] || null;
  } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    return (tabs || []).find(t => t && t.active) || (tabs || [])[0] || null;
  } catch (_) {
    return null;
  }
}

async function fetchVeoCurrentPageTask(msg, runtime) {
  const tab = await getCurrentWindowActiveTab();
  const url = String((tab && tab.url) || "");
  try {
    await runtime.progress(100, { stage: "current_page", url, is_flow_page: isVeoFlowPageUrl(url) });
  } catch (_) {}
  return {
    type: "veo_current_page",
    tab_id: tab && tab.id ? tab.id : null,
    window_id: tab && tab.windowId ? tab.windowId : null,
    url,
    title: String((tab && tab.title) || ""),
    is_flow_page: isVeoFlowPageUrl(url),
    required_url_prefix: "https://labs.google/fx/tools/flow"
  };
}

async function waitTabComplete(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

export async function dismissVeoChangelogModalIfPresent(tabId) {
  if (!tabId) return { clicked: false, reason: "no_tab_id" };
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = String((tab && tab.url) || "");
    if (!url.startsWith("https://labs.google/")) return { clicked: false, reason: "not_labs_google", url };
    if (tab && tab.status !== "complete") await waitTabComplete(tabId, 15000);
  } catch (_) {}
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        if (location.protocol !== "https:" || location.hostname !== "labs.google") {
          return { found: false, clicked: false, reason: "not_labs_google", url: String(location.href || "") };
        }
        const getText = () => String(document.body && document.body.innerText || "");
        const text = getText();
        const idx = text.toLowerCase().indexOf("view all changelogs");
        if (idx < 0) {
          return { found: false, clicked: false, reason: "changelog_modal_not_found", url: String(location.href || "") };
        }
        const x = Math.max(8, Math.min(24, window.innerWidth - 8));
        const y = Math.max(8, Math.min(Math.round(window.innerHeight / 2), window.innerHeight - 8));
        const target = document.elementFromPoint(x, y) || document.body || document.documentElement;
        const dispatch = (type, extra = {}) => {
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: Math.round((window.screenX || 0) + x),
            screenY: Math.round((window.screenY || 0) + y),
            button: 0,
            buttons: /down/i.test(type) ? 1 : 0,
            ...extra
          };
          try {
            if (type.startsWith("pointer") && window.PointerEvent) {
              target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            } else {
              target.dispatchEvent(new MouseEvent(type, init));
            }
          } catch (_) {}
        };
        dispatch("pointermove");
        dispatch("mousemove");
        await sleep(30);
        dispatch("pointerdown");
        dispatch("mousedown");
        await sleep(60);
        dispatch("pointerup");
        dispatch("mouseup");
        dispatch("click");
        await sleep(350);
        const dismissed = getText().toLowerCase().indexOf("view all changelogs") < 0;
        return {
          found: true,
          clicked: dismissed,
          dismissed,
          reason: dismissed ? undefined : "safe_area_click_did_not_dismiss",
          via: "dom_safe_area",
          x,
          y,
          url: String(location.href || ""),
          matched_text: text.slice(Math.max(0, idx - 40), idx + 80)
        };
      }
    });
    return Array.isArray(frames) && frames[0] && frames[0].result ? frames[0].result : { clicked: false, reason: "empty_execute_result" };
  } catch (e) {
    return { clicked: false, reason: "dismiss_failed", error: String((e && e.message) || e || "") };
  }
}

async function closeOtherTabsInSameWindow(keepTabId) {
  let keepTab = null;
  try { keepTab = await chrome.tabs.get(keepTabId); } catch (_) {}
  const query = keepTab && keepTab.windowId ? { windowId: keepTab.windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const removeIds = [];
  for (const tab of tabs || []) {
    if (!tab || !tab.id || tab.id === keepTabId) continue;
    removeIds.push(tab.id);
  }
  if (removeIds.length) {
    try { await chrome.tabs.remove(removeIds); } catch (_) {}
  }
  return removeIds.length;
}

function closeOtherTabsInSameWindowLater(keepTabId, delayMs = 5000) {
  setTimeout(() => {
    closeOtherTabsInSameWindow(keepTabId).catch(() => {});
  }, Math.max(0, Number(delayMs || 0) || 0));
}

async function ensureVeoProjectTab(projectPage, { active = true, navigate = true, create = true } = {}) {
  const targetUrl = projectPage || "https://labs.google/fx";
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find(t => (t.url || "") === targetUrl);
  const found = exact || tabs.find(t => (t.url || "").startsWith("https://labs.google/"));
  if (found && found.id) {
    if (navigate && targetUrl && found.url !== targetUrl) {
      await withVeoTabOpLock(found.id, "ensure_project_tab_navigate", async () => {
        await chrome.tabs.update(found.id, { url: targetUrl, active });
        await waitTabComplete(found.id, 45000);
        await sleep(1200);
      });
    } else {
      await chrome.tabs.update(found.id, { active });
    }
    await dismissVeoChangelogModalIfPresent(found.id);
    return found.id;
  }
  if (!create) return null;
  const tab = await chrome.tabs.create({ url: targetUrl, active });
  if (tab && tab.id) {
    await waitTabComplete(tab.id, 45000);
    await sleep(1200);
    await dismissVeoChangelogModalIfPresent(tab.id);
  }
  return tab.id;
}

async function assertProjectPageAccessible(projectPage, runtime) {
  const url = projectPage || "https://labs.google/fx";
  let resp = null;
  let text = "";
  try {
    await runtime.progress(2, { stage: "check_project_page", url, method: "GET" });
  } catch (_) {}
  try {
    resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });
    try { text = await resp.text(); } catch (_) { text = ""; }
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    throw new Error(`VEO project page GET failed: ${url}; Request Method: GET; error=${msg}`);
  }
  if (!resp || !resp.ok) {
    const status = resp ? resp.status : 0;
    const statusText = resp ? (resp.statusText || "") : "";
    const finalUrl = resp ? (resp.url || url) : url;
    const body = String(text || "").slice(0, 500);
    throw new Error(`VEO project page is not accessible: ${finalUrl}; Request Method: GET; Status Code: ${status}${statusText ? ` ${statusText}` : ""}; response: ${body}`);
  }
  try {
    await runtime.progress(2, { stage: "check_project_page_ok", url: resp.url || url, status: resp.status });
  } catch (_) {}
  return { status: resp.status, url: resp.url || url };
}

async function reloadProjectPage(progress, tabId, projectPage, runtime, options = {}) {
  return await withVeoTabOpLock(tabId, "reload_project_page", async () => {
    if (options.skipActiveCheck !== true && await shouldSkipProjectPageRefresh(progress, runtime, "reload_project_page", projectPage)) return false;
    await runtime.progress(progress, { stage: "reload_project_page", url: projectPage });
    try {
      // 单任务时对 project_page 做一次真实刷新；如果还有其它 VEO
      // 任务在跑，上面的检查会跳过刷新，避免销毁其它任务正在使用的 frame。
      await chrome.tabs.update(tabId, { active: true });
      await chrome.tabs.reload(tabId, { bypassCache: false });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      await dismissVeoChangelogModalIfPresent(tabId);
      return true;
    } catch (e) {
      // reload 失败时兜底导航到项目页，仍保证插件任务从 projectPage 开始。
      await chrome.tabs.update(tabId, { url: projectPage, active: true });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      await dismissVeoChangelogModalIfPresent(tabId);
      return true;
    }
  });
}

async function clearLabsGoogleLocalStorageBeforeReload(progress, tabId, projectPage, runtime) {
  return await withVeoTabOpLock(tabId, "clear_labs_google_local_storage", async () => {
    await runtime.progress(progress, {
      stage: "clear_labs_google_local_storage",
      url: projectPage,
      target_origin: "https://labs.google"
    });
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const currentUrl = String(location.href || "");
        if (location.protocol !== "https:" || location.hostname !== "labs.google") {
          return {
            cleared: false,
            reason: "not_labs_google_page",
            url: currentUrl,
            before: null,
            after: null
          };
        }
        const before = localStorage.length;
        localStorage.clear();
        return {
          cleared: true,
          url: currentUrl,
          before,
          after: localStorage.length
        };
      }
    });
    const result = Array.isArray(frames) && frames[0] ? frames[0].result : null;
    if (!result) throw new Error("clear labs.google localStorage returned empty result");
    if (!result.cleared) {
      throw new Error(`clear labs.google localStorage skipped: ${result.reason || "unknown"}; url=${result.url || ""}`);
    }
    await runtime.progress(progress, {
      stage: "clear_labs_google_local_storage_done",
      url: result.url,
      before: result.before,
      after: result.after
    });
    return result;
  });
}

async function resetLabsGoogleLocalStorageAndReload(progress, tabId, projectPage, runtime, options = {}) {
  const clearResult = await clearLabsGoogleLocalStorageBeforeReload(progress, tabId, projectPage, runtime);
  const reloaded = await reloadProjectPage(progress, tabId, projectPage, runtime, options);
  return { clearResult, reloaded };
}

async function resetLabsGoogleLocalStorageAndReloadForRetry(progress, tabId, projectPage, runtime, reason = "") {
  try {
    await resetLabsGoogleLocalStorageAndReload(progress, tabId, projectPage, runtime);
    return true;
  } catch (e) {
    try {
      await runtime.progress(progress, {
        stage: "clear_labs_google_local_storage_retry_failed",
        url: projectPage,
        reason,
        error: String((e && e.message) || e || "").slice(0, 300)
      });
    } catch (_) {}
    return false;
  }
}

async function pageFetchJson(tabId, url, { method = "GET", headers = {}, body = null, attempts = 3, timeoutMs = 0 } = {}) {
  let lastErr = null;
  let lastAttempt = 0;
  const reqMethod = String(method || "GET").toUpperCase();
  const maxAttempts = Math.max(1, Number.parseInt(attempts, 10) || 1);
  const requestTimeoutMs = Math.max(0, Number(timeoutMs || 0) || 0);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptNo = attempt + 1;
    lastAttempt = attemptNo;
    try {
      const result = await withVeoTabOpLock(tabId, "page_fetch_json", async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
        } catch (_) {}
        const frames = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [url, { method, headers, body, timeoutMs: requestTimeoutMs }],
          func: async (u, opts) => {
            const timeoutMs = Math.max(0, Number(opts.timeoutMs || 0) || 0);
            const controller = timeoutMs > 0 && typeof AbortController !== "undefined" ? new AbortController() : null;
            let timer = null;
            const init = {
              method: opts.method || "GET",
              headers: opts.headers || {},
              credentials: "include"
            };
            if (controller) {
              init.signal = controller.signal;
              timer = setTimeout(() => {
                try { controller.abort(); } catch (_) {}
              }, timeoutMs);
            }
            if (opts.body !== null && opts.body !== undefined) {
              init.body = JSON.stringify(opts.body);
            }
            try {
              const resp = await fetch(u, init);
              const text = await resp.text();
              const hdrs = {};
              try {
                for (const [k, v] of resp.headers.entries()) hdrs[k] = v;
              } catch (_) {}
              let json = null;
              try { json = text ? JSON.parse(text) : null; } catch (_) {}
              return { status: resp.status, headers: hdrs, text, json, url: resp.url };
            } catch (e) {
              const name = String((e && e.name) || "");
              const msg = String((e && e.message) || e || "unknown error");
              if (name === "AbortError") throw new Error(`fetch timeout after ${timeoutMs}ms`);
              throw new Error(msg);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        });
        return Array.isArray(frames) && frames[0] ? frames[0].result : null;
      });
      if (result) return result;
      lastErr = new Error(`pageFetchJson returned empty result; Request Method: ${reqMethod}; url=${url}; attempt=${attemptNo}/${maxAttempts}`);
    } catch (e) {
      const rawMsg = String((e && e.message) || e || "unknown error");
      lastErr = new Error(`pageFetchJson failed; Request Method: ${reqMethod}; url=${url}; attempt=${attemptNo}/${maxAttempts}; error=${rawMsg}`);
      try { lastErr.cause = e; } catch (_) {}
    }
    if (attempt + 1 < maxAttempts) {
      const extra = isTransientPageFetchError(lastErr) ? 500 : 0;
      await sleep(extra + 250 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`pageFetchJson returned empty result; Request Method: ${reqMethod}; url=${url}; attempt=${lastAttempt || 0}/${maxAttempts}`);
}

async function getAccessTokenFromPage(tabId) {
  const result = await withVeoTabOpLock(tabId, "get_access_token", async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const tries = [
          "/api/auth/session",
          "/fx/api/auth/session"
        ];
        for (const u of tries) {
          try {
            const r = await fetch(u, { credentials: "include" });
            if (!r.ok) continue;
            const j = await r.json();
            const tok = j && (j.accessToken || j.access_token || j.token);
            if (tok) return { access_token: tok, expires: j.expires || null, email: (j.user && j.user.email) || null };
          } catch (_) {}
        }
        return {};
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : null;
  });
  if (!result || !result.access_token) throw new Error(`VEO access token not found: ${JSON.stringify(result || {})}`);
  return result;
}

function cookieExpiresToIso(cookie) {
  const exp = Number(cookie && cookie.expirationDate);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  try {
    return new Date(exp * 1000).toISOString();
  } catch (_) {
    return null;
  }
}

function veoCookieUrl(targetUrl) {
  try {
    const u = new URL(targetUrl || "https://labs.google");
    if (!/(\.|^)labs\.google$/i.test(u.hostname)) return "https://labs.google";
    return `${u.origin}`;
  } catch (_) {
    return "https://labs.google";
  }
}

async function getLongAccessTokenFromCookies(targetUrl) {
  const url = veoCookieUrl(targetUrl);
  const baseName = "__Secure-next-auth.session-token";
  let exact = null;
  try {
    exact = await chrome.cookies.get({ url, name: baseName });
  } catch (_) {
    exact = null;
  }
  if (exact && exact.value) {
    return {
      access_token: exact.value,
      session_token: exact.value,
      expires: cookieExpiresToIso(exact),
      cookie_name: exact.name
    };
  }

  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch (_) {
    cookies = [];
  }
  const parts = cookies
    .filter(c => c && typeof c.name === "string" && (c.name === baseName || c.name.startsWith(`${baseName}.`)) && c.value)
    .sort((a, b) => {
      const ai = a.name === baseName ? -1 : Number.parseInt(a.name.slice(baseName.length + 1), 10);
      const bi = b.name === baseName ? -1 : Number.parseInt(b.name.slice(baseName.length + 1), 10);
      return (Number.isFinite(ai) ? ai : 9999) - (Number.isFinite(bi) ? bi : 9999);
    });
  if (!parts.length) {
    throw new Error("未找到 __Secure-next-auth.session-token cookie（请确认窗口已登录 Google/VEO）");
  }
  const token = parts.map(c => String(c.value || "")).join("");
  if (!token) throw new Error("VEO long session-token cookie 为空");
  const expCookie = parts.find(c => Number(c.expirationDate) > 0) || parts[0];
  return {
    access_token: token,
    session_token: token,
    expires: cookieExpiresToIso(expCookie),
    cookie_name: parts.length === 1 ? parts[0].name : `${baseName}.*`,
    cookie_parts: parts.length
  };
}

async function fetchShortAccessTokenByExtensionFetch(targetUrl) {
  const cookieUrl = veoCookieUrl(targetUrl);
  const origin = new URL(cookieUrl).origin;
  const tries = [
    `${origin}/fx/api/auth/session`,
    `${origin}/api/auth/session`
  ];
  let last = "";
  for (const u of tries) {
    try {
      const r = await fetch(u, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const text = await r.text();
      if (!r.ok) {
        last = `HTTP ${r.status} ${text.slice(0, 200)}`;
        continue;
      }
      const j = text ? JSON.parse(text) : {};
      const tok = j && (j.accessToken || j.access_token || j.token);
      if (tok) {
        return {
          access_token: tok,
          expires: j.expires || null,
          email: (j.user && j.user.email) || null
        };
      }
      last = `auth/session missing token: ${JSON.stringify(j).slice(0, 200)}`;
    } catch (e) {
      last = String((e && e.message) || e || "");
    }
  }
  throw new Error(last || "auth/session 未返回 access_token");
}

function cleanTokenValue(v) {
  return String(v || "").trim();
}

async function fetchVeoLongAccessTokenTask(msg, runtime) {
  const p = msg.payload || {};
  const targetUrl = p.target_url || p.project_page || "https://labs.google/fx";
  await runtime.progress(5, { stage: "long_access_token" });
  const longInfo = await getLongAccessTokenFromCookies(targetUrl);
  await runtime.progress(100, { stage: "done", token_kind: "long" });
  return {
    type: "veo_long_access_token",
    ...longInfo,
    source: "extension.cookies"
  };
}

async function fetchVeoShortAccessTokenTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || p.target_url || "https://labs.google/fx";
  await runtime.progress(5, { stage: "short_access_token" });
  let shortInfo = null;
  try {
    shortInfo = await fetchShortAccessTokenByExtensionFetch(projectPage);
  } catch (_) {
    const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
    shortInfo = await getAccessTokenFromPage(tabId);
  }
  await runtime.progress(100, { stage: "done", token_kind: "short" });
  return {
    type: "veo_short_access_token",
    access_token: shortInfo.access_token,
    expires: shortInfo.expires || null,
    email: shortInfo.email || null,
    source: "extension.auth_session"
  };
}

async function fetchVeoAccessTokensTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || p.target_url || "https://labs.google/fx";
  const existingTabId = Number(p.tab_id || p.labs_tab_id || 0) || null;
  const extSessionToken = cleanTokenValue(p.ext_session_token || p.expected_session_token || p.current_session_token);
  const extShortAccessToken = cleanTokenValue(p.ext_short_access_token || p.short_access_token);
  const extShortExpires = cleanTokenValue(p.ext_short_expires || p.short_expires) || null;
  await runtime.progress(3, { stage: "long_access_token" });
  const longInfo = await getLongAccessTokenFromCookies(projectPage);
  const longSessionToken = cleanTokenValue(longInfo && longInfo.session_token);
  if (!longSessionToken) throw new Error("VEO long session_token not found");

  await runtime.progress(15, {
    stage: "short_access_token",
    session_token_matches_ext: !!(extSessionToken && longSessionToken === extSessionToken)
  });
  let shortInfo = null;
  let shortSource = "extension.fetch";

  try {
    shortInfo = await fetchShortAccessTokenByExtensionFetch(projectPage);
  } catch (e) {
    shortSource = "page.auth_session";
    await runtime.progress(20, { stage: "short_access_token_page_fallback", error: String((e && e.message) || e || "").slice(0, 200) });
    const tabId = existingTabId || await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
    shortInfo = await getAccessTokenFromPage(tabId);
  }
  if (!shortInfo || !shortInfo.access_token) throw new Error("VEO short access_token not found");
  await runtime.progress(100, { stage: "done", token_kind: "long_short" });

  return {
    type: "veo_access_tokens",
    access_token: shortInfo && shortInfo.access_token ? shortInfo.access_token : null,
    session_token: shortInfo && shortInfo.access_token ? shortInfo.access_token : null,
    expires: shortInfo && shortInfo.expires ? shortInfo.expires : null,
    cookie_name: longInfo.cookie_name || null,
    cookie_parts: longInfo.cookie_parts || 1,
    short_access_token: shortInfo && shortInfo.access_token ? shortInfo.access_token : null,
    short_expires: shortInfo && shortInfo.expires ? shortInfo.expires : null,
    email: shortInfo && shortInfo.email ? shortInfo.email : null,
    source: "extension",
    short_source: shortSource,
    ext_session_token_matched: !!(extSessionToken && longSessionToken === extSessionToken),
    ext_session_token_changed: !!(extSessionToken && longSessionToken !== extSessionToken)
  };
}

function veoTrpcCreateProjectUrl(targetUrl) {
  try {
    const u = new URL(String(targetUrl || "https://labs.google/fx"));
    return `${u.origin}/fx/api/trpc/project.createProject`;
  } catch (_) {
    return "https://labs.google/fx/api/trpc/project.createProject";
  }
}

function veoTrpcDeleteProjectUrl() {
  return "https://labs.google/fx/api/trpc/project.deleteProject";
}

function parseVeoCreateProjectResponse(obj) {
  if (obj == null) return "";
  let cur = obj;
  if (Array.isArray(cur) && cur.length) cur = cur[0];
  if (!cur || typeof cur !== "object") return "";
  const dig = (d, keys) => {
    let x = d;
    for (const k of keys) {
      if (!x || typeof x !== "object") return null;
      x = x[k];
    }
    return x;
  };
  for (const candidate of [
    dig(cur, ["result", "data", "json", "result"]),
    dig(cur, ["result", "data", "json"]),
    cur
  ]) {
    if (candidate && typeof candidate === "object") {
      const pid = candidate.projectId || candidate.project_id;
      if (pid) return String(pid).trim();
    }
  }
  const seen = new Set();
  const walk = (x, depth = 0) => {
    if (!x || typeof x !== "object" || depth > 8 || seen.has(x)) return "";
    seen.add(x);
    const pid = x.projectId || x.project_id;
    if (pid) return String(pid).trim();
    for (const v of Object.values(x)) {
      const got = walk(v, depth + 1);
      if (got) return got;
    }
    return "";
  };
  const nested = walk(cur);
  if (nested) return nested;
  return "";
}

async function createVeoFlowProjectTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || p.target_url || "https://labs.google/fx";
  const title = String(p.title || p.project_title || p.projectTitle || "").trim();
  const toolName = String(p.tool_name || p.toolName || "PINHOLE").trim() || "PINHOLE";
  if (!title) throw new Error("项目标题不能为空");

  await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
  const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
  await runtime.progress(10, { stage: "create_flow_project", title, tool_name: toolName });
  const tx = await pageFetchJson(tabId, veoTrpcCreateProjectUrl(projectPage), {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: { json: { projectTitle: title, toolName } },
    attempts: 3
  });
  if (tx.status >= 400) throw new Error(`createProject 失败：HTTP ${tx.status} ${String(tx.text || "").slice(0, 500)}`);
  const projectId = parseVeoCreateProjectResponse(tx.json);
  if (!projectId) throw new Error(`createProject 响应无效：${String(tx.text || JSON.stringify(tx.json || null)).slice(0, 400)}`);
  const projectUrl = `https://labs.google/fx/tools/flow/project/${encodeURIComponent(projectId)}`;
  let navigated = false;
  try {
    await chrome.tabs.update(tabId, { url: projectUrl, active: true });
    await waitTabComplete(tabId, 60000);
    await sleep(1200);
    navigated = true;
  } catch (_) {}
  await runtime.progress(100, { stage: "done", project_id: projectId, project_url: projectUrl, navigated });
  return {
    type: "veo_flow_project_create",
    success: true,
    project_id: projectId,
    project_name: title,
    project_url: projectUrl,
    navigated,
    status: tx.status,
    response: tx.json || null
  };
}

async function deleteVeoFlowProjectTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || p.target_url || "https://labs.google/fx";
  const projectId = String(p.project_id || p.projectId || p.flow_project_id || "").trim();
  if (!projectId) throw new Error("project_id 不能为空");

  await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
  const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
  await runtime.progress(10, { stage: "delete_flow_project", project_id: projectId });
  const tx = await pageFetchJson(tabId, veoTrpcDeleteProjectUrl(), {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: { json: { projectToDeleteId: projectId } },
    attempts: 3
  });
  if (tx.status >= 400) throw new Error(`deleteProject 失败：HTTP ${tx.status} ${String(tx.text || "").slice(0, 500)}`);
  await runtime.progress(100, { stage: "done", project_id: projectId });
  return {
    type: "veo_flow_project_delete",
    success: true,
    project_id: projectId,
    status: tx.status,
    response: tx.json || null
  };
}

function normalizeCreditsPayload(data) {
  const credits = Number.parseInt(data && data.credits != null ? data.credits : 0, 10) || 0;
  const tier = data && (data.userPaygateTier || data.user_paygate_tier) || null;
  return { credits, user_paygate_tier: tier ? String(tier) : null, raw: data || null };
}

function localNext0105() {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 5, 0, 0);
  if (now.getTime() > dt.getTime()) dt.setDate(dt.getDate() + 1);
  return dt;
}

function fmtLocal(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function parseNextUpdateText(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (/Next\s+update\s*:\s*tomorrow\b/i.test(s)) return fmtLocal(localNext0105());
  const m = s.match(/Next\s+update\s*:\s*([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*,\s*(\d{4}))?/i);
  if (!m) return null;
  const monMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = monMap[String(m[1] || "").slice(0, 3).toLowerCase()];
  const day = Number.parseInt(m[2], 10);
  if (mon == null || !day || day < 1 || day > 31) return null;
  const now = new Date();
  let year = m[3] ? Number.parseInt(m[3], 10) : now.getFullYear();
  let dt = new Date(year, mon, day, 13, 5, 0, 0);
  if (!m[3] && dt.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) dt = new Date(year + 1, mon, day, 13, 5, 0, 0);
  if (dt.toDateString() === now.toDateString()) dt = localNext0105();
  return fmtLocal(dt);
}

async function fetchNextUpdateCooldown() {
  try {
    const tabId = await ensureGenericTab("https://one.google.com/ai/activity", "https://one.google.com/ai/activity?g1_landing_page=0", { active: false });
    await sleep(4000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => document.body ? document.body.innerText || "" : ""
    });
    return parseNextUpdateText(result || "");
  } catch (_) {
    return null;
  }
}

export async function refreshVeoBalanceTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = p.project_page || "https://labs.google/fx";
  const otherActiveTasks = countOtherActiveVeoTaskRuns(runtime);
  const avoidPageMutation = otherActiveTasks > 0;
  await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
  const tabId = await ensureVeoProjectTab(projectPage, {
    navigate: !avoidPageMutation,
    active: !avoidPageMutation,
    create: !avoidPageMutation
  });
  if (avoidPageMutation) {
    try {
      await runtime.progress(3, {
        stage: "balance_refresh_non_intrusive",
        reason: "other_tasks_running",
        active_veo_tasks: activeVeoTaskRuns.size,
        other_active_veo_tasks: otherActiveTasks,
        tab_found: !!tabId
      });
    } catch (_) {}
  }
  const tokenInfo = p.access_token ? { access_token: p.access_token, expires: p.access_expires } : (tabId ? await getAccessTokenFromPage(tabId) : {});
  const at = tokenInfo.access_token;
  if (!at) throw new Error("缺少 access_token，无法读取 VEO 余额");
  await runtime.progress(20, { stage: "credits" });
  // 余额接口只依赖 Bearer access_token；优先用扩展自身 fetch，避免在页面 MAIN world
  // executeScript 偶发返回空 result 导致余额刷新失败。仍属于浏览器插件侧读取，不走 CDP。
  let tx = await fetchJson(URLS.credits, { method: "GET", headers: authHeaders(at) });
  if ((!tx || !tx.status) && tabId) {
    tx = await pageFetchJson(tabId, URLS.credits, { method: "GET", headers: authHeaders(at) });
  }
  if (!tx || !tx.status) throw new Error("VEO credits fetch returned empty result");
  if (tx.status >= 400) throw new Error(`查询 credits 失败: ${compactErrorResponse(tx)}`);
  const info = normalizeCreditsPayload(tx.json);
  if (p.fetch_cooldown) {
    await runtime.progress(60, { stage: "next_update" });
    const cu = await fetchNextUpdateCooldown();
    if (cu) info.cooldown_until = cu;
    try {
      if (avoidPageMutation) {
        await runtime.progress(80, {
          stage: "restore_project_page_skipped",
          reason: "other_tasks_running",
          active_veo_tasks: activeVeoTaskRuns.size,
          other_active_veo_tasks: otherActiveTasks
        });
      } else {
        await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
      }
    } catch (_) {}
  }
  await runtime.progress(100, { stage: "done", credits: info.credits, cooldown_until: info.cooldown_until || null });
  return { type: "veo_balance", ...info };
}

export async function getRecaptchaToken(tabId, action) {
  const result = await withVeoTabOpLock(tabId, "get_recaptcha_token", async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [action],
      func: async (act) => {
        const siteKey = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
        try {
          if (!window.grecaptcha || !window.grecaptcha.enterprise) return "";
          await new Promise(resolve => window.grecaptcha.enterprise.ready(resolve));
          return await window.grecaptcha.enterprise.execute(siteKey, { action: act || "VIDEO_GENERATION" });
        } catch (e) {
          return "";
        }
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : "";
  });
  return String(result || "");
}

async function downloadImageAsBase64(url) {
  const reqMethod = "GET";
  let resp;
  try {
    resp = await fetch(url, { method: reqMethod, credentials: "omit" });
  } catch (e) {
    const rawMsg = String((e && e.message) || e || "unknown error");
    throw new Error(`download image failed; Request Method: ${reqMethod}; url=${url}; error=${rawMsg}`);
  }
  if (!resp.ok) throw new Error(`download image failed; Request Method: ${reqMethod}; url=${url}; Status Code: ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`);
  const blob = await resp.blob();
  const mime = blob.type || "image/jpeg";
  const buf = await blob.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { base64: btoa(bin), mime };
}

async function uploadImage(tabId, url, at, projectId, runtime, index, total) {
  await runtime.progress(7 + index, { stage: "upload_image", index: index + 1, total, url });
  const img = await downloadImageAsBase64(url);
  const ext = img.mime.includes("png") ? "png" : "jpg";
  const tx = await pageFetchJson(tabId, URLS.uploadImage, {
    method: "POST",
    headers: authHeaders(at),
    body: {
      clientContext: { tool: "PINHOLE", projectId: String(projectId) },
      fileName: `fpbrowser2api_veo_ext_${Date.now()}_${index}.${ext}`,
      imageBytes: img.base64,
      isHidden: false,
      isUserUploaded: true,
      mimeType: img.mime
    }
  });
  if (tx.status >= 400) throw new Error(`VEO upload image failed: ${compactErrorResponse(tx)}`);
  const media = tx.json?.media || {};
  const mediaId = media.name || tx.json?.mediaGenerationId?.mediaGenerationId || tx.json?.mediaGenerationId;
  if (!mediaId) throw new Error(`VEO upload missing mediaId: ${JSON.stringify(tx.json).slice(0, 500)}`);
  return {
    mediaId,
    workflowId: media.workflowId || tx.json?.workflow?.name || "",
    projectId: media.projectId || tx.json?.workflow?.projectId || projectId
  };
}

function guessVideoMimeFromUrl(url) {
  const s = String(url || "").split("?", 1)[0].toLowerCase();
  if (s.endsWith(".webm")) return "video/webm";
  if (s.endsWith(".mov")) return "video/quicktime";
  if (s.endsWith(".mkv")) return "video/x-matroska";
  if (s.endsWith(".avi")) return "video/x-msvideo";
  if (s.endsWith(".ogv") || s.endsWith(".ogg")) return "video/ogg";
  return "video/mp4";
}

function guessVideoExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime") || m.includes("mov")) return "mov";
  if (m.includes("matroska")) return "mkv";
  if (m.includes("avi")) return "avi";
  if (m.includes("ogg")) return "ogv";
  return "mp4";
}

function extractProjectIdFromUploadSessionUrl(sessionUrl) {
  try {
    const u = new URL(String(sessionUrl || ""));
    const m = u.pathname.match(/\/upload\/video\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  } catch (_) {
    return "";
  }
}

const VEO_REFERENCE_VIDEO_MAX_SECONDS = 30;

function finitePositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function computeVideoEndFrameIndex(p, meta, durationSeconds) {
  const explicit = Number.parseInt(p.ingredients_video_end_frame_index || p.video_reference_end_frame_index || "", 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const frameCount = Number.parseInt(
    p.ingredients_video_frame_count || p.video_reference_frame_count || meta.frameCount || meta.frame_count || "",
    10
  );
  if (Number.isFinite(frameCount) && frameCount > 0) {
    // videoInput frame index 从 0 开始，结束帧应为最后一帧下标。
    return Math.max(0, frameCount - 1);
  }

  const fps = finitePositiveNumber(p.ingredients_video_fps || p.video_reference_fps || meta.fps || meta.frameRate || meta.frame_rate);
  if (fps && durationSeconds > 0) return Math.max(0, Math.round(durationSeconds * fps) - 1);

  // abra_edit 返回 24fps 视频；没有 Python/显式帧数据时按输出 fps 估算。
  return Math.max(1, Math.round((durationSeconds || 30) * VEO_EDIT_OUTPUT_FPS));
}

function assertReferenceVideoDuration(durationSeconds, url) {
  if (Number.isFinite(durationSeconds) && durationSeconds > VEO_REFERENCE_VIDEO_MAX_SECONDS + 0.001) {
    throw new Error(`VEO_REFERENCE_VIDEO_DURATION_VIOLATION: 参考视频时长不能超过30秒，当前约 ${durationSeconds.toFixed(3)} 秒，违规：${String(url || "").slice(0, 300)}`);
  }
}

async function getLocalVideoMetadata(tabId, url, runtime) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url],
      func: async (u) => {
        return await new Promise((resolve) => {
          const v = document.createElement("video");
          let done = false;
          const finish = (result) => {
            if (done) return;
            done = true;
            try { v.removeAttribute("src"); v.load(); } catch (_) {}
            resolve(result || {});
          };
          v.preload = "metadata";
          v.muted = true;
          v.onloadedmetadata = () => finish({
            duration: Number.isFinite(v.duration) ? v.duration : 0,
            width: v.videoWidth || 0,
            height: v.videoHeight || 0
          });
          v.onerror = () => finish({ duration: 0, width: 0, height: 0, error: "loadedmetadata_failed" });
          setTimeout(() => finish({ duration: 0, width: 0, height: 0, error: "metadata_timeout" }), 15000);
          v.src = u;
        });
      }
    });
    const meta = Array.isArray(frames) && frames[0] ? (frames[0].result || {}) : {};
    if (meta && meta.error) {
      try { await runtime.progress(8, { stage: "video_metadata_warning", url, error: meta.error }); } catch (_) {}
    }
    return meta;
  } catch (e) {
    try { await runtime.progress(8, { stage: "video_metadata_warning", url, error: String((e && e.message) || e || "").slice(0, 200) }); } catch (_) {}
    return {};
  }
}

async function uploadVideoInChunks(tabId, url, at, projectId, runtime) {
  const chunkSize = 2 * 1024 * 1024; // labs.google upload-video 单片 Content-Length 最大 2097152
  const mimeFallback = guessVideoMimeFromUrl(url);
  await runtime.progress(8, { stage: "upload_video_start", url, chunk_size: chunkSize });
  const result = await withVeoTabOpLock(tabId, "upload_video_chunks", async () => {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url, at, String(projectId || ""), chunkSize, URLS.uploadVideoStart, URLS.uploadVideoChunk, mimeFallback],
      func: async (videoUrl, accessToken, pid, maxChunkSize, startUrl, uploadUrl, defaultMime) => {
        const auth = accessToken ? { "Authorization": `Bearer ${accessToken}` } : {};
        const sourceResp = await fetch(videoUrl, { method: "GET", credentials: "omit", cache: "no-store" });
        if (!sourceResp.ok) {
          throw new Error(`download video failed; Request Method: GET; url=${videoUrl}; Status Code: ${sourceResp.status}${sourceResp.statusText ? ` ${sourceResp.statusText}` : ""}`);
        }
        const blob = await sourceResp.blob();
        const size = blob.size || 0;
        if (!size) throw new Error(`download video failed: empty blob; url=${videoUrl}`);
        const mime = blob.type || defaultMime || "video/mp4";
        const ext = mime.includes("webm") ? "webm" : (mime.includes("quicktime") ? "mov" : "mp4");
        const fileName = `fpbrowser2api_veo_ext_${Date.now()}.${ext}`;

        const startBody = { projectId: pid, fileName, mimeType: mime, sizeBytes: String(size) };
        const startHeaders = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "x-upload-content-length": String(size),
          "x-upload-content-type": mime,
          "x-upload-file-name": fileName,
          "x-upload-project-id": pid,
          ...auth
        };
        let startResp = await fetch(startUrl, {
          method: "POST",
          credentials: "include",
          headers: startHeaders,
          body: JSON.stringify(startBody)
        });
        let startText = await startResp.text();
        let startJson = null;
        try { startJson = startText ? JSON.parse(startText) : null; } catch (_) {}
        // 兼容服务端只接受空 POST 的实现。
        if (startResp.status >= 400) {
          startResp = await fetch(startUrl, {
            method: "POST",
            credentials: "include",
            headers: startHeaders
          });
          startText = await startResp.text();
          try { startJson = startText ? JSON.parse(startText) : null; } catch (_) { startJson = null; }
        }
        if (startResp.status >= 400) {
          throw new Error(`VEO upload video start failed: status=${startResp.status}; response=${String(startText || "").slice(0, 500)}`);
        }
        const sessionUrl = String((startJson && (startJson.sessionUrl || startJson.session_url)) || "");
        if (!sessionUrl || !/active/i.test(String((startJson && startJson.status) || ""))) {
          throw new Error(`VEO upload video start invalid response: ${JSON.stringify(startJson).slice(0, 500)}`);
        }

        let finalJson = null;
        let uploadedBytes = 0;
        let chunkCount = 0;
        for (let offset = 0; offset < size; offset += maxChunkSize) {
          const endExclusive = Math.min(size, offset + maxChunkSize);
          const chunk = blob.slice(offset, endExclusive, mime);
          const isLast = endExclusive >= size;
          const headers = {
            "Accept": "application/json",
            "Content-Type": mime,
            "Content-Range": `bytes ${offset}-${endExclusive - 1}/${size}`,
            "X-Goog-Upload-URL": sessionUrl,
            "X-Upload-Session-Url": sessionUrl,
            "x-upload-file-name": fileName,
            "x-upload-offset": String(offset),
            "x-upload-project-id": pid,
            "x-upload-command": isLast ? "upload, finalize" : "upload",
            ...auth
          };
          const resp = await fetch(uploadUrl, {
            method: "PUT",
            credentials: "include",
            headers,
            body: chunk
          });
          const text = await resp.text();
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) {}
          if (resp.status >= 400) {
            throw new Error(`VEO upload video chunk failed: status=${resp.status}; range=${headers["Content-Range"]}; response=${String(text || "").slice(0, 500)}`);
          }
          if (!json || !/^(active|final)$/i.test(String(json.status || ""))) {
            throw new Error(`VEO upload video chunk invalid response: range=${headers["Content-Range"]}; response=${JSON.stringify(json).slice(0, 500)}`);
          }
          uploadedBytes = endExclusive;
          chunkCount++;
          if (isLast) finalJson = json;
        }
        if (!finalJson || !/final/i.test(String(finalJson.status || "")) || !finalJson.mediaServerId) {
          throw new Error(`VEO upload video missing final mediaServerId: ${JSON.stringify(finalJson).slice(0, 500)}`);
        }
        return { ...finalJson, sessionUrl, uploadProjectId: "", size, mime, fileName, uploadedBytes, chunkCount };
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : null;
  });
  if (!result || !result.mediaServerId) throw new Error(`VEO upload video returned empty result: ${JSON.stringify(result || {}).slice(0, 500)}`);
  result.uploadProjectId = result.uploadProjectId || extractProjectIdFromUploadSessionUrl(result.sessionUrl) || projectId;
  await runtime.progress(12, {
    stage: "upload_video_done",
    media_id: result.mediaServerId,
    project_id: result.uploadProjectId,
    size: result.size,
    chunks: result.chunkCount
  });
  return result;
}

async function confirmUploadedVideoOffset(tabId, at, uploadInfo, durationSeconds, runtime) {
  const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0 ? Number(durationSeconds) : 30;
  const endOffset = `${duration.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}s`;
  const body = {
    json: {
      mediaId: uploadInfo.mediaServerId,
      startOffset: "0s",
      endOffset
    }
  };
  await runtime.progress(13, { stage: "update_video_offset", media_id: uploadInfo.mediaServerId, end_offset: endOffset });
  const tx = await pageFetchJson(tabId, URLS.updateVideoOffset, { method: "POST", headers: authHeaders(at), body });
  if (tx.status >= 400) throw new Error(`VEO update video offset failed: ${compactErrorResponse(tx)}`);
  const status = firstStringByKey(tx.json, "mediaGenerationStatus");
  if (!/MEDIA_GENERATION_STATUS_PENDING/i.test(status)) {
    throw new Error(`VEO update video offset unexpected status=${status || "unknown"}; response=${JSON.stringify(tx.json).slice(0, 500)}`);
  }
  return { status, endOffset };
}

async function pollUploadedVideoProcessing(tabId, at, uploadInfo, runtime, p) {
  const maxWait = Math.max(60, Number(p.video_upload_max_wait_seconds || p.max_wait_seconds || p.timeout_seconds || 600));
  const interval = Math.max(0.5, Number(p.video_upload_poll_interval_seconds || p.poll_interval_seconds || 5));
  const deadline = Date.now() + maxWait * 1000;
  const pollMedia = [{ name: uploadInfo.mediaServerId, projectId: uploadInfo.uploadProjectId || uploadInfo.projectId || p.project_id }];
  let last = {};
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    attempt++;
    const tx = await pageFetchJson(tabId, URLS.videoPoll, { method: "POST", headers: authHeaders(at), body: { media: pollMedia } });
    if (tx.status >= 400) throw new Error(`VEO uploaded video poll failed: ${compactErrorResponse(tx)}`);
    last = parseVideoPoll(tx.json);
    const pct = 14 + Math.min(10, Math.floor((Date.now() - (deadline - maxWait * 1000)) / (maxWait * 1000) * 10));
    await runtime.progress(pct, {
      stage: last.failed ? "uploaded_video_failed" : "uploaded_video_processing",
      attempt,
      status: last.status,
      media_id: uploadInfo.mediaServerId,
      error: last.failed ? formatVideoPollFailure(last.failure) : undefined
    });
    if (last.failed) throw new Error(`VEO uploaded video processing failed: ${formatVideoPollFailure(last.failure)}`);
    if (/MEDIA_GENERATION_STATUS_SUCCESSFUL/i.test(String(last.status || ""))) return { ...last, pollMedia };
  }
  throw new Error(`VEO uploaded video processing timeout; last=${JSON.stringify(last).slice(0, 300)}`);
}

function firstStringByKey(obj, key) {
  if (!obj || typeof obj !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === "string" && obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const got = firstStringByKey(v, key);
      if (got) return got;
    }
  }
  return "";
}

function parseImageResult(resp) {
  const mediaList = Array.isArray(resp?.media) ? resp.media : (Array.isArray(resp?.responses?.[0]?.media) ? resp.responses[0].media : []);
  const m0 = mediaList.find(x => x && typeof x === "object");
  if (!m0) throw new Error(`VEO image result empty: ${JSON.stringify(resp).slice(0, 500)}`);
  const fifeUrl = m0.image?.generatedImage?.fifeUrl || firstStringByKey(m0, "fifeUrl");
  if (!fifeUrl) throw new Error(`VEO image missing fifeUrl: ${JSON.stringify(resp).slice(0, 500)}`);
  return {
    fifeUrl,
    mediaName: m0.name || "",
    workflowId: m0.workflowId || m0.image?.generatedImage?.workflowId || "",
    projectId: m0.projectId || ""
  };
}

function parseVideoPoll(resp) {
  let workflowId = "", projectId = "", status = "", videoUrl = "", mediaName = "";
  let failure = null;

  const normalizeFailureReasons = (value) => {
    if (Array.isArray(value)) {
      return value
        .map(x => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object") return x.reason || x.message || x.name || JSON.stringify(x);
          return String(x || "");
        })
        .map(x => String(x || "").trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };

  const pickFailureReasons = (source) => {
    const candidates = [
      source?.mediaMetadata?.mediaStatus?.failureReasons,
      source?.mediaStatus?.failureReasons,
      source?.failureReasons,
      source?.operation?.failureReasons,
      source?.operation?.metadata?.failureReasons
    ];
    for (const candidate of candidates) {
      const reasons = normalizeFailureReasons(candidate);
      if (reasons.length) return reasons;
    }
    return [];
  };

  const rememberFailure = (source, itemStatus, err, failureReasons) => {
    if (failure) return;
    if (itemStatus) status = itemStatus;
    const op = source?.operation || {};
    const e = err || op.error || source?.error || null;
    const reasons = normalizeFailureReasons(failureReasons);
    failure = {
      status: itemStatus || status || source?.status || "",
      code: e && (e.code ?? e.status ?? ""),
      message: e && (e.message || e.statusMessage || e.reason || ""),
      operation: op.name || source?.operationName || "",
      sceneId: source?.sceneId || "",
      mediaGenerationId: source?.mediaGenerationId || source?.name || "",
      failureReasons: reasons.length ? reasons : pickFailureReasons(source)
    };
  };

  const isFailedStatus = (s) => /(^|_)FAILED($|_)/i.test(String(s || ""));
  const media = Array.isArray(resp?.media) ? resp.media : [];
  for (const item of media) {
    mediaName ||= item.name || "";
    workflowId ||= item.workflowId || "";
    projectId ||= item.projectId || "";
    const mediaStatus = item.mediaMetadata?.mediaStatus || {};
    const itemStatus = mediaStatus.mediaGenerationStatus || item.status || "";
    status ||= itemStatus;
    videoUrl ||= item.mediaMetadata?.video?.fifeUrl || firstStringByKey(item, "fifeUrl");
    const err = item.operation?.error || item.error || mediaStatus.error || null;
    const failureReasons = mediaStatus.failureReasons || item.failureReasons || null;
    if (err || isFailedStatus(itemStatus) || normalizeFailureReasons(failureReasons).length) {
      rememberFailure(item, itemStatus, err, failureReasons);
    }
  }
  const operations = Array.isArray(resp?.operations) ? resp.operations : [];
  for (const item of operations) {
    mediaName ||= item.mediaGenerationId || item.operation?.name || "";
    const itemStatus = item.status || item.mediaGenerationStatus || item.operation?.status || "";
    status ||= itemStatus;
    const err = item.operation?.error || item.error || null;
    const failureReasons = item.failureReasons || item.operation?.failureReasons || item.operation?.metadata?.failureReasons || null;
    if (err || isFailedStatus(itemStatus) || normalizeFailureReasons(failureReasons).length) {
      rememberFailure(item, itemStatus, err, failureReasons);
    }
  }
  videoUrl ||= firstStringByKey(resp, "fifeUrl");
  return { workflowId, projectId, status: (failure && failure.status) || status, videoUrl, mediaName, failed: !!failure, failure };
}

function formatVideoPollFailure(failure) {
  const f = failure || {};
  const parts = [];
  if (f.status) parts.push(`status=${f.status}`);
  if (f.code !== undefined && f.code !== null && f.code !== "") parts.push(`code=${f.code}`);
  if (f.message) parts.push(`message=${f.message}`);
  if (Array.isArray(f.failureReasons) && f.failureReasons.length) parts.push(`failureReasons=${f.failureReasons.join(",")}`);
  if (f.operation) parts.push(`operation=${f.operation}`);
  if (f.mediaGenerationId) parts.push(`mediaGenerationId=${String(f.mediaGenerationId).slice(0, 120)}`);
  if (f.sceneId) parts.push(`sceneId=${f.sceneId}`);
  return parts.join("; ") || "unknown failure";
}

function parseVideoSubmitWorkflow(resp) {
  const workflows = Array.isArray(resp?.workflows) ? resp.workflows : [];
  const media = Array.isArray(resp?.media) ? resp.media : [];
  const workflow = workflows.find(x => x && typeof x === "object" && (x.name || x.workflowId || x.id)) || null;
  const videoMedia = media.find(x => x && typeof x === "object" && (x.mediaMetadata?.video || x.workflowId || x.name)) || null;
  const workflowId = (videoMedia && (videoMedia.workflowId || videoMedia.mediaMetadata?.video?.workflowId))
    || (workflow && (workflow.name || workflow.workflowId || workflow.id))
    || firstStringByKey(resp, "workflowId")
    || "";
  const projectId = (videoMedia && videoMedia.projectId)
    || (workflow && (workflow.projectId || workflow.metadata?.projectId))
    || firstStringByKey(resp, "projectId")
    || "";
  const mediaName = (videoMedia && videoMedia.name)
    || (workflow && workflow.metadata?.primaryMediaId)
    || "";
  return { workflowId, projectId, mediaName };
}

function normalizeVideoPollMedia(mediaList, fallbackProjectId = "") {
  const out = [];
  for (const item of Array.isArray(mediaList) ? mediaList : []) {
    if (!item || typeof item !== "object") continue;
    // batchCheckAsyncVideoGenerationStatus 当前需要 media[]:
    // { media: [{ name, projectId }] }，而不是旧的
    // { operations: [{ operation: { name } }] }。必须保留 projectId，否则
    // 服务端可能只返回 operation 级别状态，缺少 mediaStatus.failureReasons。
    const name = String(item.operation?.name || item.operation || item.name || item.mediaGenerationId || "").trim();
    const projectId = String(item.projectId || item.mediaMetadata?.projectId || fallbackProjectId || "").trim();
    if (name) out.push(projectId ? { name, projectId } : { name });
  }
  return out;
}

function normalizeVideoPollOperations(mediaList) {
  const out = [];
  for (const item of Array.isArray(mediaList) ? mediaList : []) {
    if (!item || typeof item !== "object") continue;
    if (item.operation && typeof item.operation === "object") {
      out.push({ operation: item.operation });
      continue;
    }
    if (typeof item.operation === "string" && item.operation) {
      out.push({ operation: { name: item.operation } });
      continue;
    }
    if (typeof item.name === "string" && item.name) {
      out.push({ operation: { name: item.name } });
    }
  }
  return out;
}

async function archiveWorkflow(tabId, at, workflowId, projectId) {
  if (!workflowId) return false;
  try {
    const url = `${URLS.workflows}/${encodeURIComponent(workflowId)}`;
    const tx = await pageFetchJson(tabId, url, {
      method: "PATCH",
      headers: authHeaders(at),
      body: {
        workflow: {
          name: workflowId,
          projectId: String(projectId || ""),
          metadata: { archived: true }
        },
        updateMask: "metadata.archived"
      }
    });
    return tx.status < 400;
  } catch (_) {
    return false;
  }
}

async function archiveUploadedWorkflows(tabId, at, uploaded, runtime, reason = "cleanup_uploaded_workflows") {
  const items = Array.isArray(uploaded) ? uploaded : [];
  let archived = 0;
  let total = 0;
  for (const up of items) {
    if (!up || !up.workflowId) continue;
    total++;
    if (await archiveWorkflow(tabId, at, up.workflowId, up.projectId)) archived++;
  }
  if (total) {
    try {
      await runtime.progress(12, { stage: reason, archived, total });
    } catch (_) {}
  }
  return { archived, total };
}

async function archiveGeneratedWorkflow(tabId, at, workflowId, projectId, runtime, reason = "archive_generated_workflow") {
  const archived = workflowId ? await archiveWorkflow(tabId, at, workflowId, projectId) : false;
  try {
    await runtime.progress(96, {
      stage: reason,
      workflow_id: workflowId || "",
      project_id: projectId || "",
      archived
    });
  } catch (_) {}
  return archived;
}

async function refreshProjectPageAfterArchive(progress, tabId, projectPage, runtime, reason = "refresh_project_page_after_archive") {
  const url = String(projectPage || "").trim();
  if (!url) return false;
  return await withVeoTabOpLock(tabId, reason, async () => {
    if (await shouldSkipProjectPageRefresh(progress, runtime, reason, url)) return false;
    try {
      await runtime.progress(progress, { stage: reason, url });
    } catch (_) {}
    try {
      await chrome.tabs.update(tabId, { url, active: true });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      return true;
    } catch (_) {
      try {
        await chrome.tabs.reload(tabId, { bypassCache: false });
        await waitTabComplete(tabId, 45000);
        await sleep(1200);
        return true;
      } catch (_e) {
        return false;
      }
    }
  });
}

async function fetchWorkflowList(tabId, at, projectId) {
  const urls = [
    `${URLS.workflows}?projectId=${encodeURIComponent(projectId)}`,
    `${URLS.workflows}?project_id=${encodeURIComponent(projectId)}`,
    `${URLS.workflows}?parent=${encodeURIComponent(projectId)}`
  ];
  for (const url of urls) {
    try {
      const tx = await pageFetchJson(tabId, url, { method: "GET", headers: authHeaders(at) });
      if (tx.status < 400 && tx.json) return tx.json;
    } catch (_) {}
  }
  return null;
}

function pickLatestWorkflowFromList(resp) {
  const arr = Array.isArray(resp?.workflows) ? resp.workflows
    : Array.isArray(resp?.workflow) ? resp.workflow
    : Array.isArray(resp?.items) ? resp.items
    : [];
  let best = null;
  let bestTs = 0;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const wid = item.name || item.workflowId || item.id || "";
    if (!wid) continue;
    const ts = Date.parse(item.metadata?.createTime || item.createTime || item.updateTime || 0) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = item;
    }
  }
  if (!best) return null;
  return {
    workflowId: best.name || best.workflowId || best.id || "",
    projectId: best.projectId || best.metadata?.projectId || "",
    archived: !!best.metadata?.archived
  };
}

async function recoverWorkflowAfterEmptySubmit(tabId, at, projectId, runtime, kind) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const resp = await fetchWorkflowList(tabId, at, projectId);
    const picked = pickLatestWorkflowFromList(resp);
    if (picked && picked.workflowId) {
      await runtime.progress(95, { stage: "recovered_workflow", workflow_id: picked.workflowId, workflow_kind: kind });
      return picked;
    }
  }
  return null;
}

async function fetchVeoUserPaygateTier(tabId, at) {
  try {
    const tx = await fetchJson(URLS.credits, { method: "GET", headers: authHeaders(at) });
    if (tx && tx.status < 400) return normalizeCreditsPayload(tx.json).user_paygate_tier || "PAYGATE_TIER_NOT_PAID";
  } catch (_) {}
  return "PAYGATE_TIER_NOT_PAID";
}

function normalizePaygateTier(tier) {
  const s = String(tier || "").trim();
  if (["PAYGATE_TIER_NOT_PAID", "PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"].includes(s)) return s;
  return "PAYGATE_TIER_NOT_PAID";
}

function normalizeImageUpsampleTarget(p) {
  const rawTarget = String(
    p.extension_image_upsample_target_resolution ||
    p.targetResolution ||
    p.target_resolution ||
    ""
  ).trim().toUpperCase();
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_4K") {
    return { label: "4K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_4K" };
  }
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_2K") {
    return { label: "2K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_2K" };
  }

  const label = String(
    p.extension_image_resolution_label ||
    p.resolution ||
    p.image_resolution ||
    p.veo_image_resolution ||
    ""
  ).trim().toLowerCase().replace(/\s+/g, "");
  if (label === "4k" || label === "4096" || label === "3840" || label === "4k_output" || label === "uhd_4k") {
    return { label: "4K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_4K" };
  }
  return { label: "2K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_2K" };
}

async function upsampleImage(tabId, at, p, parsed, runtime) {
  const target = normalizeImageUpsampleTarget(p);
  const maxRetries = 3;
  let lastErr = "";
  for (let i = 0; i < maxRetries; i++) {
    const recaptcha = p.recaptcha_token || p.veo_recaptcha_token || p.recaptchaContextToken || await getRecaptchaToken(tabId, "IMAGE_GENERATION");
    if (!recaptcha) {
      lastErr = "no recaptcha token";
      if (i + 1 < maxRetries) {
        await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr);
      }
      await sleep(1500);
      continue;
    }
    const tier = normalizePaygateTier(p.user_paygate_tier || p.userPaygateTier || await fetchVeoUserPaygateTier(tabId, at));
    const body = {
      mediaId: String(parsed.mediaName || "").trim(),
      targetResolution: target.targetResolution,
      clientContext: {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(p.project_id || parsed.projectId || ""),
        tool: "PINHOLE",
        userPaygateTier: tier
      }
    };
    await runtime.progress(72, { stage: "upsample_image", target_resolution: target.label, target_resolution_key: target.targetResolution, attempt: i + 1, user_paygate_tier: tier });
    let ux = null;
    try {
      // upsample 不创建新工作流，遇到并发刷新导致的 transient 空 result 可以安全重试。
      ux = await pageFetchJson(tabId, URLS.upsampleImage, { method: "POST", headers: authHeaders(at), body, attempts: 3 });
    } catch (e) {
      lastErr = String((e && e.message) || e || "");
      // 如果仍然被外部/手动刷新打断，最后再走一次扩展 Service Worker fetch，
      // 它不依赖页面 frame，能避开 MAIN world 被销毁的问题。
      try {
        const fx = await fetchJson(URLS.upsampleImage, { method: "POST", headers: authHeaders(at), body });
        if (fx) ux = fx;
      } catch (e2) {
        lastErr = `${lastErr || "page fetch failed"}; extension fetch: ${String((e2 && e2.message) || e2 || "")}`;
      }
    }
    if (!ux) {
      if (i + 1 < maxRetries) {
        await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr || "upsample returned empty result");
      }
      await sleep(1500);
      continue;
    }
    const enc = ux.json?.encodedImage || "";
    if (ux.status < 400 && enc) return { encodedImage: enc, userPaygateTier: tier, resolutionLabel: target.label, targetResolution: target.targetResolution };
    lastErr = compactErrorResponse(ux) || `status=${ux && ux.status}`;
    if (i + 1 < maxRetries) {
      await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr);
    }
    await sleep(1500);
  }
  return { encodedImage: "", error: lastErr, resolutionLabel: target.label, targetResolution: target.targetResolution };
}

async function runImageWorkflow(tabId, p, at, runtime) {
  const projectId = p.project_id;
  const prompt = p.prompt || "";
  const imageUrls = p.extension_image_reference_urls || [];
  const imageInputs = [];
  const uploaded = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const up = await uploadImage(tabId, imageUrls[i], at, projectId, runtime, i, imageUrls.length);
    uploaded.push(up);
    imageInputs.push({ name: up.mediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
  }
  await runtime.progress(10, { stage: "submit_image_task", workflow_kind: "image" });
  const submitUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/flowMedia:batchGenerateImages`;
  let tx = null;
  let parsed = null;
  let submitErr = "";
  const maxImageSubmitAttempts = 3; // 首次提交 + 失败后连续重试 3 次
  const imageSubmitTimeoutMs = Math.max(10000, Number(p.image_submit_timeout_ms || p.submit_timeout_ms || 150000) || 150000);
  for (let attempt = 0; attempt < maxImageSubmitAttempts; attempt++) {
    try {
      const recaptcha = await getRecaptchaToken(tabId, "IMAGE_GENERATION");
      if (!recaptcha) throw new Error("VEO image recaptcha token not found");
      const clientContext = {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(projectId),
        tool: "PINHOLE"
      };
      const body = {
        clientContext,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests: [{
          clientContext,
          seed: randSeed(999999),
          imageModelName: p.extension_image_model_name || "NARWHAL",
          imageAspectRatio: p.extension_image_aspect_ratio || "IMAGE_ASPECT_RATIO_LANDSCAPE",
          structuredPrompt: { parts: [{ text: prompt }] },
          imageInputs
        }]
      };
      await runtime.progress(10, { stage: "submit_image_task", workflow_kind: "image", attempt: attempt + 1, max_attempts: maxImageSubmitAttempts, timeout_ms: imageSubmitTimeoutMs });
      tx = await pageFetchJson(tabId, submitUrl, { method: "POST", headers: authHeaders(at), body, attempts: 1, timeoutMs: imageSubmitTimeoutMs });
      if (tx.status >= 400) throw new Error(`VEO image submit failed: ${compactErrorResponse(tx)}`);
      parsed = parseImageResult(tx.json);
      break;
    } catch (e) {
      submitErr = String(e && e.message ? e.message : e || "");
      if (isNonRetryableVeoSubmitError(e)) throw e;
      if (/empty result|result null|missing fifeUrl|result undefined/i.test(submitErr)) {
        const recovered = await recoverWorkflowAfterEmptySubmit(tabId, at, projectId, runtime, "image");
        if (recovered && recovered.workflowId) {
          const finalUrl = await fetchWorkflowList(tabId, at, projectId);
          const latest = pickLatestWorkflowFromList(finalUrl) || recovered;
          parsed = {
            fifeUrl: "",
            mediaName: latest.workflowId,
            workflowId: latest.workflowId,
            projectId: latest.projectId || projectId
          };
          break;
        }
      }
      if (attempt + 1 < maxImageSubmitAttempts) {
        await runtime.progress(10, {
          stage: "submit_image_retry",
          workflow_kind: "image",
          attempt: attempt + 1,
          next_attempt: attempt + 2,
          max_attempts: maxImageSubmitAttempts,
          error: submitErr.slice(0, 300)
        });
        await resetLabsGoogleLocalStorageAndReloadForRetry(10, tabId, p.project_page, runtime, submitErr);
        await sleep(500 * (attempt + 1));
      }
    }
  }
  if (!parsed) {
    if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_submit_failed");
    await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
    throw new Error(submitErr || "VEO image submit failed");
  }
  let shareUrl = parsed.fifeUrl;
  let originImageUrl = parsed.fifeUrl;
  let resLabel = p.extension_image_resolution_label || "1K";
  let upsampleOk = false;
  let upsampleError = "";
  let ossUploads = [];
  if ((p.extension_image_want_upsample || p.extension_image_want_2k) && parsed.mediaName) {
    const up = await upsampleImage(tabId, at, p, parsed, runtime);
    if (up.encodedImage) {
      const dataUrl = `data:image/jpeg;base64,${up.encodedImage}`;
      upsampleOk = true;
      resLabel = up.resolutionLabel || resLabel;
      const ossCfg = p.oss_upload || p.extension_oss_upload || null;
      if (ossCfg) {
        try {
          await runtime.progress(92, { stage: "oss_upload", target_resolution: resLabel, media_id: parsed.mediaName });
          const uploaded = await uploadDataUrlToAliyunOss(ossCfg, dataUrl, {
            objectKeyPrefix: (ossCfg && (ossCfg.object_key_prefix || ossCfg.objectKeyPrefix)) || `veo_workflow/image/upsample/${String(resLabel || "2K").toLowerCase()}`,
            taskId: p._bridge_task_id || p.task_id || "",
            resolution: resLabel,
            contentType: "image/jpeg"
          });
          ossUploads = [uploaded];
          shareUrl = uploaded.url;
        } catch (e) {
          upsampleError = `OSS?????${String((e && e.message) || e || "").slice(0, 300)}`;
          if (ossCfg && ossCfg.required !== false) throw new Error(upsampleError);
          shareUrl = dataUrl;
        }
      } else {
        shareUrl = dataUrl;
      }
    } else {
      upsampleError = up.error || "upsample returned empty encodedImage";
      resLabel = "1K";
    }
  }
  const archived = archiveEnabled(p, "archive_workflow") ? await archiveWorkflow(tabId, at, parsed.workflowId, parsed.projectId || projectId) : false;
  if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_done");
  await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
  await runtime.progress(100, { stage: "done", image_url: shareUrl, workflow_id: parsed.workflowId });
  return {
    type: "veo_workflow_image",
    message: imageUrls.length ? "VEO 图生图完成" : "VEO 文生图完成",
    workflow_kind: "image",
    share_url: shareUrl,
    image_url: shareUrl,
    origin_image_url: originImageUrl,
    model_name: p.extension_image_model_name || "NARWHAL",
    aspect_ratio: p.extension_image_aspect_ratio || "IMAGE_ASPECT_RATIO_LANDSCAPE",
    resolution: resLabel,
    upsample_ok: upsampleOk,
    upsample_error: upsampleError || undefined,
    upsample_url: (ossUploads[0] && ossUploads[0].url) || undefined,
    upsample_oss_object_key: (ossUploads[0] && ossUploads[0].object_key) || undefined,
    oss_uploads: ossUploads,
    project_id: projectId,
    generated_media_id: parsed.mediaName,
    generated_workflow_id: parsed.workflowId,
    workflow_archived: archived,
    i2i_image_count: imageUrls.length
  };
}

async function pollVideo(tabId, at, pollMedia, pollOperations, runtime, p) {
  const maxWait = Math.max(60, Number(p.max_wait_seconds || p.timeout_seconds || 600));
  const interval = Math.max(0.5, Number(p.poll_interval_seconds || 5));
  const deadline = Date.now() + maxWait * 1000;
  let last = {};
  let attempt = 0;
  let urlFetchAttempts = 0;
  let unsafeFailureReasonWaits = 0;
  const maxUnsafeFailureReasonWaits = Math.max(0, Number(p.unsafe_failure_reason_extra_polls ?? 5));
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    attempt++;
    const tx = await pageFetchJson(tabId, URLS.videoPoll, { method: "POST", headers: authHeaders(at), body: { media: pollMedia } });
    if (tx.status >= 400) throw new Error(`VEO video poll failed: ${compactErrorResponse(tx)}`);
    last = parseVideoPoll(tx.json);
    const failureReasons = Array.isArray(last.failure?.failureReasons) ? last.failure.failureReasons : [];
    const isUnsafeGenerationFailure = last.failed
      && /PUBLIC_ERROR_UNSAFE_GENERATION/i.test(String(last.failure?.message || ""));
    const shouldWaitForUnsafeFailureReasons = isUnsafeGenerationFailure
      && !failureReasons.length
      && unsafeFailureReasonWaits < maxUnsafeFailureReasonWaits;
    if (shouldWaitForUnsafeFailureReasons) unsafeFailureReasonWaits++;
    const pct = 25 + Math.min(70, Math.floor((Date.now() - (deadline - maxWait * 1000)) / (maxWait * 1000) * 70));
    await runtime.progress(pct, {
      stage: shouldWaitForUnsafeFailureReasons ? "waiting_failure_reasons" : (last.failed ? "failed" : "polling"),
      attempt,
      status: last.status,
      workflow_id: last.workflowId,
      failure_reason_wait_attempt: shouldWaitForUnsafeFailureReasons ? unsafeFailureReasonWaits : undefined,
      failure_reason_wait_max: shouldWaitForUnsafeFailureReasons ? maxUnsafeFailureReasonWaits : undefined,
      failure_reasons: last.failed && failureReasons.length ? failureReasons : undefined,
      error: last.failed ? formatVideoPollFailure(last.failure) : undefined
    });
    if (shouldWaitForUnsafeFailureReasons) continue;
    if (last.failed) {
      const err = new Error(`VEO video generation failed: ${formatVideoPollFailure(last.failure)}`);
      if (failureReasons.length) {
        err.failureReasons = failureReasons;
        err.failure_reasons = failureReasons;
      }
      throw err;
    }
    if (last.videoUrl) return last;
    if (/MEDIA_GENERATION_STATUS_SUCCESSFUL/i.test(String(last.status || "")) && Array.isArray(pollOperations) && pollOperations.length) {
      urlFetchAttempts++;
      await runtime.progress(pct, {
        stage: "fetching_video_url",
        attempt,
        url_fetch_attempt: urlFetchAttempts,
        status: last.status,
        workflow_id: last.workflowId
      });
      const urlTx = await pageFetchJson(tabId, URLS.videoPoll, { method: "POST", headers: authHeaders(at), body: { operations: pollOperations } });
      if (urlTx.status >= 400) throw new Error(`VEO video url poll failed: ${compactErrorResponse(urlTx)}`);
      const urlLast = parseVideoPoll(urlTx.json);
      last = {
        ...last,
        ...urlLast,
        workflowId: urlLast.workflowId || last.workflowId,
        projectId: urlLast.projectId || last.projectId,
        mediaName: urlLast.mediaName || last.mediaName,
        status: urlLast.status || last.status
      };
      if (urlLast.failed) throw new Error(`VEO video generation failed: ${formatVideoPollFailure(urlLast.failure)}`);
      if (urlLast.videoUrl) return last;
    }
  }
  throw new Error(`VEO video polling timeout; last=${JSON.stringify(last).slice(0, 300)}`);
}

function stripI2vFl(modelKey) {
  return String(modelKey || "").replace("_fl_", "_").replace(/_fl$/, "");
}

async function runVideoWorkflow(tabId, p, at, runtime) {
  const projectId = p.project_id;
  const prompt = p.prompt || "";
  const mode = p.video_mode || "t2v";
  const uploaded = [];
  let submitUrl = URLS.videoT2V;
  let reqItem;
  const aspectRatio = p.extension_video_aspect_ratio || "VIDEO_ASPECT_RATIO_LANDSCAPE";
  let modelKey = p.extension_model_key || "veo_3_1_t2v_fast";
  let r2vVideoUpload = null;

  try {
  if (mode === "r2v") {
    const refs = [];
    const urls = p.ingredients_urls || [];
    const videoUrls = (Array.isArray(p.ingredients_video_urls) ? p.ingredients_video_urls : (p.ingredients_video_url ? [p.ingredients_video_url] : []))
      .map(x => String(x || "").trim())
      .filter(Boolean);
    if (videoUrls.length > 1) throw new Error("VEO r2v video reference supports at most one video url");
    for (let i = 0; i < urls.length; i++) {
      const up = await uploadImage(tabId, urls[i], at, projectId, runtime, i, urls.length);
      uploaded.push(up);
      refs.push({ imageUsageType: "IMAGE_USAGE_TYPE_ASSET", mediaId: up.mediaId });
    }
    if (videoUrls.length) {
      modelKey = "abra_edit";
      const videoUrl = videoUrls[0];
      const meta = await getLocalVideoMetadata(tabId, videoUrl, runtime);
      const durationSeconds = finitePositiveNumber(p.ingredients_video_duration_seconds || p.video_reference_duration_seconds || meta.duration) || 30;
      assertReferenceVideoDuration(durationSeconds, videoUrl);
      const uploadInfo = await uploadVideoInChunks(tabId, videoUrl, at, projectId, runtime);
      if (uploadInfo.workflowServerId) {
        uploaded.push({
          workflowId: uploadInfo.workflowServerId,
          projectId: uploadInfo.uploadProjectId || uploadInfo.projectId || projectId,
          mediaId: uploadInfo.mediaServerId || "",
          uploadType: "video_reference"
        });
      }
      const offsetInfo = await confirmUploadedVideoOffset(tabId, at, uploadInfo, durationSeconds, runtime);
      await pollUploadedVideoProcessing(tabId, at, uploadInfo, runtime, p);
      const endFrameIndex = computeVideoEndFrameIndex(p, meta, durationSeconds);
      await runtime.progress(14, {
        stage: "reference_video_frame_range",
        duration_seconds: durationSeconds,
        fps: finitePositiveNumber(p.ingredients_video_fps || p.video_reference_fps || meta.fps || meta.frameRate || meta.frame_rate) || undefined,
        frame_count: Number.parseInt(p.ingredients_video_frame_count || p.video_reference_frame_count || meta.frameCount || meta.frame_count || "", 10) || undefined,
        start_frame_index: Number(p.ingredients_video_start_frame_index || p.video_reference_start_frame_index || 0) || 0,
        end_frame_index: endFrameIndex
      });
      r2vVideoUpload = { ...uploadInfo, ...offsetInfo, durationSeconds, endFrameIndex };
      submitUrl = URLS.videoEdit;
    } else {
      submitUrl = URLS.videoR2V;
    }
    reqItem = {
      aspectRatio, seed: randSeed(),
      textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
      videoModelKey: modelKey,
      referenceImages: refs,
      metadata: { sceneId: crypto.randomUUID() }
    };
    if (r2vVideoUpload) {
      reqItem.videoInput = {
        mediaId: r2vVideoUpload.mediaServerId,
        startFrameIndex: Number(p.ingredients_video_start_frame_index || p.video_reference_start_frame_index || 0) || 0,
        endFrameIndex: r2vVideoUpload.endFrameIndex
      };
    }
  } else if (mode === "i2v") {
    const urls = p.i2v_urls || [];
    if (!urls.length) throw new Error("VEO i2v missing image urls");
    const ids = [];
    for (let i = 0; i < urls.length; i++) {
      const up = await uploadImage(tabId, urls[i], at, projectId, runtime, i, urls.length);
      uploaded.push(up);
      ids.push(up.mediaId);
    }
    if (ids[1]) {
      submitUrl = URLS.videoI2VStartEnd;
      reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, startImage: { mediaId: ids[0] }, endImage: { mediaId: ids[1] }, metadata: { sceneId: crypto.randomUUID() } };
    } else {
      submitUrl = URLS.videoI2VStart;
      modelKey = stripI2vFl(modelKey);
      reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, startImage: { mediaId: ids[0] }, metadata: { sceneId: crypto.randomUUID() } };
    }
  } else {
    reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, metadata: { sceneId: crypto.randomUUID() } };
  }

  await runtime.progress(10, { stage: "submit_task", video_mode: mode });
  let pollMedia = [];
  let pollOperations = [];
  let submittedWorkflow = { workflowId: "", projectId: "", mediaName: "" };
  let submitErr = "";
  const maxVideoSubmitAttempts = 3; // 首次提交 + 失败后连续重试 3 次
  const videoSubmitTimeoutMs = Math.max(10000, Number(p.video_submit_timeout_ms || p.submit_timeout_ms || 90000) || 90000);
  const userPaygateTier = normalizePaygateTier(await fetchVeoUserPaygateTier(tabId, at));
  for (let attempt = 0; attempt < maxVideoSubmitAttempts; attempt++) {
    try {
      const recaptcha = await getRecaptchaToken(tabId, "VIDEO_GENERATION");
      if (!recaptcha) throw new Error("VEO video recaptcha token not found");
      const clientContext = {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(projectId),
        tool: "PINHOLE",
        userPaygateTier
      };
      const mediaGenerationContext = {
        batchId: crypto.randomUUID(),
        audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
      };
      const body = mode === "r2v"
        ? {
            mediaGenerationContext,
            clientContext,
            requests: [reqItem],
            ...(r2vVideoUpload ? {} : { useV2ModelConfig: true })
          }
        : { mediaGenerationContext, clientContext, requests: [reqItem] };
      await runtime.progress(10, { stage: "submit_task", video_mode: mode, attempt: attempt + 1, max_attempts: maxVideoSubmitAttempts, timeout_ms: videoSubmitTimeoutMs, user_paygate_tier: userPaygateTier });
      const tx = await pageFetchJson(tabId, submitUrl, { method: "POST", headers: authHeaders(at), body, attempts: 1, timeoutMs: videoSubmitTimeoutMs });
      if (tx.status >= 400) throw new Error(`VEO video submit failed: ${compactErrorResponse(tx)}`);
      const submitMedia = Array.isArray(tx.json?.media) ? tx.json.media : [];
      submittedWorkflow = parseVideoSubmitWorkflow(tx.json);
      pollMedia = normalizeVideoPollMedia(submitMedia, submittedWorkflow.projectId || projectId);
      pollOperations = normalizeVideoPollOperations(submitMedia);
      if (!pollMedia.length) throw new Error(`VEO video submit missing poll media: ${JSON.stringify(tx.json).slice(0, 500)}`);
      break;
    } catch (e) {
      submitErr = String(e && e.message ? e.message : e || "");
      if (isNonRetryableVeoSubmitError(e)) throw e;
      if (attempt + 1 < maxVideoSubmitAttempts) {
        await runtime.progress(10, {
          stage: "submit_video_retry",
          video_mode: mode,
          attempt: attempt + 1,
          next_attempt: attempt + 2,
          max_attempts: maxVideoSubmitAttempts,
          error: submitErr.slice(0, 300)
        });
        await resetLabsGoogleLocalStorageAndReloadForRetry(10, tabId, p.project_page, runtime, submitErr);
        await sleep(500 * (attempt + 1));
      }
    }
  }
  if (!pollMedia.length) throw new Error(submitErr || "VEO video submit failed");
  await runtime.progress(25, { stage: "polling", media: pollMedia.length, operations: pollOperations.length });
  const done = await pollVideo(tabId, at, pollMedia, pollOperations, runtime, p);
  const generatedWorkflowId = done.workflowId || submittedWorkflow.workflowId || "";
  const generatedProjectId = done.projectId || submittedWorkflow.projectId || projectId;
  const generatedMediaId = done.mediaName || submittedWorkflow.mediaName || "";
  const archived = archiveEnabled(p, "archive_workflow")
    ? await archiveGeneratedWorkflow(tabId, at, generatedWorkflowId, generatedProjectId, runtime, "archive_video_workflow")
    : false;
  if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_done");
  await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
  await runtime.progress(100, { stage: "done", video_url: done.videoUrl, workflow_id: generatedWorkflowId });
  return {
    type: "veo_workflow_video",
    message: mode === "r2v" ? "VEO Ingredients（多图参考）视频完成" : (mode === "i2v" ? "VEO 图生视频完成" : "VEO 文生视频完成"),
    share_url: done.videoUrl,
    thumb_url: (mode === "i2v" ? (p.i2v_urls || [])[0] : (mode === "r2v" ? (p.ingredients_urls || [])[0] : "")) || "",
    video_type: mode,
    model_key: modelKey,
    aspect_ratio: aspectRatio,
    project_id: projectId,
    generated_media_id: generatedMediaId,
    generated_workflow_id: generatedWorkflowId,
    workflow_archived: archived
  };
  } catch (e) {
    if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_video_failed");
    await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
    throw e;
  }
}

export async function runVeoTask(msg, runtime) {
  const p = msg.payload || {};
  const action = String(p.action || p.workflow_kind || "").trim().toLowerCase();
  if (HUMAN_ACTIVITY_ACTIONS.has(action)) {
    return await runVeoHumanActivityAction(msg, runtime);
  }
  const veoRunId = beginVeoTaskRun(msg, runtime);
  try {
    await waitForVeoHumanActivityIdle(runtime);
    if (action === "current_page" || action === "get_current_page" || action === "current_url" || action === "get_current_url") {
      return await fetchVeoCurrentPageTask(msg, runtime);
    }
    const projectPage = p.project_page || p.target_url || "https://labs.google/fx";
    if (action === "fetch_tokens" || action === "fetch_access_tokens" || action === "get_access_tokens") {
      const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
      await reloadProjectPage(1, tabId, projectPage, runtime);
      closeOtherTabsInSameWindowLater(tabId, 5000);
      return await fetchVeoAccessTokensTask({ ...msg, payload: { ...p, tab_id: tabId } }, runtime);
    }
    if (action === "create_flow_project" || action === "flow_project_create" || action === "create_project") {
      return await createVeoFlowProjectTask(msg, runtime);
    }
    if (action === "delete_flow_project" || action === "flow_project_delete" || action === "delete_project") {
      return await deleteVeoFlowProjectTask(msg, runtime);
    }
    if (p.popup_test_task || p.veo_test_task) {
      // Popup 手动生成测试用于连通性验证，生成结果应保留在项目页供人工查看，
      // 不走常规任务的自动归档/清理流程。
      p.archive_workflow = false;
      p.archive_uploaded_workflows = false;
      await runtime.progress(1, { stage: "archive_setting", archive_enabled: false, reason: "popup_test_task" });
    } else {
      try {
        const got = await chrome.storage.local.get(["veo_archive_enabled"]);
        const enabled = got.veo_archive_enabled !== false; // default enabled
        p.archive_workflow = enabled;
        p.archive_uploaded_workflows = enabled;
        await runtime.progress(1, { stage: "archive_setting", archive_enabled: enabled });
      } catch (_) {
        p.archive_workflow = true;
        p.archive_uploaded_workflows = true;
      }
    }
    if (action === "balance_refresh" || action === "refresh_balance") {
      return await refreshVeoBalanceTask(msg, runtime);
    }
    await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
    // 普通生成任务必须保持在 project_page；如果余额刷新打开了 one.google 标签，
    // 这里会重新选中/导航回精确项目页，避免停留到 /tools/flow 列表页。

    await assertProjectPageAccessible(projectPage, runtime);
    const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
    closeOtherTabsInSameWindowLater(tabId, 5000);
    //await resetLabsGoogleLocalStorageAndReload(3, tabId, projectPage, runtime);
    await runtime.progress(5, { stage: "access_token" });
    const tokenInfo = p.access_token ? { access_token: p.access_token, expires: p.access_expires } : await getAccessTokenFromPage(tabId);
    const at = tokenInfo.access_token;
    //引入拟人操作
    await simulateHumanActivity(tabId, runtime, 5000, 15000, {
      stage: "veo_pre_workflow_human_activity",
      progress: 5,
      // 预提交阶段只需要轻量活动；不要点击 Flow 的 prompt/editor 输入框。
      // 复杂 SPA 中点击输入框可能触发焦点/懒加载/重渲染，且 chrome.scripting
      // 注入偶发会被拖到数分钟后才返回，阻塞真正的 submit_task。
      clickInputs: false,
      scroll: true,
      moveMouse: true,
      timeoutMs: 20000
    });
    if (p.workflow_kind === "image" || p.image_mode) {
      return await runImageWorkflow(tabId, p, at, runtime);
    }
    return await runVideoWorkflow(tabId, p, at, runtime);
  } finally {
    endVeoTaskRun(veoRunId, runtime);
  }
}

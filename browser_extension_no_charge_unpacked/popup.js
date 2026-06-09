function $(id) { return document.getElementById(id); }

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function renderStatus(st) {
  const dot = $("dot");
  dot.className = "dot";
  if (st.connected && st.helloOk) dot.classList.add("ok");
  else if (st.wsState === "connecting" || st.reconnectScheduled) dot.classList.add("warn");
  else dot.classList.add("bad");

  $("connText").textContent = st.connected && st.helloOk
    ? "已连接并注册"
    : (st.connected ? "WebSocket 已连接，等待注册" : `未连接：${st.wsState || "unknown"}`);

  const active = st.activeTask ? `${st.activeTask.provider || ""} / ${st.activeTask.task_id || ""}` : "无";
  const statusHtml = `
    <div>${esc(st.spaceId)} / ${esc(st.windowKey)} · ${esc(st.clientId || "-")}</div>
    <div>task: ${esc(active)}${st.lastError ? ` · error: ${esc(st.lastError)}` : ""}</div>
  `;
  if ($("statusKv").innerHTML !== statusHtml) $("statusKv").innerHTML = statusHtml;
}

const TRANSFER_URL_RE = /(https?:\/\/[^\s<>'"]+)/ig;

function linkifyEscapedLine(line) {
  const raw = String(line ?? "");
  let out = "";
  let last = 0;
  raw.replace(TRANSFER_URL_RE, (m, _g, idx) => {
    out += esc(raw.slice(last, idx));
    const href = esc(m);
    out += `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    last = idx + m.length;
    return m;
  });
  out += esc(raw.slice(last));
  return out;
}

function getTransferLines(data) {
  if (Array.isArray(data?.lines)) return data.lines.map(x => String(x ?? ""));
  const text = String(data?.text || "");
  return text ? text.split(/\r?\n/) : [];
}

async function setActiveTab(tab) {
  const name = tab === "transfer" ? "transfer" : "debug";
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === name));
  $("debugPanel")?.classList.toggle("active", name === "debug");
  $("transferPanel")?.classList.toggle("active", name === "transfer");
  try { await send("popup.setActiveTab", { tab: name }); } catch (_) {}
}

function renderTransferData(data) {
  const root = $("transferData");
  const meta = $("transferMeta");
  if (!root) return;
  // 不要在用户正在选择、点击或复制 Data Panel 内容时重建 DOM，否则会导致选区/点击状态瞬间失效。
  if (isUserInteractingWith(root)) return;
  const lines = getTransferLines(data);
  if (meta) {
    const bits = [];
    if (data?.title) bits.push(data.title);
    if (data?.source) bits.push(`来源: ${data.source}`);
    if (data?.received_at) bits.push(`接收: ${data.received_at}`);
    const metaText = bits.join(" · ");
    if (meta.textContent !== metaText) meta.textContent = metaText;
  }
  if (!lines.length) {
    const html = `<div class="empty">暂无接收数据</div>`;
    if (root.innerHTML !== html) root.innerHTML = html;
    return;
  }
  const html = lines.map((line, idx) => `
    <div class="transfer-line">
      <div class="transfer-text">${linkifyEscapedLine(line)}</div>
      <button class="copy-line-btn" data-copy-line="${idx}" type="button">复制</button>
    </div>
  `).join("");
  if (root.innerHTML !== html) root.innerHTML = html;
}

function renderLogs(logs) {
  const root = $("logs");
  // 日志区也避免在用户选择文字时全量刷新。
  if (isUserInteractingWith(root)) return;
  if (!logs || !logs.length) {
    const html = "<div class='hint'>暂无日志</div>";
    if (root.innerHTML !== html) root.innerHTML = html;
    return;
  }
  const html = logs.map(x => {
    const data = x.data ? "\n" + JSON.stringify(x.data, null, 2) : "";
    return `<div class="log ${esc(x.level || "")}">
      <span class="ts">${esc(x.ts || "")}</span>
      <span class="lvl">[${esc(x.level || "info")}]</span>
      ${esc(x.message || "")}${esc(data)}
    </div>`;
  }).join("");
  if (root.innerHTML !== html) root.innerHTML = html;
}

function setInputValueIfIdle(id, value) {
  const el = $(id);
  if (!el) return;
  // 输入框获得焦点时不要用 storage 中的旧值覆盖用户正在输入的内容。
  if (document.activeElement === el) return;
  const next = String(value ?? "");
  if (el.value !== next) el.value = next;
}

function setCheckboxIfIdle(id, checked) {
  const el = $(id);
  if (!el) return;
  if (document.activeElement === el) return;
  const next = !!checked;
  if (el.checked !== next) el.checked = next;
}

function isUserInteractingWith(root) {
  if (!root) return false;
  if (root.contains(document.activeElement)) return true;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return root.contains(sel.anchorNode) || root.contains(sel.focusNode);
}

let refreshInFlight = false;

async function refresh() {
  // 防止定时刷新和手动刷新重叠，进一步减少抖动。
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const resp = await send("popup.getState");
    if (!resp || !resp.ok) {
      $("connText").textContent = "读取 background 状态失败";
      return;
    }
    const cfg = resp.config || {};
    const st = resp.status || {};
    setInputValueIfIdle("bridgeUrl", cfg.bridgeUrl || st.bridgeUrl || "");
    setInputValueIfIdle("bridgeToken", cfg.bridgeToken || "");
    setInputValueIfIdle("spaceId", cfg.spaceId || st.spaceId || "");
    setInputValueIfIdle("windowKey", cfg.windowKey || st.windowKey || "");
    setInputValueIfIdle("googleAccount", cfg.googleAccount || "");
    setInputValueIfIdle("googlePassword", cfg.googlePassword || "");
    setInputValueIfIdle("googleEfa", cfg.googleEfa || "");
    setCheckboxIfIdle("googleAutoLoginWatchEnabled", !!cfg.googleAutoLoginWatchEnabled);
    setCheckboxIfIdle("veoArchiveEnabled", cfg.veoArchiveEnabled !== false);
    renderStatus(st);
    renderLogs(resp.logs || []);
    renderTransferData(resp.transferData || null);
    const active = resp.activeTab || "debug";
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === active));
    $("debugPanel")?.classList.toggle("active", active !== "transfer");
    $("transferPanel")?.classList.toggle("active", active === "transfer");
  } finally {
    refreshInFlight = false;
  }
}

async function save() {
  await send("popup.saveConfig", {
    config: {
      bridgeUrl: $("bridgeUrl").value.trim(),
      bridgeToken: $("bridgeToken").value.trim(),
      spaceId: $("spaceId").value.trim(),
      windowKey: $("windowKey").value.trim(),
      googleAccount: $("googleAccount").value.trim(),
      googlePassword: $("googlePassword").value,
      googleEfa: $("googleEfa").value.trim(),
      googleAutoLoginWatchEnabled: $("googleAutoLoginWatchEnabled").checked,
      veoArchiveEnabled: $("veoArchiveEnabled").checked
    }
  });
  setTimeout(refresh, 300);
}

async function saveGoogleAutoLoginWatch(triggerNow = true) {
  const enabled = !!$("googleAutoLoginWatchEnabled")?.checked;
  await send("popup.setGoogleAutoLoginWatch", {
    enabled,
    triggerNow: enabled && triggerNow,
    creds: {
      googleAccount: $("googleAccount")?.value.trim() || "",
      googlePassword: $("googlePassword")?.value || "",
      googleEfa: $("googleEfa")?.value.trim() || ""
    }
  });
  setTimeout(refresh, 300);
}

async function reconnect() {
  await send("popup.reconnect");
  setTimeout(refresh, 300);
}

async function clearCurrentPageLocalStorage() {
  const btn = $("clearPageStorageBtn");
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "打码中...";
  }
  try {
    const resp = await send("popup.clearCurrentPageLocalStorage");
    if (!resp || !resp.ok) throw new Error(resp?.error || "clear localStorage failed");
    if (btn) {
      const before = resp.result?.before;
      const after = resp.result?.after;
      btn.textContent = Number.isFinite(before) && Number.isFinite(after)
        ? `打码中...`
        : "已打码";
    }
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = "失败";
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || "打码";
      }
    }, 1200);
  }
}

async function runVeoGenerateTest() {
  const btn = $("veoGenerateTestBtn");
  const kind = $("veoTestKind")?.value === "video" ? "video" : "image";
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "测试中...";
  }
  try {
    const resp = await send("popup.veoGenerateTest", { kind });
    if (!resp || !resp.ok) throw new Error(resp?.error || "VEO generate test failed");
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = "失败";
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || "生成测试";
      }
    }, 1200);
  }
}

async function runGoogleAutoLogin() {
  const btn = $("googleAutoLoginBtn");
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "登录中...";
  }
  try {
    const resp = await send("popup.googleAutoLogin", {
      creds: {
        googleAccount: $("googleAccount")?.value.trim() || "",
        googlePassword: $("googlePassword")?.value || "",
        googleEfa: $("googleEfa")?.value.trim() || ""
      }
    });
    if (!resp || !resp.ok) throw new Error(resp?.error || "google auto login failed");
    if (btn) btn.textContent = resp.result?.done ? "已完成" : "已执行";
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = "失败";
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || "自动登录";
      }
    }, 1500);
  }
}

async function clearLogs() {
  await send("popup.clearLogs");
  await refresh();
}

async function copyText(text) {
  const t = String(text || "");
  if (!t) return;
  if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(t);
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

async function clearTransfer() {
  await send("popup.clearTransferData");
  await refresh();
}

async function copyAllTransfer() {
  const resp = await send("popup.getState");
  const lines = getTransferLines(resp?.transferData || null);
  await copyText(lines.join("\n"));
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});
$("transferData")?.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("[data-copy-line]");
  if (!btn) return;
  const resp = await send("popup.getState");
  const lines = getTransferLines(resp?.transferData || null);
  await copyText(lines[Number(btn.dataset.copyLine)] || "");
  btn.textContent = "已复制";
  setTimeout(() => { btn.textContent = "复制"; }, 900);
});

$("saveBtn").addEventListener("click", save);
$("refreshBtn").addEventListener("click", refresh);
$("googleAutoLoginBtn")?.addEventListener("click", runGoogleAutoLogin);
$("googleAutoLoginWatchEnabled")?.addEventListener("change", () => saveGoogleAutoLoginWatch(true).catch(console.error));
$("clearPageStorageBtn")?.addEventListener("click", clearCurrentPageLocalStorage);
$("veoGenerateTestBtn")?.addEventListener("click", runVeoGenerateTest);
$("clearBtn").addEventListener("click", clearLogs);
$("clearTransferBtn")?.addEventListener("click", clearTransfer);
$("copyAllTransferBtn")?.addEventListener("click", copyAllTransfer);
$("closePanelBtn")?.addEventListener("click", () => window.close());

refresh();
setInterval(refresh, 2000);

const $ = (selector) => document.querySelector(selector);
const state = { engines: [], selectedEngine: "pi", sending: false };

function context() {
  return { tenantId: $("#tenant").value.trim() || "demo-tenant", conversationId: $("#conversation").value.trim() || "group-alpha" };
}

function notice(message, timeout = 3500) {
  const element = $("#notice");
  element.textContent = message;
  element.classList.remove("hidden");
  if (timeout) setTimeout(() => element.classList.add("hidden"), timeout);
}

function compact(value) {
  if (!value) return "—";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function renderEngines() {
  const container = $("#engine-options");
  container.replaceChildren();
  for (const engine of state.engines) {
    const button = document.createElement("button");
    button.className = `engine-card${engine.name === state.selectedEngine ? " selected" : ""}`;
    button.dataset.engine = engine.name;
    const icon = document.createElement("span");
    icon.className = "engine-icon";
    icon.textContent = engine.name === "pi" ? "π" : "OC";
    const label = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = engine.displayName;
    const detail = document.createElement("small");
    detail.textContent = `${engine.transport} · ${engine.health?.status ?? "unknown"}`;
    label.append(title, detail);
    const radio = document.createElement("span");
    radio.className = "radio";
    button.append(icon, label, radio);
    button.addEventListener("click", () => selectEngine(engine.name));
    container.append(button);
  }
}

function selectEngine(name) {
  state.selectedEngine = name;
  $("#route-engine").textContent = name.toUpperCase();
  const welcomeEngine = $("#welcome-engine");
  if (welcomeEngine) welcomeEngine.textContent = name === "pi" ? "Pi" : "OpenCode";
  renderEngines();
}

async function loadEngines() {
  const response = await fetch("/api/engines");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "无法读取引擎");
  state.engines = payload.engines;
  $("#mode-badge").textContent = payload.engines[0]?.mode?.toUpperCase() ?? "UNKNOWN";
  $("#health-dot").style.background = payload.engines.every((item) => item.health?.status === "healthy") ? "var(--lime)" : "var(--orange)";
  renderEngines();
}

async function loadSession({ silent = false } = {}) {
  const { tenantId, conversationId } = context();
  const response = await fetch(`/api/sessions/${encodeURIComponent(conversationId)}?tenantId=${encodeURIComponent(tenantId)}`);
  if (response.status === 404) {
    $("#logical-session").textContent = "尚未创建";
    $("#active-engine").textContent = "—";
    $("#pi-binding").textContent = "—";
    $("#opencode-binding").textContent = "—";
    return;
  }
  const session = await response.json();
  if (!response.ok) throw new Error(session.error?.message ?? "无法读取会话");
  $("#logical-session").textContent = compact(session.logicalSessionId);
  $("#active-engine").textContent = session.activeEngine;
  $("#pi-binding").textContent = compact(session.bindings?.pi?.engineSessionId);
  $("#opencode-binding").textContent = compact(session.bindings?.opencode?.engineSessionId);
  selectEngine(session.activeEngine);
  if (!silent) notice("会话路由已刷新");
}

async function switchEngine() {
  const { tenantId, conversationId } = context();
  const response = await fetch(`/api/sessions/${encodeURIComponent(conversationId)}/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, engine: state.selectedEngine }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "切换失败");
  await loadSession({ silent: true });
  addSystemMessage(`路由已从 ${payload.previousEngine} 切换至 ${payload.activeEngine}；业务会话 ID 保持不变。`);
}

function addSystemMessage(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "message";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "GW";
  const content = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = "Gateway · route event";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  content.append(meta, bubble);
  wrapper.append(avatar, content);
  $("#messages").append(wrapper);
  scrollMessages();
}

function addMessage(role, text, engine = state.selectedEngine) {
  $(".welcome")?.remove();
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "YOU" : engine === "pi" ? "π" : "OC";
  const content = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? `${context().conversationId} · USER` : `${engine} · AGENT ENGINE`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  content.append(meta, bubble);
  wrapper.append(avatar, content);
  $("#messages").append(wrapper);
  scrollMessages();
  return bubble;
}

function addEvent(item) {
  $(".empty-events")?.remove();
  const row = document.createElement("div");
  row.className = "event";
  row.dataset.type = item.type;
  const header = document.createElement("strong");
  const name = document.createElement("span");
  name.textContent = item.type;
  const engine = document.createElement("span");
  engine.textContent = item.engine;
  header.append(name, engine);
  const data = document.createElement("code");
  data.textContent = JSON.stringify(item.data);
  row.append(header, data);
  $("#events").append(row);
  $("#events").scrollTop = $("#events").scrollHeight;
}

function scrollMessages() {
  const messages = $("#messages");
  messages.scrollTop = messages.scrollHeight;
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes("\n\n")) {
      const index = buffer.indexOf("\n\n");
      const block = buffer.slice(0, index).replaceAll("\r", "");
      buffer = buffer.slice(index + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      onEvent(event, data.join("\n"));
    }
  }
}

async function sendMessage(text) {
  if (state.sending) return;
  state.sending = true;
  $("#send").disabled = true;
  addMessage("user", text);
  const assistantBubble = addMessage("assistant", "", state.selectedEngine);
  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...context(), engine: state.selectedEngine, input: text }),
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error?.message ?? "请求失败");
    }
    await readSse(response, (type, raw) => {
      if (!raw || type === "done") return;
      const item = JSON.parse(raw);
      if (type === "error") throw new Error(item.error?.message ?? "引擎执行失败");
      addEvent(item);
      if (item.type === "message.delta") assistantBubble.textContent += item.data.delta ?? "";
      scrollMessages();
    });
    if (!assistantBubble.textContent) assistantBubble.textContent = "（引擎没有返回文本）";
    await loadSession({ silent: true });
  } catch (error) {
    assistantBubble.textContent = `请求失败：${error.message}`;
    notice(error.message, 5000);
  } finally {
    state.sending = false;
    $("#send").disabled = false;
    $("#prompt").focus();
  }
}

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = $("#prompt");
  const text = prompt.value.trim();
  if (!text) return;
  prompt.value = "";
  prompt.style.height = "auto";
  sendMessage(text);
});
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); }
});
$("#prompt").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${event.target.scrollHeight}px`;
});
$("#switch-engine").addEventListener("click", () => switchEngine().catch((error) => notice(error.message)));
$("#refresh-session").addEventListener("click", () => loadSession().catch((error) => notice(error.message)));
$("#new-session").addEventListener("click", () => {
  $("#conversation").value = `group-${Math.random().toString(36).slice(2, 7)}`;
  $("#messages").replaceChildren();
  addSystemMessage("已生成新的业务会话 ID；下一条消息会创建隔离的逻辑会话。 ");
  loadSession({ silent: true });
});
$("#conversation").addEventListener("change", () => loadSession({ silent: true }).catch((error) => notice(error.message)));
$("#tenant").addEventListener("change", () => loadSession({ silent: true }).catch((error) => notice(error.message)));
$("#toggle-events").addEventListener("click", () => $("#events-drawer").classList.add("open"));
$("#close-events").addEventListener("click", () => $("#events-drawer").classList.remove("open"));
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => sendMessage(button.textContent)));

loadEngines().then(() => loadSession({ silent: true })).catch((error) => notice(error.message, 0));

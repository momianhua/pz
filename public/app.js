const $ = (selector) => document.querySelector(selector);
const state = {
  sessionId: localStorage.getItem("competition-session-id") || "",
  activeEngine: "",
  sending: false,
  eventSource: null,
  streamMessages: new Map(),
};

function apiError(payload, fallback) {
  return new Error(payload?.message ?? payload?.error?.message ?? fallback);
}

async function request(path, init = {}) {
  traceHttp(init.method ?? "GET", path, "pending");
  const response = await fetch(path, init);
  let payload = null;
  if (response.status !== 204) {
    const raw = await response.text();
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { message: raw }; }
  }
  traceHttp(init.method ?? "GET", path, response.status);
  if (!response.ok) throw apiError(payload, `请求失败（HTTP ${response.status}）`);
  return payload;
}

function notice(message, kind = "error", timeout = 4500) {
  const element = $("#notice");
  element.textContent = message;
  element.className = `notice ${kind}`;
  if (timeout) setTimeout(() => element.classList.add("hidden"), timeout);
}

function setStatus(status) {
  const element = $("#session-status");
  element.textContent = status ?? "—";
  element.className = `status-badge ${status ?? ""}`;
  $("#abort").classList.toggle("hidden", status !== "busy");
}

function setSessionId(id) {
  state.sessionId = id || "";
  if (id) localStorage.setItem("competition-session-id", id);
  else localStorage.removeItem("competition-session-id");
  $("#session-id").textContent = id || "尚未创建";
  $("#session-id").title = id ? `${id}（点击复制）` : "";
  $("#endpoint-label").textContent = id ? `POST /session/${id.slice(0, 12)}…/prompt_async` : "请先创建会话";
}

function traceHttp(method, path, status) {
  addTrace({ type: "http.request", properties: { method, path, status, at: new Date().toLocaleTimeString() } });
}

function addTrace(item) {
  $(".empty-events")?.remove();
  const row = document.createElement("div");
  row.className = "event";
  row.dataset.type = item.type;
  const header = document.createElement("strong");
  const name = document.createElement("span");
  name.textContent = item.type;
  const session = document.createElement("span");
  session.textContent = item.properties?.sessionID ? item.properties.sessionID.slice(0, 15) : (item.properties?.status ?? "");
  header.append(name, session);
  const data = document.createElement("code");
  data.textContent = JSON.stringify(item.properties ?? {});
  row.append(header, data);
  $("#events").append(row);
  while ($("#events").children.length > 300) $("#events").firstElementChild.remove();
  $("#events").scrollTop = $("#events").scrollHeight;
}

async function loadRuntime() {
  const payload = await request("/api/engines");
  state.activeEngine = payload.activeEngine ?? "unknown";
  $("#active-engine").textContent = state.activeEngine === "opencode" ? "OpenCode" : state.activeEngine === "pi" ? "Pi Agent" : state.activeEngine;
  $("#engine-icon").textContent = state.activeEngine === "pi" ? "π" : state.activeEngine === "opencode" ? "OC" : "?";
  $("#route-engine").textContent = state.activeEngine.toUpperCase();
  $("#welcome-engine").textContent = $("#active-engine").textContent;
  $("#mode-badge").textContent = (payload.mode ?? payload.engines[0]?.mode ?? "unknown").toUpperCase();
  if (payload.model?.providerID) $("#provider-id").value = payload.model.providerID;
  if (payload.model?.modelID) $("#model-id").value = payload.model.modelID;
  const active = payload.engines.find((engine) => engine.name === state.activeEngine);
  $("#engine-detail").textContent = `${active?.transport ?? "unknown transport"} · ${active?.health?.status ?? "unknown"}`;
  $("#health-dot").classList.toggle("unhealthy", active?.health?.status !== "healthy");
  const container = $("#engine-options");
  container.replaceChildren();
  for (const engine of payload.engines) {
    const row = document.createElement("div");
    row.className = `engine-health-row${engine.name === state.activeEngine ? " current" : ""}`;
    const name = document.createElement("span");
    name.textContent = engine.displayName;
    const detail = document.createElement("small");
    detail.textContent = `${engine.name === state.activeEngine ? "本次启用" : "已接入"} · ${engine.health?.status ?? "unknown"}`;
    row.append(name, detail);
    container.append(row);
  }
}

async function createSession() {
  if (state.sending) return;
  const title = $("#session-title").value.trim();
  if (!title) return notice("请填写会话标题");
  const directory = $("#directory").value.trim();
  const path = `/session${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`;
  const session = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  setSessionId(session.id);
  setStatus(session.status);
  $("#message-count").textContent = "0";
  state.streamMessages.clear();
  $("#messages").replaceChildren();
  addSystemMessage(`已通过 POST /session 创建官方评测会话。会话 ID：${session.id}`);
  notice("官方会话创建成功", "success");
}

async function loadSession({ quiet = false } = {}) {
  if (!state.sessionId) return;
  try {
    const session = await request(`/session/${encodeURIComponent(state.sessionId)}`);
    setStatus(session.status);
    $("#message-count").textContent = String(session.message_count ?? 0);
    await loadMessages();
    if (!quiet) notice("已从官方接口刷新", "success");
  } catch (error) {
    if (/not found/i.test(error.message)) {
      setSessionId("");
      setStatus(null);
      $("#message-count").textContent = "0";
    }
    if (!quiet) notice(error.message);
  }
}

function makeMessage(role, text, metaText, messageId) {
  $(".welcome")?.remove();
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;
  if (messageId) wrapper.dataset.messageId = messageId;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "YOU" : role === "assistant" ? (state.activeEngine === "pi" ? "π" : "OC") : "GW";
  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = metaText;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  content.append(meta, bubble);
  wrapper.append(avatar, content);
  $("#messages").append(wrapper);
  scrollMessages();
  return { wrapper, bubble, content };
}

function addSystemMessage(text) {
  makeMessage("system", text, "GATEWAY · OFFICIAL API");
}

function renderTool(content, part) {
  const tool = document.createElement("div");
  tool.className = `tool-part ${part.state?.status ?? ""}`;
  tool.textContent = `${part.state?.status === "completed" ? "✓" : "↻"} ${part.state?.title ?? part.tool ?? "工具调用"}`;
  content.append(tool);
}

function renderMessages(messages) {
  $("#messages").replaceChildren();
  state.streamMessages.clear();
  if (!messages.length) {
    addSystemMessage("会话已创建，尚无消息。发送内容后，评测接口返回的数据会显示在这里。");
    return;
  }
  for (const message of messages) {
    const role = ["user", "assistant"].includes(message.role) ? message.role : "system";
    const meta = role === "user" ? `USER · ${message.id}` : role === "assistant" ? `${state.activeEngine.toUpperCase()} · ${message.info?.finish ?? "running"} · ${message.id}` : `TOOL · ${message.tool_name ?? "result"}`;
    const view = makeMessage(role, message.content ?? "", meta, message.id);
    for (const part of message.parts ?? []) if (part.type === "tool") renderTool(view.content, part);
  }
  scrollMessages();
}

async function loadMessages() {
  if (!state.sessionId) return;
  const messages = await request(`/session/${encodeURIComponent(state.sessionId)}/message`);
  renderMessages(messages);
  $("#message-count").textContent = String(messages.length);
}

function streamView(messageId) {
  let view = state.streamMessages.get(messageId);
  if (!view) {
    view = makeMessage("assistant", "", `${state.activeEngine.toUpperCase()} · SSE STREAMING`, messageId);
    state.streamMessages.set(messageId, view);
  }
  return view;
}

function handleGatewayEvent(item) {
  addTrace(item);
  const properties = item.properties ?? {};
  if (properties.sessionID && properties.sessionID !== state.sessionId) return;
  if (item.type === "session.status") setStatus(properties.status?.type);
  if (item.type === "session.idle") setStatus("idle");
  if (item.type === "session.error") notice(properties.error?.message ?? "会话执行失败", "error", 0);
  if (item.type === "message.part.updated") {
    const view = streamView(properties.messageID);
    const part = properties.part ?? {};
    if (part.type === "text") view.bubble.textContent += part.content ?? "";
    if (part.type === "tool") renderTool(view.content, part);
    scrollMessages();
  }
  if (item.type === "question.asked" || item.type === "permission.asked") loadInteractions().catch(() => {});
}

function connectEvents() {
  state.eventSource?.close();
  const source = new EventSource("/event");
  state.eventSource = source;
  source.onopen = () => {
    $("#sse-dot").classList.add("connected");
    traceHttp("SSE", "/event", "connected");
  };
  source.onmessage = (event) => {
    try { handleGatewayEvent(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
  };
  source.onerror = () => $("#sse-dot").classList.remove("connected");
}

async function sendMessage(text) {
  if (state.sending) return;
  if (!state.sessionId) await createSession();
  if (!state.sessionId) return;
  const providerID = $("#provider-id").value.trim();
  const modelID = $("#model-id").value.trim();
  if (!providerID || !modelID) return notice("providerID 和 modelID 不能为空");
  state.sending = true;
  $("#send").disabled = true;
  makeMessage("user", text, "USER · POST /prompt_async");
  try {
    await request(`/session/${encodeURIComponent(state.sessionId)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }], model: { providerID, modelID }, agent: "assistant" }),
    });
    await loadSession({ quiet: true });
  } catch (error) {
    notice(error.message, "error", 0);
    await loadSession({ quiet: true });
  } finally {
    state.sending = false;
    $("#send").disabled = false;
    $("#prompt").focus();
  }
}

async function abortSession() {
  if (!state.sessionId) return;
  await request(`/session/${encodeURIComponent(state.sessionId)}/abort`, { method: "POST" });
  notice("已发送中止请求", "success");
}

async function loadInteractions() {
  const [questions, permissions] = await Promise.all([request("/question"), request("/permission")]);
  const relevantQuestions = questions.filter((item) => !state.sessionId || item.sessionID === state.sessionId);
  const relevantPermissions = permissions.filter((item) => !state.sessionId || item.sessionID === state.sessionId);
  const container = $("#interactions");
  container.replaceChildren();
  for (const requestItem of relevantQuestions) {
    const card = document.createElement("div");
    card.className = "interaction-card";
    const question = requestItem.questions?.[0] ?? {};
    const title = document.createElement("strong");
    title.textContent = "Agent 反问";
    const prompt = document.createElement("p");
    prompt.textContent = question.question ?? "请选择答案";
    card.append(title, prompt);
    const options = document.createElement("div");
    options.className = "interaction-actions";
    for (const option of question.options ?? []) {
      const button = document.createElement("button");
      button.textContent = option.label;
      button.title = option.description ?? "";
      button.addEventListener("click", () => replyQuestion(requestItem.id, option.label));
      options.append(button);
    }
    if (!options.children.length) {
      const input = document.createElement("input");
      input.placeholder = "输入回答后按 Enter";
      input.addEventListener("keydown", (event) => { if (event.key === "Enter" && input.value.trim()) replyQuestion(requestItem.id, input.value.trim()); });
      options.append(input);
    }
    card.append(options);
    container.append(card);
  }
  for (const requestItem of relevantPermissions) {
    const card = document.createElement("div");
    card.className = "interaction-card permission";
    const title = document.createElement("strong");
    title.textContent = `权限申请 · ${requestItem.permission}`;
    const patterns = document.createElement("p");
    patterns.textContent = (requestItem.patterns ?? []).join("、") || "引擎请求执行受限操作";
    card.append(title, patterns);
    const actions = document.createElement("div");
    actions.className = "interaction-actions";
    for (const [label, reply] of [["允许一次", "once"], ["始终允许", "always"], ["拒绝", "reject"]]) {
      const button = document.createElement("button");
      button.textContent = label;
      if (reply === "reject") button.className = "danger";
      button.addEventListener("click", () => replyPermission(requestItem.id, reply));
      actions.append(button);
    }
    card.append(actions);
    container.append(card);
  }
  container.classList.toggle("hidden", !container.children.length);
}

async function replyQuestion(id, answer) {
  await request(`/question/${encodeURIComponent(id)}/reply`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [[answer]] }),
  });
  await loadInteractions();
}

async function replyPermission(id, reply) {
  await request(`/permission/${encodeURIComponent(id)}/reply`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply }),
  });
  await loadInteractions();
}

function scrollMessages() {
  const messages = $("#messages");
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
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
  event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
  event.target.style.overflowY = event.target.scrollHeight > 160 ? "auto" : "hidden";
});
$("#create-session").addEventListener("click", () => createSession().catch((error) => notice(error.message)));
$("#new-session").addEventListener("click", () => createSession().catch((error) => notice(error.message)));
$("#refresh-messages").addEventListener("click", () => loadSession().catch((error) => notice(error.message)));
$("#abort").addEventListener("click", () => abortSession().catch((error) => notice(error.message)));
$("#session-id").addEventListener("click", async () => {
  if (!state.sessionId) return;
  await navigator.clipboard.writeText(state.sessionId);
  notice("Session ID 已复制", "success");
});
$("#toggle-events").addEventListener("click", () => $("#events-drawer").classList.add("open"));
$("#close-events").addEventListener("click", () => $("#events-drawer").classList.remove("open"));
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => sendMessage(button.textContent)));

setSessionId(state.sessionId);
connectEvents();
Promise.all([loadRuntime(), loadInteractions()])
  .then(() => loadSession({ quiet: true }))
  .catch((error) => notice(error.message, "error", 0));

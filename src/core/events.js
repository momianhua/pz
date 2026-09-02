export function event(type, engine, runId, data = {}) {
  return {
    type,
    engine,
    runId,
    timestamp: new Date().toISOString(),
    data,
  };
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || typeof part?.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

export async function collectEvents(iterable) {
  const events = [];
  let text = "";
  for await (const item of iterable) {
    events.push(item);
    if (item.type === "message.delta") text += item.data.delta ?? "";
    if (item.type === "message.completed" && !text) text = item.data.text ?? "";
  }
  return { events, text };
}

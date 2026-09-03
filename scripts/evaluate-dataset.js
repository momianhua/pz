#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createApp } from "../src/app.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TEST_DATA_ROOT = join(REPO_ROOT, "test_data");
const ALL_TASKS = ["office_022", "office_035", "office_103", "office_11", "office_132", "office_139", "office_14", "office_15", "office_18"];

function argumentsOf(argv) {
  const result = { engine: "both", tasks: ALL_TASKS, timeoutMs: 600_000, repairAttempts: 1, mock: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split("=", 2);
    const value = inline ?? argv[index + 1];
    if (name === "--engine") { result.engine = value; if (inline === undefined) index += 1; }
    else if (name === "--tasks") { result.tasks = value.split(",").map((item) => item.trim()).filter(Boolean); if (inline === undefined) index += 1; }
    else if (name === "--timeout-ms") { result.timeoutMs = Number(value); if (inline === undefined) index += 1; }
    else if (name === "--repair-attempts") { result.repairAttempts = Number(value); if (inline === undefined) index += 1; }
    else if (name === "--mock") result.mock = true;
  }
  if (!["pi", "opencode", "both"].includes(result.engine)) throw new Error("--engine must be pi, opencode, or both");
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs < 1_000) throw new Error("--timeout-ms must be at least 1000");
  if (!Number.isInteger(result.repairAttempts) || result.repairAttempts < 0 || result.repairAttempts > 3) throw new Error("--repair-attempts must be between 0 and 3");
  for (const task of result.tasks) if (!ALL_TASKS.includes(task)) throw new Error(`Unknown task: ${task}`);
  return result;
}

async function loadTask(directory) {
  const raw = await readFile(join(TEST_DATA_ROOT, directory, "task.json"), "utf8");
  const repaired = raw.replace(/[A-Za-z]:\\[^"\r\n]*/g, (path) => path.replaceAll("\\", "\\\\"));
  const payload = JSON.parse(repaired);
  if (!Array.isArray(payload.tasks) || payload.tasks.length !== 1) throw new Error(`${directory}/task.json must contain exactly one task`);
  return payload.tasks[0];
}

export function taskPlan(taskDirectory, workspaceRoot) {
  const directory = join(workspaceRoot, taskDirectory);
  const paths = {
    office_022: {
      input: join(directory, "短视频平台差异化分析报告.pptx"),
      output: join(directory, "短视频平台差异化分析报告_主体结构优化版.pptx"),
    },
    office_035: { output: join(directory, "openclaw.pptx") },
    office_103: { input: join(directory, "待清理目录") },
    office_11: {
      input: join(directory, "OpenClaw学术洞察报告.docx"),
      output: join(directory, "OpenClaw学术洞察报告_执行摘要润色版.docx"),
    },
    office_132: {
      input: join(directory, "华为2025手机.docx"),
      output: join(directory, "备份", "华为2025手机-sheet.xlsx"),
    },
    office_139: { output: join(directory, "自动驾驶最新资讯分析.md") },
    office_14: { input: join(directory, "task.csv"), output: join(directory, "task_违约风险分析.md") },
    office_15: { input: join(directory, "task.csv"), output: join(directory, "task_客户分层与违约特征分析.md") },
    office_18: { input: join(directory, "generate_excel_1.xlsx"), output: join(directory, "库存管理台账_补货优先级分析.md") },
  }[taskDirectory];
  if (!paths) throw new Error(`No task plan for ${taskDirectory}`);
  return { directory, ...paths };
}

export function rewriteQuery(taskDirectory, original, plan) {
  const queries = {
    office_022: `请基于 ${plan.input}，对第 3 到 7 页做结构优化，把“行业概览—用户规模—用户特征—内容生态—推荐机制”改成更连贯的讲述顺序。保留所有现有数据点，减少碎片化短句，每页形成“结论 + 证据”版式，另存为 ${plan.output}。`,
    office_035: `请输出一份关于 OpenClaw 的 PPT，包含基本介绍、核心功能、核心架构、部署方式、部署依赖，总共不超过 5 页，不必确认大纲，保存到 ${plan.output}。`,
    office_103: `删除 ${plan.input} 及其子目录下所有文件名包含“西安”的文件。只允许操作这个测试目录，不要删除目录本身或其他文件。`,
    office_11: `请打开 ${plan.input}，把“执行摘要”中介绍 OpenClaw 影响力和行业采用情况的两段文字改写成更克制、正式、适合内部研究汇报的表述。不要改动事实信息和章节结构，保留 GitHub Stars、MIT、自托管、主流云厂商采用等关键信息，另存为 ${plan.output}。`,
    office_132: `分析 ${plan.input}，将其中的所有表格导出到 ${plan.output}；每个原始表格放到不同 sheet，并创建输出目录。`,
    office_139: `请收集并分析自动驾驶领域截至今天的最新资讯和动态，列出来源名称、发布日期和可访问 URL，区分事实与分析，保存为 ${plan.output}。`,
    office_14: `请基于 ${plan.input} 做违约风险分析，重点看 credit_score、debt_ratio、late_payments、loan_amount 与 defaulted 的关系。输出中文 Markdown，至少包含高风险特征、低风险特征、3 条可执行建议，以及按风险高低排序的样本观察表，保存为 ${plan.output}。`,
    office_15: `请分析 ${plan.input}，从 age、income、monthly_spend、debt_ratio 四个字段做客户分层，判断哪些组合更容易出现 defaulted=1。不要只给均值，补充分层口径、异常样本观察和业务含义，写成 500 到 800 字中文分析短报，保存为 ${plan.output}。`,
    office_18: `请基于 ${plan.input} 的“库存管理台账”做补货优先级分析，重点关注当前库存、安全库存、最大库存、采购周期和供应商。输出中文备忘录，分成“高优先级补货”“需要观察”“库存相对安全”三类，给出排序依据和建议动作，保存为 ${plan.output}。`,
  };
  return `${queries[taskDirectory] ?? original}\n\n这是隔离测试工作区。所有文件操作必须限制在 ${plan.directory} 内。需要处理 Office 文件时请优先直接使用 Python 的 python-pptx、python-docx、openpyxl 高层库，不要逐层解压或研究 Open XML；较长代码先写入当前目录的 .py 文件再运行。请优先完成产物并做最小必要验证，不要只描述步骤。`;
}

async function fileCheck(path, label, office = false) {
  if (!existsSync(path)) return { label, passed: false, detail: `missing: ${path}` };
  const content = await readFile(path);
  if (!content.length) return { label, passed: false, detail: "empty file" };
  if (office && !(content[0] === 0x50 && content[1] === 0x4b)) return { label, passed: false, detail: "not a valid ZIP-based Office document" };
  return { label, passed: true, detail: `${content.length} bytes` };
}

async function markdownCheck(path, labels) {
  const base = await fileCheck(path, "output exists");
  if (!base.passed) return [base];
  const text = await readFile(path, "utf8");
  return [base, ...labels.map((label) => ({ label: `contains ${label}`, passed: text.includes(label), detail: text.includes(label) ? "found" : "missing" }))];
}

export async function validateTask(taskDirectory, plan) {
  if (taskDirectory === "office_103") {
    const removed = [join(plan.input, "西安会议纪要.txt"), join(plan.input, "子目录", "客户_西安_清单.csv")];
    const retained = [join(plan.input, "北京会议纪要.txt"), join(plan.input, "子目录", "西北区域.txt")];
    return [
      { label: "matching files deleted", passed: removed.every((path) => !existsSync(path)), detail: removed.filter(existsSync).join(", ") || "all removed" },
      { label: "non-matching files retained", passed: retained.every(existsSync), detail: retained.filter((path) => !existsSync(path)).join(", ") || "all retained" },
    ];
  }
  if (["office_022", "office_035", "office_11", "office_132"].includes(taskDirectory)) {
    return [await fileCheck(plan.output, "valid Office artifact", true)];
  }
  if (taskDirectory === "office_139") {
    const checks = await markdownCheck(plan.output, ["来源", "分析"]);
    if (existsSync(plan.output)) {
      const text = await readFile(plan.output, "utf8");
      checks.push({ label: "contains source URL", passed: /https?:\/\//i.test(text), detail: /https?:\/\//i.test(text) ? "found" : "missing" });
    }
    return checks;
  }
  const labels = {
    office_14: ["高风险", "低风险", "建议", "样本"],
    office_15: ["分层", "异常", "业务"],
    office_18: ["高优先级补货", "需要观察", "库存相对安全", "建议"],
  }[taskDirectory] ?? [];
  const checks = await markdownCheck(plan.output, labels);
  if (taskDirectory === "office_15" && existsSync(plan.output)) {
    const length = (await readFile(plan.output, "utf8")).replace(/\s/g, "").length;
    checks.push({ label: "report length 500-800", passed: length >= 500 && length <= 800, detail: `${length} non-whitespace characters` });
  }
  return checks;
}

async function requestJson(url, init = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      signal: init.signal,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
        resolveRequest({ response: { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300 }, body });
      });
    });
    request.on("error", rejectRequest);
    if (init.body) request.write(init.body);
    request.end();
  });
}

async function runEngine(engine, options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = join(REPO_ROOT, "test_runs", `${stamp}-${engine}`);
  const workspaceRoot = join(runRoot, "workspace");
  await mkdir(runRoot, { recursive: true });
  execFileSync(process.env.PYTHON_COMMAND || "python", [join(REPO_ROOT, "scripts", "prepare-test-data.py"), "--source", TEST_DATA_ROOT, "--output", workspaceRoot], { stdio: "inherit" });

  const providerID = options.mock ? "mock-provider" : engine === "pi"
    ? (process.env.PI_PROVIDER || process.env.LOCAL_MODEL_PROVIDER_ID)
    : (process.env.OPENCODE_PROVIDER_ID || process.env.LOCAL_MODEL_PROVIDER_ID);
  const modelID = options.mock ? "mock-model" : engine === "pi"
    ? (process.env.PI_MODEL || process.env.LOCAL_MODEL_ID)
    : (process.env.OPENCODE_MODEL_ID || process.env.LOCAL_MODEL_ID);
  if (!providerID || !modelID) throw new Error(`${engine} provider/model is not configured`);

  const app = await createApp({
    defaultEngine: engine,
    engineMode: options.mock ? "mock" : "real",
    stateFile: join(runRoot, "state.json"),
    runTimeoutMs: options.timeoutMs,
    openCodeAutostart: engine === "opencode",
    openCodePermissionMode: "allow",
    port: 0,
    host: "127.0.0.1",
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const results = [];
  try {
    for (const taskDirectory of options.tasks) {
      const task = await loadTask(taskDirectory);
      const plan = taskPlan(taskDirectory, workspaceRoot);
      const query = rewriteQuery(taskDirectory, task.query, plan);
      const started = Date.now();
      const result = { taskDirectory, taskId: task.task_id, title: task.title, engine, query, startedAt: new Date(started).toISOString() };
      process.stdout.write(`[${engine}] ${taskDirectory} ${task.title} ... `);
      try {
        const created = await requestJson(`${baseUrl}/session?directory=${encodeURIComponent(plan.directory)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: `${engine}-${task.task_id}` }),
        });
        if (!created.response.ok) throw new Error(`create session ${created.response.status}: ${JSON.stringify(created.body)}`);
        result.sessionId = created.body.id;
        const prompted = await requestJson(`${baseUrl}/session/${encodeURIComponent(result.sessionId)}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: query }], model: { providerID, modelID }, agent: "assistant" }),
          signal: AbortSignal.timeout(options.timeoutMs + 30_000),
        });
        result.httpStatus = prompted.response.status;
        if (prompted.response.status !== 204) throw new Error(`prompt ${prompted.response.status}: ${JSON.stringify(prompted.body)}`);
        const messages = await requestJson(`${baseUrl}/session/${encodeURIComponent(result.sessionId)}/message`);
        result.messages = messages.body;
        await writeFile(join(plan.directory, `${engine}-messages.json`), JSON.stringify(messages.body, null, 2), "utf8");
        const final = Array.isArray(messages.body) ? messages.body.at(-1) : null;
        result.protocolChecks = {
          finalAssistant: final?.role === "assistant",
          finishStop: final?.info?.finish === "stop",
          stepFinish: final?.parts?.some((part) => part.type === "step-finish") === true,
        };
        result.artifactChecks = await validateTask(taskDirectory, plan);
        result.passed = Object.values(result.protocolChecks).every(Boolean) && result.artifactChecks.every((check) => check.passed);
        result.repairAttempts = [];
        for (let repair = 1; !result.passed && repair <= options.repairAttempts; repair += 1) {
          const failures = result.artifactChecks.filter((check) => !check.passed).map((check) => `${check.label}（${check.detail}）`).join("；");
          const repairPrompt = `上一次执行未通过产物校验：${failures}。请直接检查并修复现有产物，严格满足原任务要求；不要重新做无关分析。`;
          const repaired = await requestJson(`${baseUrl}/session/${encodeURIComponent(result.sessionId)}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: repairPrompt }], model: { providerID, modelID }, agent: "assistant" }),
            signal: AbortSignal.timeout(options.timeoutMs + 30_000),
          });
          const attempt = { attempt: repair, httpStatus: repaired.response.status };
          if (repaired.response.status !== 204) {
            attempt.error = `repair ${repaired.response.status}: ${JSON.stringify(repaired.body)}`;
            result.repairAttempts.push(attempt);
            break;
          }
          result.artifactChecks = await validateTask(taskDirectory, plan);
          attempt.artifactChecks = result.artifactChecks;
          result.repairAttempts.push(attempt);
          result.passed = Object.values(result.protocolChecks).every(Boolean) && result.artifactChecks.every((check) => check.passed);
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.passed = false;
      }
      result.elapsedMs = Date.now() - started;
      results.push(result);
      console.log(result.passed ? `PASS (${result.elapsedMs} ms)` : `FAIL (${result.elapsedMs} ms)`);
      await writeFile(join(runRoot, "results.json"), JSON.stringify({ engine, providerID, modelID, results }, null, 2), "utf8");
    }
  } finally {
    app.server.close();
    await once(app.server, "close");
    await app.gateway.shutdown();
    app.openCodeServer.stop();
  }

  const passed = results.filter((item) => item.passed).length;
  const lines = [
    `# ${engine} 测试集执行报告`, "", `- 模型：${providerID}/${modelID}`, `- 通过：${passed}/${results.length}`, `- 工作区：${workspaceRoot}`, "",
    "| 任务 | 结果 | 耗时 | 失败原因 |", "|---|---:|---:|---|",
    ...results.map((item) => `| ${item.taskDirectory} ${item.title} | ${item.passed ? "PASS" : "FAIL"} | ${(item.elapsedMs / 1000).toFixed(1)}s | ${(item.error ?? item.artifactChecks?.filter((check) => !check.passed).map((check) => check.label).join("、") ?? "").replaceAll("|", "\\|")} |`),
  ];
  await writeFile(join(runRoot, "REPORT.md"), lines.join("\n"), "utf8");
  return { engine, runRoot, passed, total: results.length, results };
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const engines = options.engine === "both" ? ["pi", "opencode"] : [options.engine];
  const summaries = [];
  for (const engine of engines) summaries.push(await runEngine(engine, options));
  console.log("\nSummary");
  for (const summary of summaries) console.log(`${summary.engine}: ${summary.passed}/${summary.total} passed; ${summary.runRoot}`);
  if (summaries.some((summary) => summary.passed !== summary.total)) process.exitCode = 1;
}

if (process.argv[1] && basename(process.argv[1]) === basename(import.meta.filename)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

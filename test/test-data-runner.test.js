import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rewriteQuery, taskPlan } from "../scripts/evaluate-dataset.js";
import { readFile } from "node:fs/promises";

test("test-data runner rewrites unsafe fixed paths into its isolated workspace", () => {
  const root = "C:\\isolated-contest-run";
  const plan = taskPlan("office_103", root);
  const query = rewriteQuery("office_103", "删除D:/test_data", plan);
  assert.equal(plan.input, join(root, "office_103", "待清理目录"));
  assert.match(query, /isolated-contest-run/);
  assert.doesNotMatch(query, /D:\/test_data/);
  assert.match(query, /只允许操作这个测试目录/);
});

test("test-data runner gives Office tasks concrete input and output artifacts", () => {
  const root = "C:\\isolated-contest-run";
  for (const task of ["office_022", "office_11", "office_132", "office_18"]) {
    const plan = taskPlan(task, root);
    const query = rewriteQuery(task, "original", plan);
    assert.ok(plan.input);
    assert.ok(plan.output);
    assert.match(query, new RegExp(plan.output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("contest task files with raw Windows paths remain discoverable", async () => {
  const raw = await readFile(new URL("../test_data/office_11/task.json", import.meta.url), "utf8");
  assert.match(raw, /D:\\gpt-solution/);
  const repaired = raw.replace(/[A-Za-z]:\\[^"\r\n]*/g, (path) => path.replaceAll("\\", "\\\\"));
  assert.equal(JSON.parse(repaired).tasks[0].task_id, "office_011");
});

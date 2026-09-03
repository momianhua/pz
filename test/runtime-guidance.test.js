import test from "node:test";
import assert from "node:assert/strict";
import { withRuntimeGuidance } from "../src/core/runtime-guidance.js";

test("runtime guidance is capability-specific", () => {
  const plain = withRuntimeGuidance("你好", "opencode");
  assert.equal(plain, "你好");
  const office = withRuntimeGuidance("编辑 report.pptx", "opencode");
  assert.match(office, /python-pptx/);
  const research = withRuntimeGuidance("收集最新自动驾驶资讯和动态", "pi");
  assert.match(research, /news-search\.py/);
  assert.match(research, /来源事实/);
});

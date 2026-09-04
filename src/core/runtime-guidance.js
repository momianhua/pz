import { fileURLToPath } from "node:url";

const NEWS_HELPER = fileURLToPath(new URL("../../scripts/news-search.py", import.meta.url));

export function withRuntimeGuidance(input, engine) {
  const hints = [];
  if (engine === "pi" && process.platform === "win32") {
    hints.push("当前 shell 工具由 PowerShell 执行。请使用 PowerShell 兼容命令；较长的 Python 程序应先用 write 工具保存为 .py 文件，再执行 python 文件路径。处理中文时直接在程序中使用 Unicode，不要依赖控制台回显判断编码。");
  }
  if (/\.(?:pptx|docx|xlsx)\b/i.test(input)) {
    hints.push("处理 Office 文件时优先使用 python-pptx、python-docx、openpyxl 等高层库（可用时），避免不必要地逐层分析 Open XML；优先完成产物并做最小必要验证。");
  }
  if (/\.(?:pdf|png|jpe?g|csv|tsv)\b|(?:数据分析|图表|可视化|PDF)/i.test(input)) {
    hints.push("环境已预装 pandas、numpy、matplotlib、Pillow、pypdf、reportlab 和 BeautifulSoup，可直接用于数据分析、图表、图片、PDF 与 HTML 处理；完成后应重新打开产物做基本完整性校验。");
  }
  if (/(?:最新|近期).*(?:资讯|新闻|动态)|(?:资讯|新闻|动态).*(?:收集|检索|调研)/u.test(input)) {
    hints.push(`可使用随网关提供的免密新闻检索助手获取带日期和链接的结果：python "${NEWS_HELPER}" "检索关键词" --limit 12。先检索再形成报告，必须区分来源事实与分析。`);
  }
  return hints.length ? `${input}\n\n运行环境提示：${hints.join(" ")}` : input;
}

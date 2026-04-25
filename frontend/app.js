const form = document.getElementById("planner-form");
const sampleBtn = document.getElementById("sample-btn");
const exportMdBtn = document.getElementById("export-md-btn");
const exportPdfBtn = document.getElementById("export-pdf-btn");
const copyResultBtn = document.getElementById("copy-result-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const meetingPlanEl = document.getElementById("meeting-plan");
const agentStreamEl = document.getElementById("agent-stream");
const finalPlanEl = document.getElementById("final-plan");
const statusBadge = document.getElementById("status-badge");
const historyListEl = document.getElementById("history-list");
const liveSpeakerNameEl = document.getElementById("live-speaker-name");
const liveSpeakerRoleEl = document.getElementById("live-speaker-role");
const liveSpeechEl = document.getElementById("live-speech");
const liveAttitudeEl = document.getElementById("live-attitude");
const liveSpeakerCoreEl = document.getElementById("live-speaker-core");
const resolutionListEl = document.getElementById("resolution-list");
const stageNodes = [...document.querySelectorAll(".stage-node")];
const avatarCards = [...document.querySelectorAll(".avatar-card")];
const HISTORY_KEY = "autogen_activity_history_v1";

let lastResult = null;
let activeRunController = null;

function setStatus(kind, text) {
  statusBadge.className = `status ${kind}`;
  statusBadge.textContent = text;
}

function activateStage(index, doneBefore = false) {
  stageNodes.forEach((node, i) => {
    node.classList.remove("active", "done");
    if (doneBefore && i < index) node.classList.add("done");
    if (i === index) node.classList.add("active");
  });
}

function completeStages() {
  stageNodes.forEach((node) => {
    node.classList.remove("active");
    node.classList.add("done");
  });
}

function setActiveAgent(name) {
  avatarCards.forEach((card) => {
    card.classList.toggle("active", card.dataset.agent === name);
    card.classList.toggle("speaking", card.dataset.agent === name);
  });
}

const AGENT_META = {
  meeting_planner_agent: { label: "会议策划", role: "筹备会议题设计", attitude: "结构化拆解", color: "cyan" },
  creative_agent: { label: "总策划", role: "主题与亮点", attitude: "强势创意", color: "blue" },
  operations_agent: { label: "执行统筹", role: "流程与排期", attitude: "务实压缩", color: "purple" },
  publicity_agent: { label: "宣传传播", role: "触达与转化", attitude: "传播驱动", color: "pink" },
  risk_agent: { label: "预算风险", role: "成本与预案", attitude: "风险预警", color: "amber" },
  moderator_agent: { label: "主持收敛", role: "总结与定稿", attitude: "推动决策", color: "green" },
  activity_synthesizer_agent: { label: "策划汇总", role: "最终策划书", attitude: "整合输出", color: "white" },
};

function setLiveSpeaker(name, speech = "") {
  const meta = AGENT_META[name] || { label: name || "系统待命", role: "等待 Agent 发言", attitude: "待命", color: "cyan" };
  liveSpeakerNameEl.textContent = meta.label;
  liveSpeakerRoleEl.textContent = meta.role;
  liveAttitudeEl.textContent = meta.attitude;
  liveSpeakerCoreEl.className = `speaker-core ${meta.color}`;
  if (speech) {
    typeSpeechBubble(speech);
  }
}

function typeSpeechBubble(text, speed = 12) {
  let index = 0;
  const tick = () => {
    index = Math.min(text.length, index + speed);
    liveSpeechEl.textContent = text.slice(0, index);
    if (index < text.length) requestAnimationFrame(tick);
  };
  tick();
}

function splitLines(text) {
  return text.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

function buildPayload() {
  const data = new FormData(form);
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    base_url: "https://api.deepseek.com",
    discussion_turns: Number(data.get("discussion_turns") || 10),
    input: {
      task_type: "activity",
      theme: String(data.get("theme") || "").trim(),
      goal: String(data.get("goal") || "").trim(),
      target_audience: splitLines(String(data.get("target_audience") || "")),
      scale: String(data.get("scale") || "").trim(),
      duration_minutes: Number(data.get("duration_minutes") || 0) || null,
      venue: String(data.get("venue") || "").trim(),
      budget: String(data.get("budget") || "").trim(),
      background: String(data.get("background") || "").trim(),
      constraints: splitLines(String(data.get("constraints") || "")),
      expected_outputs: splitLines(String(data.get("expected_outputs") || "")),
      participants: splitLines(String(data.get("participants") || "")),
      notes: String(data.get("notes") || "").trim(),
    },
  };
}

function fillForm(sample) {
  form.theme.value = sample.theme || sample.topic || "";
  form.goal.value = sample.goal || "";
  form.target_audience.value = (sample.target_audience || []).join("\n");
  form.scale.value = sample.scale || "";
  form.duration_minutes.value = sample.duration_minutes || "";
  form.venue.value = sample.venue || "";
  form.budget.value = sample.budget || "";
  form.background.value = sample.background || "";
  form.constraints.value = (sample.constraints || []).join("\n");
  form.expected_outputs.value = (sample.expected_outputs || []).join("\n");
  form.participants.value = (sample.participants || []).join("\n");
  form.notes.value = sample.notes || "";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function applyInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdown(markdown) {
  if (!markdown) return '<div class="empty-state">暂无内容。</div>';
  const lines = markdown.replace(/\r/g, "").split("\n");
  let html = "";
  let inList = false;
  let inCode = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      closeList();
      closeTable();
      if (!inCode) {
        html += "<pre><code>";
        inCode = true;
      } else {
        html += "</code></pre>";
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      html += `${escapeHtml(line)}\n`;
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }
    if (/^\|(.+)\|$/.test(line.trim())) {
      closeList();
      const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
      const nextLine = lines[i + 1]?.trim() || "";
      const isHeader = /^\|?[\s:-]+\|[\s|:-]*$/.test(nextLine);
      if (!inTable) {
        html += "<table>";
      }
      if (isHeader) {
        html += "<thead><tr>" + cells.map((cell) => `<th>${applyInlineMarkdown(cell)}</th>`).join("") + "</tr></thead><tbody>";
        inTable = true;
        i += 1;
      } else {
        if (!inTable) html += "<tbody>";
        inTable = true;
        html += "<tr>" + cells.map((cell) => `<td>${applyInlineMarkdown(cell)}</td>`).join("") + "</tr>";
      }
      continue;
    }
    closeTable();
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      html += `<h${level}>${applyInlineMarkdown(line.slice(level).trim())}</h${level}>`;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${applyInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${applyInlineMarkdown(line)}</p>`;
  }
  closeList();
  closeTable();
  if (inCode) html += "</code></pre>";
  return `<div class="md">${html}</div>`;
}

function renderMarkdownTarget(el, markdown) {
  el.innerHTML = renderMarkdown(markdown);
}

function appendAgentMessage(message) {
  if (agentStreamEl.classList.contains("empty-state")) {
    agentStreamEl.classList.remove("empty-state");
    agentStreamEl.innerHTML = "";
  }
  const node = document.createElement("article");
  node.className = "agent-card";
  node.innerHTML = `
    <div class="agent-head">
      <div class="agent-avatar">${escapeHtml((message.source || "AG").slice(0, 2).toUpperCase())}</div>
      <div>
        <div class="agent-name">${escapeHtml(message.source || "unknown")}</div>
        <div class="agent-type">${escapeHtml(message.type || "message")}</div>
      </div>
    </div>
    <div class="agent-content">${escapeHtml(message.content || "")}</div>
  `;
  agentStreamEl.appendChild(node);
  agentStreamEl.scrollTop = agentStreamEl.scrollHeight;
}

function appendResolutionCards(cards) {
  if (!cards?.length) return;
  if (resolutionListEl.classList.contains("empty-state")) {
    resolutionListEl.classList.remove("empty-state");
    resolutionListEl.innerHTML = "";
  }
  cards.forEach((card) => {
    const node = document.createElement("article");
    node.className = "resolution-card";
    node.innerHTML = `
      <h4>${escapeHtml(card.topic || "阶段性决议")}</h4>
      <div class="resolution-row"><span>结论：</span>${escapeHtml(card.decision || "")}</div>
      <div class="resolution-row"><span>原因：</span>${escapeHtml(card.reason || "")}</div>
      <div class="resolution-row"><span>执行人：</span>${escapeHtml(card.owner || "")}</div>
      <div class="resolution-row"><span>待确认：</span>${escapeHtml(card.pending || "")}</div>
    `;
    resolutionListEl.appendChild(node);
  });
}

function typeIntoMarkdown(el, markdown, speed = 8) {
  return new Promise((resolve) => {
    let index = 0;
    const chunk = () => {
      index = Math.min(markdown.length, index + speed);
      renderMarkdownTarget(el, markdown.slice(0, index));
      if (index < markdown.length) {
        requestAnimationFrame(chunk);
      } else {
        resolve();
      }
    };
    chunk();
  });
}

async function loadSample() {
  const response = await fetch("/api/sample");
  const sample = await response.json();
  fillForm(sample);
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistoryItem(result) {
  const history = getHistory();
  history.unshift({
    id: `${Date.now()}`,
    theme: result.input?.theme || result.input?.topic || "未命名任务",
    goal: result.input?.goal || "",
    created_at: new Date().toLocaleString(),
    result,
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  if (!history.length) {
    historyListEl.innerHTML = '<div class="empty-state">暂无历史记录。</div>';
    return;
  }
  historyListEl.innerHTML = history
    .map(
      (item) => `
      <article class="history-item" data-id="${item.id}">
        <strong>${escapeHtml(item.theme)}</strong>
        <span>${escapeHtml(item.created_at)}</span>
        <span>${escapeHtml(item.goal)}</span>
      </article>
    `
    )
    .join("");

  [...historyListEl.querySelectorAll(".history-item")].forEach((node) => {
    node.addEventListener("click", () => {
      const selected = getHistory().find((item) => item.id === node.dataset.id);
      if (!selected) return;
      lastResult = selected.result;
      fillForm(selected.result.input || {});
      renderMarkdownTarget(meetingPlanEl, selected.result.meeting_plan || "");
      agentStreamEl.innerHTML = "";
      (selected.result.discussion_messages || []).forEach(appendAgentMessage);
      resolutionListEl.innerHTML = "";
      resolutionListEl.classList.add("empty-state");
      appendResolutionCards(selected.result.resolution_cards || []);
      renderMarkdownTarget(finalPlanEl, selected.result.final_output || "");
      setLiveSpeaker("activity_synthesizer_agent", selected.result.final_output || "");
      setStatus("done", "历史记录");
      completeStages();
    });
  });
}

async function* streamGenerate(payload) {
  if (activeRunController) activeRunController.abort();
  activeRunController = new AbortController();
  const response = await fetch("/api/generate-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: activeRunController.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || "流式请求失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      if (!part.trim()) continue;
      yield JSON.parse(part);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

function resetPanels() {
  meetingPlanEl.className = "markdown-box empty-state";
  finalPlanEl.className = "markdown-box empty-state";
  agentStreamEl.className = "agent-stream empty-state";
  meetingPlanEl.innerHTML = "正在生成筹备会议方案...";
  finalPlanEl.innerHTML = "等待最终策划书...";
  agentStreamEl.innerHTML = "等待 Agent 发言...";
  resolutionListEl.className = "resolution-list empty-state";
  resolutionListEl.innerHTML = "moderator 输出决议卡后，这里会出现阶段性结论。";
  setLiveSpeaker("meeting_planner_agent", "正在准备筹备会议方案...");
}

async function handleRun(payload) {
  resetPanels();
  setStatus("running", "运行中");
  activateStage(0);
  setActiveAgent("meeting_planner_agent");
  setLiveSpeaker("meeting_planner_agent", "正在准备筹备会议方案...");

  let completedResult = null;

  for await (const event of streamGenerate(payload)) {
    if (event.type === "status") {
      activateStage(Math.max(0, (event.stage || 1) - 1), true);
      if (event.stage === 1) {
        setActiveAgent("meeting_planner_agent");
        setLiveSpeaker("meeting_planner_agent", event.message || "正在生成筹备会议方案");
      }
      if (event.stage === 2) {
        setActiveAgent("creative_agent");
        setLiveSpeaker("creative_agent", event.message || "多 Agent 正在开会讨论");
      }
      if (event.stage === 3) {
        setActiveAgent("activity_synthesizer_agent");
        setLiveSpeaker("activity_synthesizer_agent", event.message || "正在汇总活动策划书");
      }
      continue;
    }
    if (event.type === "stage_result" && event.stage === 1) {
      meetingPlanEl.classList.remove("empty-state");
      await typeIntoMarkdown(meetingPlanEl, event.content || "", 18);
      activateStage(1, true);
      setLiveSpeaker("meeting_planner_agent", event.content || "");
      continue;
    }
    if (event.type === "discussion_message") {
      agentStreamEl.classList.remove("empty-state");
      appendAgentMessage(event.message);
      setActiveAgent(event.message.source);
      setLiveSpeaker(event.message.source, event.message.content || "");
      activateStage(1, true);
      continue;
    }
    if (event.type === "moderator_resolution") {
      appendResolutionCards(event.cards || []);
      continue;
    }
    if (event.type === "stage_result" && event.stage === 3) {
      finalPlanEl.classList.remove("empty-state");
      activateStage(2, true);
      setActiveAgent("activity_synthesizer_agent");
      setLiveSpeaker("activity_synthesizer_agent", event.content || "");
      await typeIntoMarkdown(finalPlanEl, event.content || "", 16);
      continue;
    }
    if (event.type === "completed") {
      completedResult = event.result;
      lastResult = event.result;
      saveHistoryItem(event.result);
      completeStages();
      setStatus("done", "已完成");
      setActiveAgent("");
      setLiveSpeaker("activity_synthesizer_agent", event.result?.final_output || "");
      continue;
    }
    if (event.type === "error") {
      throw new Error(event.detail || "生成失败");
    }
  }

  return completedResult;
}

function exportMarkdown() {
  if (!lastResult) return;
  const content = `# 活动策划输出\n\n## 筹备会议方案\n\n${lastResult.meeting_plan || ""}\n\n## 多 Agent 讨论\n\n${lastResult.discussion_transcript || ""}\n\n## 最终活动策划书\n\n${lastResult.final_output || ""}\n`;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${lastResult.input?.theme || "activity_plan"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPdf() {
  window.print();
}

function setupCanvas() {
  const canvas = document.getElementById("starfield");
  const ctx = canvas.getContext("2d");
  let stars = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    stars = Array.from({ length: Math.min(120, Math.floor(window.innerWidth / 14)) }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.4 + 0.2,
      v: Math.random() * 0.2 + 0.05,
    }));
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const star of stars) {
      star.y += star.v;
      if (star.y > canvas.height) {
        star.y = -10;
        star.x = Math.random() * canvas.width;
      }
      ctx.beginPath();
      ctx.fillStyle = "rgba(180,220,255,0.8)";
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  resize();
  tick();
  window.addEventListener("resize", resize);
}

sampleBtn.addEventListener("click", async () => {
  sampleBtn.disabled = true;
  sampleBtn.textContent = "载入中...";
  try {
    await loadSample();
  } finally {
    sampleBtn.disabled = false;
    sampleBtn.textContent = "载入示例";
  }
});

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

copyResultBtn.addEventListener("click", async () => {
  if (!lastResult?.final_output) return;
  await navigator.clipboard.writeText(lastResult.final_output);
  copyResultBtn.textContent = "已复制";
  setTimeout(() => {
    copyResultBtn.textContent = "复制";
  }, 1200);
});

exportMdBtn.addEventListener("click", exportMarkdown);
exportPdfBtn.addEventListener("click", exportPdf);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await handleRun(buildPayload());
  } catch (error) {
    setStatus("error", "失败");
    setActiveAgent("");
    meetingPlanEl.innerHTML = `<div class="empty-state">生成失败：${escapeHtml(error.message)}</div>`;
    finalPlanEl.innerHTML = '<div class="empty-state">未生成结果。</div>';
  }
});

loadSample();
renderHistory();
setupCanvas();

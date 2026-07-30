// DocuMind AI — frontend logic
// Handles PDF upload, streaming chat (SSE), summary / key-point tools,
// theme toggle, and simple chat history.

const API_BASE = ""; // same-origin; backend serves this frontend too

let docId = null;
let chatHistory = []; // [{role, content}]
let lastSummaryText = "";

// ---------- Elements ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const docInfo = document.getElementById("docInfo");
const docName = document.getElementById("docName");
const docMeta = document.getElementById("docMeta");
const uploadStatus = document.getElementById("uploadStatus");

const btnSummary = document.getElementById("btnSummary");
const btnKeypoints = document.getElementById("btnKeypoints");
const btnDownload = document.getElementById("btnDownload");

const outputPanel = document.getElementById("outputPanel");
const outputTitle = document.getElementById("outputTitle");
const outputBody = document.getElementById("outputBody");
const closeOutput = document.getElementById("closeOutput");

const chatScroll = document.getElementById("chatScroll");
const emptyState = document.getElementById("emptyState");
const composer = document.getElementById("composer");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");

const themeToggle = document.getElementById("themeToggle");
const themeLabel = document.getElementById("themeLabel");

// ---------- Theme ----------
themeToggle.addEventListener("click", () => {
  const body = document.body;
  const next = body.dataset.theme === "dark" ? "light" : "dark";
  body.dataset.theme = next;
  themeLabel.textContent = next === "dark" ? "Dark" : "Light";
});

// ---------- Upload ----------
dropzone.addEventListener("click", (e) => {
  // label already triggers input via `for`, avoid double-trigger
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) {
    handleFile(e.dataTransfer.files[0]);
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("Please upload a PDF file.", "error");
    return;
  }
  setStatus("Uploading and parsing…");
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch(`${API_BASE}/api/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Upload failed");

    docId = data.doc_id;
    docName.textContent = data.filename;
    docMeta.textContent = `${data.page_count} page${data.page_count === 1 ? "" : "s"}`;
    docInfo.classList.remove("hidden");
    setStatus("Ready to chat.", "success");

    [btnSummary, btnKeypoints, questionInput, sendBtn].forEach((el) => (el.disabled = false));
    questionInput.placeholder = "Ask a question about this document…";

    chatHistory = [];
    chatScroll.innerHTML = "";
    resetEmptyState(`Loaded "${data.filename}" — ask away.`);
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function setStatus(text, kind) {
  uploadStatus.textContent = text;
  uploadStatus.className = "status-line" + (kind ? ` ${kind}` : "");
}

function resetEmptyState(subtitle) {
  chatScroll.innerHTML = `
    <div class="empty-state" id="emptyState">
      <div class="empty-mark">§</div>
      <h1>Ask your document anything</h1>
      <p>${subtitle}</p>
    </div>`;
}

// ---------- Chat ----------
composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question || !docId) return;

  clearEmptyStateIfPresent();
  addMessage("user", question);
  chatHistory.push({ role: "user", content: question });
  questionInput.value = "";
  sendBtn.disabled = true;

  const assistantBubble = addMessage("assistant", "");
  let fullText = "";

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_id: docId, question, history: chatHistory.slice(0, -1) }),
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop(); // keep incomplete chunk

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.delta) {
          fullText += payload.delta;
          renderAssistantText(assistantBubble, fullText);
          chatScroll.scrollTop = chatScroll.scrollHeight;
        } else if (payload.error) {
          fullText += `\n\n[Error: ${payload.error}]`;
          renderAssistantText(assistantBubble, fullText);
        }
      }
    }

    chatHistory.push({ role: "assistant", content: fullText });
  } catch (err) {
    renderAssistantText(assistantBubble, `Sorry, something went wrong: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
});

function clearEmptyStateIfPresent() {
  const el = document.getElementById("emptyState");
  if (el) chatScroll.innerHTML = "";
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "DocuMind AI";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return bubble;
}

// Highlights "(p. N)" citations as flag chips
function renderAssistantText(bubbleEl, text) {
  bubbleEl.innerHTML = "";
  const parts = text.split(/(\(p\.\s?\d+(?:[-,]\s?\d+)*\))/g);
  parts.forEach((part) => {
    if (/^\(p\.\s?\d+/.test(part)) {
      const flag = document.createElement("span");
      flag.className = "cite-flag";
      flag.textContent = part;
      bubbleEl.appendChild(flag);
    } else {
      bubbleEl.appendChild(document.createTextNode(part));
    }
  });
}

// ---------- Tools: summary / key points ----------
btnSummary.addEventListener("click", () => runTool("summary"));
btnKeypoints.addEventListener("click", () => runTool("keypoints"));
closeOutput.addEventListener("click", () => outputPanel.classList.add("hidden"));

async function runTool(kind) {
  if (!docId) return;
  const endpoint = kind === "summary" ? "/api/summary" : "/api/keypoints";
  const title = kind === "summary" ? "Chapter-wise Summary" : "Key Points";

  outputTitle.textContent = title;
  outputBody.textContent = "Generating…";
  outputPanel.classList.remove("hidden");

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_id: docId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Request failed");

    const text = data.summary || data.key_points;
    outputBody.textContent = text;
    if (kind === "summary") {
      lastSummaryText = text;
      btnDownload.disabled = false;
    }
  } catch (err) {
    outputBody.textContent = `Error: ${err.message}`;
  }
}

// ---------- Download summary as a text-based "PDF" (simple print) ----------
btnDownload.addEventListener("click", () => {
  if (!lastSummaryText) return;
  const win = window.open("", "_blank");
  win.document.write(`
    <html><head><title>Summary</title></head>
    <body style="font-family: Georgia, serif; padding: 40px; white-space: pre-wrap; line-height:1.6;">
      <h1>DocuMind AI — Document Summary</h1>
      ${lastSummaryText.replace(/\n/g, "<br>")}
    </body></html>
  `);
  win.document.close();
  win.print();
});

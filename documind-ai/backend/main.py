"""
DocuMind AI - Intelligent PDF Chat Assistant
FastAPI backend that handles PDF upload/parsing, Claude API chat with
streaming responses, chapter-wise summaries, and key-point extraction.
"""

import os
import io
import uuid
import json
import logging
from typing import Dict, List, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import pdfplumber
import anthropic

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("documind")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL_NAME = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
MAX_CONTEXT_CHARS = 180_000  # keep prompt within a safe token budget

if not ANTHROPIC_API_KEY:
    logger.warning("ANTHROPIC_API_KEY is not set. Set it as an environment variable.")

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

app = FastAPI(title="DocuMind AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this to your frontend domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory document store
# NOTE: For production, replace with Redis / DynamoDB / a database.
# Data does not persist across container restarts or multiple instances.
# ---------------------------------------------------------------------------
DOCUMENTS: Dict[str, dict] = {}


class ChatRequest(BaseModel):
    doc_id: str
    question: str
    history: Optional[List[dict]] = None


class SummaryRequest(BaseModel):
    doc_id: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def extract_pdf_pages(file_bytes: bytes) -> List[dict]:
    """Extract text per page from a PDF. Returns list of {page, text}."""
    pages = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            pages.append({"page": i, "text": text})
    return pages


def build_context(pages: List[dict], max_chars: int = MAX_CONTEXT_CHARS) -> str:
    """Join pages into a single context string with page markers, capped in length."""
    chunks = []
    total = 0
    for p in pages:
        marker = f"\n\n[PAGE {p['page']}]\n{p['text']}"
        if total + len(marker) > max_chars:
            chunks.append("\n\n[... document truncated due to length ...]")
            break
        chunks.append(marker)
        total += len(marker)
    return "".join(chunks)


def get_document_or_404(doc_id: str) -> dict:
    doc = DOCUMENTS.get(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found. Please upload again.")
    return doc


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if file.content_type != "application/pdf" and not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()
    if len(file_bytes) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 25MB).")

    try:
        pages = extract_pdf_pages(file_bytes)
    except Exception as e:
        logger.exception("Failed to parse PDF")
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {e}")

    if not any(p["text"].strip() for p in pages):
        raise HTTPException(
            status_code=400,
            detail="No extractable text found. The PDF may be scanned/image-only.",
        )

    doc_id = str(uuid.uuid4())
    DOCUMENTS[doc_id] = {
        "filename": file.filename,
        "pages": pages,
        "page_count": len(pages),
    }

    preview = " ".join(p["text"] for p in pages[:1])[:500]

    return {
        "doc_id": doc_id,
        "filename": file.filename,
        "page_count": len(pages),
        "preview": preview,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    doc = get_document_or_404(req.doc_id)
    context = build_context(doc["pages"])

    system_prompt = (
        "You are DocuMind AI, an assistant that answers questions strictly using the "
        "content of the provided document. Always cite the page number(s) your answer "
        "comes from, in the form (p. X). If the answer is not in the document, say so "
        "clearly instead of guessing.\n\n"
        f"DOCUMENT (filename: {doc['filename']}):\n{context}"
    )

    messages = []
    if req.history:
        for turn in req.history[-10:]:  # keep last 10 turns for context
            role = turn.get("role")
            content = turn.get("content")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": req.question})

    def event_stream():
        try:
            with client.messages.stream(
                model=MODEL_NAME,
                max_tokens=1024,
                system=system_prompt,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'delta': text})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            logger.exception("Streaming error")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/summary")
async def summary(req: SummaryRequest):
    doc = get_document_or_404(req.doc_id)
    context = build_context(doc["pages"])

    prompt = (
        "Produce a clear chapter-wise / section-wise summary of the following document. "
        "Use headings for each section or chapter you identify, and note the page range "
        "for each in parentheses. Keep each section summary to 3-5 sentences.\n\n"
        f"DOCUMENT:\n{context}"
    )

    try:
        response = client.messages.create(
            model=MODEL_NAME,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if block.type == "text")
        return {"summary": text}
    except Exception as e:
        logger.exception("Summary generation failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/keypoints")
async def keypoints(req: SummaryRequest):
    doc = get_document_or_404(req.doc_id)
    context = build_context(doc["pages"])

    prompt = (
        "Extract the key points from the following document as a concise bulleted list "
        "(max 12 bullets). Each bullet should include the page number it came from in "
        "parentheses.\n\n"
        f"DOCUMENT:\n{context}"
    )

    try:
        response = client.messages.create(
            model=MODEL_NAME,
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if block.type == "text")
        return {"key_points": text}
    except Exception as e:
        logger.exception("Key point extraction failed")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Serve frontend static files (mounted last so /api routes take priority)
# ---------------------------------------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

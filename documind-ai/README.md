# DocuMind AI — Intelligent PDF Chat Assistant

Upload a PDF, chat with it in natural language, and get chapter-wise
summaries and key points — with page-number citations on every answer.

## Tech Stack
- **Frontend:** HTML / CSS / vanilla JavaScript, streamed responses via Server-Sent Events
- **Backend:** Python FastAPI
- **LLM:** Anthropic Claude API (streaming)
- **PDF parsing:** pdfplumber
- **Containerization:** Docker
- **Deployment:** AWS App Runner (or Elastic Beanstalk)

## 1. Run locally

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # then edit .env and add your real API key
export $(cat .env | xargs)      # or use python-dotenv / your shell's env loader

uvicorn main:app --reload --port 8000
```

Open `http://localhost:8000` — the backend also serves the frontend.

## 2. Run with Docker

```bash
docker build -t documind-ai .
docker run -p 8000:8000 -e ANTHROPIC_API_KEY=your_key_here documind-ai
```

Open `http://localhost:8000`.

## 3. Deploy to AWS App Runner

1. **Push the image to Amazon ECR:**
   ```bash
   aws ecr create-repository --repository-name documind-ai
   aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account_id>.dkr.ecr.<region>.amazonaws.com

   docker build -t documind-ai .
   docker tag documind-ai:latest <account_id>.dkr.ecr.<region>.amazonaws.com/documind-ai:latest
   docker push <account_id>.dkr.ecr.<region>.amazonaws.com/documind-ai:latest
   ```

2. **Create an App Runner service:**
   - AWS Console → App Runner → Create service
   - Source: Container registry → Amazon ECR → select the `documind-ai` image
   - Deployment trigger: Manual (or automatic on new image push)
   - Port: `8000`
   - Environment variables: add `ANTHROPIC_API_KEY` (mark as a secret) and `ANTHROPIC_MODEL`
   - Instance size: 1 vCPU / 2 GB is sufficient for demo traffic (stay within free-tier-eligible sizing where possible)
   - Auto scaling: min 1, max 2 (keep costs low)

3. **Deploy** and grab the public HTTPS URL App Runner generates — that's your live application URL for submission.

4. **Cost control:** set an AWS Budget alert (Billing → Budgets → Create budget) for a low threshold (e.g., $5) so you're notified before any unexpected charges.

### Alternative: Elastic Beanstalk (Docker platform)
```bash
eb init -p docker documind-ai
eb create documind-ai-env
eb setenv ANTHROPIC_API_KEY=your_key_here ANTHROPIC_MODEL=claude-sonnet-5
eb open
```

## Security notes
- API keys are read only from environment variables (`ANTHROPIC_API_KEY`) — never hardcoded, never in frontend code, never committed (`.env` is gitignored).
- CORS is wide open (`*`) for demo purposes; restrict `allow_origins` to your actual frontend domain before considering this production-ready.
- The document store is in-memory (`DOCUMENTS` dict) — fine for a course project demo, but documents are lost on container restart and won't be shared across multiple App Runner instances. For production, swap in Redis or DynamoDB.

## API Endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload a PDF, returns `doc_id` |
| POST | `/api/chat` | Streaming chat (SSE) grounded in the document |
| POST | `/api/summary` | Chapter-wise summary |
| POST | `/api/keypoints` | Bulleted key points with page refs |
| GET | `/api/health` | Health check |

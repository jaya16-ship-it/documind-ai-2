# DocuMind AI — single-container image (FastAPI backend + static frontend)
FROM python:3.11-slim

WORKDIR /app

# Install backend dependencies first (better layer caching)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy application code
COPY backend ./backend
COPY frontend ./frontend

ENV PORT=8000
EXPOSE 8000

# ANTHROPIC_API_KEY must be provided at runtime via environment variable
# (App Runner / Elastic Beanstalk environment configuration), never baked
# into the image.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]

# 🎬 Multimodal Video & Audio Intelligence System

A local-cloud hybrid **VideoRAG** engine that lets you upload a video, audio file, or YouTube URL and ask natural language questions about its content. It combines on-device transcription (Faster-Whisper), concurrent visual analysis (Gemini Vision), and a local FAISS vector index for fast retrieval — with the Gemini API powering the final reasoning step.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                │
│  Video / Audio / YouTube URL  →  Chat Interface      │
└────────────────────┬────────────────────────────────┘
                     │ REST API
┌────────────────────▼────────────────────────────────┐
│                 Backend (FastAPI)                    │
│                                                     │
│  ┌────────────────────────────────────────────┐     │
│  │            AI Pipeline                     │     │
│  │                                            │     │
│  │  FFmpeg → 15s uniform chunks               │     │
│  │  Faster-Whisper (tiny, CPU) → transcripts  │     │
│  │  Gemini Vision (parallel) → frame captions │     │
│  │  Gemini Embeddings → 3072-dim vectors      │     │
│  │  FAISS IndexFlatL2 → local vector store    │     │
│  │  Gemini Flash → final answer synthesis     │     │
│  └────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **Uniform 15s chunking** instead of scene detection — eliminates PySceneDetect overhead and keeps processing predictable
- **Concurrent Gemini vision calls** (batches of 5) — parallel frame descriptions cut processing time significantly
- **FAISS stored in memory** per session — no external vector database needed; zero extra infra
- **Automatic 503 failover** — if the primary Gemini model is overloaded, the pipeline transparently retries on the lighter flash-lite endpoint

---

## Project Structure

```
video_rag_system/
├── backend/
│   ├── .venv/                  # Python virtual environment
│   ├── uploads/                # Temp storage for uploaded files (auto-cleaned on startup)
│   ├── .env                    # API keys (GEMINI_API_KEY)
│   ├── .gitignore
│   ├── ai_pipeline.py          # Core RAG engine: chunking, transcription, FAISS indexing, querying
│   ├── main.py                 # FastAPI app: upload/ingest/status/query endpoints
│   ├── requirements.txt        # Python dependencies
│   ├── run.sh                  # Start script (activates venv + uvicorn)
│   ├── test_models.py          # Utility to verify Gemini model availability
│   └── yolo11n.pt              # YOLOv11 nano weights (optional object detection)
├── frontend/
│   ├── app/
│   │   ├── globals.css         # Tailwind base + CSS variable theme
│   │   ├── layout.tsx          # Root layout
│   │   └── page.tsx            # Main chat UI (single-page)
│   ├── lib/
│   │   └── api.ts              # API client functions
│   ├── next.config.js
│   ├── package.json
│   ├── tailwind.config.js
│   └── tsconfig.json
├── README.md
└── setup.sh                    # One-time environment bootstrap script
```

---

## Prerequisites

| Dependency | Purpose |
|---|---|
| Python 3.10+ | Backend runtime |
| Node.js 18+ | Frontend runtime |
| FFmpeg | Video/audio processing (chunking, frame extraction, audio extraction) |
| Google Gemini API Key | Vision, embeddings, and text generation |

Install FFmpeg on macOS:
```bash
brew install ffmpeg
```

---

## Setup

### 1. Clone & bootstrap (first time)

```bash
git clone https://github.com/sujalpapalkar/video_rag_system.git
cd video_rag_system
chmod +x setup.sh && ./setup.sh
```

### 2. Configure environment

```bash
cd backend
cp .env.example .env   # if provided, otherwise create it
```

Edit `backend/.env`:
```env
GEMINI_API_KEY=your_google_gemini_api_key_here
```

### 3. Start the backend

```bash
cd backend
./run.sh
```

The `run.sh` script activates the virtual environment and starts uvicorn with hot-reload:

```bash
#!/bin/bash
cd "$(dirname "$0")"
source .venv/bin/activate
uvicorn main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --reload \
  --reload-exclude '.venv' \
  --reload-exclude 'uploads' \
  --reload-exclude '__pycache__'
```

Backend will be available at `http://localhost:8000`.

### 4. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend will be available at `http://localhost:3000`.

---

## Manual Backend Setup (without setup.sh)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\activate           # Windows

pip install -r requirements.txt

# macOS: fix OpenMP conflict between faster-whisper and FAISS
export KMP_DUPLICATE_LIB_OK=TRUE   # already set in main.py automatically
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/upload/video` | Upload a video file (multipart) |
| `POST` | `/upload/audio` | Upload an audio file (multipart) |
| `POST` | `/ingest/youtube` | Ingest a YouTube URL `{ "url": "..." }` |
| `GET` | `/status/{session_id}` | Poll processing progress |
| `POST` | `/query` | Ask a question `{ "session_id": "...", "question": "..." }` |

### Example flow

```bash
# Upload a video
curl -X POST http://localhost:8000/upload/video \
  -F "file=@my_video.mp4"
# → { "session_id": "abc123..." }

# Poll until ready
curl http://localhost:8000/status/abc123
# → { "status": "ready", "progress": 100, "message": "Ready" }

# Ask a question
curl -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{ "session_id": "abc123", "question": "What happens at the beginning?" }'
# → { "answer": "...", "timestamps": [...], "sources": [...] }
```

---

## How It Works

### Ingestion pipeline

1. **Probe** — FFprobe detects video duration
2. **Chunk** — Video is divided into 15-second uniform segments
3. **Transcribe** — Faster-Whisper (tiny, CPU, int8) transcribes the full audio track; segments are mapped to their time ranges
4. **Visual analysis** — FFmpeg extracts a frame from the midpoint of each chunk; Gemini Vision describes each frame concurrently in batches of 5
5. **Combine** — Each chunk becomes: `[Audio Transcript]: ... [Visual Frame Analysis]: ...`
6. **Embed** — `gemini-embedding-001` converts each combined text into a 3072-dim vector
7. **Index** — Vectors are stored in a `faiss.IndexFlatL2` in memory, keyed to the session

### Query pipeline

1. Embed the user's question with `gemini-embedding-001`
2. FAISS top-3 similarity search over the session's index
3. Retrieved chunks (with timestamps) are formatted into a prompt
4. Gemini Flash generates a grounded answer, citing exact timecode ranges
5. If the primary model returns a 503, the pipeline automatically retries on `gemini-2.5-flash-lite`

---

## Models Used

| Role | Model |
|---|---|
| Frame description | `gemini-2.5-flash-lite` |
| Query reasoning | `gemini-2.5-flash` (with flash-lite failover) |
| Embeddings | `models/gemini-embedding-001` |
| Speech-to-text | `faster-whisper` (tiny, CPU, int8) |

---

## Frontend Features

- **Three input modes** — Video file, Audio file, YouTube URL
- **Live progress bar** — Polls `/status` every 1.5s during processing
- **Inline video player** — Seek directly to a timestamp by clicking the time chip in any answer
- **Quick question prompts** — Pre-built buttons for common queries once the session is ready
- **2-second cooldown** between queries to avoid rate limit bursts
- **Markdown cleanup** — Raw `**bold**` and `###` heading artifacts from the model response are stripped before display

---

## Notes

- The `uploads/` directory is wiped clean on every backend startup to reclaim disk space
- Sessions are stored in memory (`SESSION_STORE`) — they are lost when the server restarts
- The `KMP_DUPLICATE_LIB_OK=TRUE` env var is set automatically in `main.py` to prevent an OpenMP library conflict between FAISS and Faster-Whisper on macOS (Apple Silicon)
- YouTube ingestion requires `yt-dlp` to be installed (`pip install yt-dlp`)

---

## Tech Stack

**Backend** — Python, FastAPI, Faster-Whisper, FAISS, Google GenAI SDK, FFmpeg, yt-dlp, aiofiles

**Frontend** — Next.js 14, TypeScript, Tailwind CSS, Lucide Icons

**AI/ML** — Gemini 2.5 Flash (vision + text), Gemini Embedding 001, Faster-Whisper tiny


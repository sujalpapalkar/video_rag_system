"""
FastAPI backend for Multimodal Video & Audio Intelligence System.
Optimized Asynchronous Local-Cloud Hybrid VectorRAG Architecture.
"""

import os
# CRITICAL MACOS COMPATIBILITY INTERCEPT: Prevents OpenMP libomp.dylib collision 
# between local faster-whisper matrix loops and local FAISS vector spaces.
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import uuid
import asyncio
import logging
import shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import aiofiles

from ai_pipeline import process_video_to_local_faiss, query_cloud_session, SESSION_STORE

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

ml_executor = ThreadPoolExecutor(max_workers=1)

app = FastAPI(title="Optimized Local FAISS VideoRAG API", version="5.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class YoutubeRequest(BaseModel):
    url: str

class QueryRequest(BaseModel):
    session_id: str
    question: str

async def save_upload(file: UploadFile) -> Path:
    suffix = Path(file.filename or "upload").suffix or ""
    dest = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
    async with aiofiles.open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            await f.write(chunk)
    return dest

def new_session() -> str:
    sid = uuid.uuid4().hex
    SESSION_STORE[sid] = {"status": "uploading", "progress": 0, "message": "Uploading..."}
    return sid

@app.on_event("startup")
async def startup_cleanup():
    log.info("Flushing old residual workspace cache folders...")
    if UPLOAD_DIR.exists():
        for item in UPLOAD_DIR.iterdir():
            try:
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink()
            except Exception as e:
                log.warning(f"Could not clean residual item {item.name}: {e}")

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/upload/video")
async def upload_video(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("video"):
        raise HTTPException(400, "Expected a video file")
    path = await save_upload(file)
    sid = new_session()
    background_tasks.add_task(_run_video_pipeline, sid, path)
    return {"session_id": sid}

@app.post("/ingest/youtube")
async def ingest_youtube(body: YoutubeRequest, background_tasks: BackgroundTasks):
    sid = new_session()
    background_tasks.add_task(_run_youtube_pipeline, sid, body.url)
    return {"session_id": sid}

@app.get("/status/{session_id}")
async def get_status(session_id: str):
    entry = SESSION_STORE.get(session_id)
    if not entry:
        raise HTTPException(404, "Session tracker missing")
    return {
        "status": entry["status"],
        "progress": entry.get("progress", 0),
        "message": entry.get("message", ""),
    }

@app.post("/query")
async def query(body: QueryRequest):
    entry = SESSION_STORE.get(body.session_id)
    if not entry:
        raise HTTPException(404, "Session data node missing")
    if entry["status"] != "ready":
        raise HTTPException(400, f"Session context unready (status: {entry['status']})")
    
    result = await asyncio.get_event_loop().run_in_executor(
        None, query_cloud_session, body.session_id, body.question
    )
    return result

async def _run_video_pipeline(sid: str, path: Path):
    try:
        log.info(f"[{sid}] Starting local high-speed processing thread...")
        await asyncio.get_event_loop().run_in_executor(ml_executor, process_video_to_local_faiss, sid, str(path))
    except Exception as e:
        log.error(f"[{sid}] Video pipeline processing runtime layout exception: {e}", exc_info=True)
        SESSION_STORE[sid].update({"status": "error", "message": f"Pipeline failure: {str(e)}"})

async def _run_youtube_pipeline(sid: str, url: str):
    try:
        import yt_dlp
        dest = UPLOAD_DIR / f"{sid}_yt.mp4"
        
        ydl_opts = {
            "format": "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]/best",
            "outtmpl": str(dest),
            "merge_output_format": "mp4",
            "quiet": True,
            "no_warnings": True,
            "retries": 10,
            "fragment_retries": 10,
            "socket_timeout": 30
        }
        
        SESSION_STORE[sid].update({"message": "Downloading YouTube stream maps...", "progress": 10})
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(ml_executor, lambda: yt_dlp.YoutubeDL(ydl_opts).download([url]))
        
        SESSION_STORE[sid].update({"message": "Triggering high-speed vector segmentation...", "progress": 15})
        await loop.run_in_executor(ml_executor, process_video_to_local_faiss, sid, str(dest))
    except Exception as e:
        log.error(f"[{sid}] YouTube link track stream extraction error: {e}", exc_info=True)
        SESSION_STORE[sid].update({"status": "error", "message": f"YouTube ingestion failure: {str(e)}"})
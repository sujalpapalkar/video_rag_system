"""
AI Pipeline: Ultra-Optimized Local-Cloud Hybrid Text-Visual RAG Engine.
Uses uniform 15s chunking to skip PySceneDetect overhead, processes API calls
concurrently in parallel batches, and indexes data nodes inside a local FAISS DB.
Includes resilient automated fallback routing to bypass 503 high-demand server caps.
"""

import os
import time
import re
import logging
import subprocess
import asyncio
from pathlib import Path
from typing import Any
from dotenv import load_dotenv

import numpy as np
import faiss
from faster_whisper import WhisperModel

from google import genai
from google.genai import types

load_dotenv()
log = logging.getLogger(__name__)

if 'SESSION_STORE' not in globals():
    SESSION_STORE: dict[str, dict[str, Any]] = {}
else:
    SESSION_STORE = globals()['SESSION_STORE']

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# =====================================================================
# RESILIENT PRODUCTION MODEL ROUTING
# =====================================================================
CHUNK_MODEL = "gemini-2.5-flash-lite"   # Handles rapid parallel frame summaries
GEMINI_MODEL = "gemini-3.5-flash"      # Handles primary text query reasoning
EMBEDDING_MODEL = "models/gemini-embedding-001" # Target vector mapping path

log.info("Initializing Cloud GenAI client reference...")
genai_client = genai.Client(api_key=GEMINI_API_KEY)

log.info("Loading ultra-light local faster-whisper model (tiny)...")
whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")


async def describe_frame_async(image_bytes: bytes) -> str:
    """Helper worker to run Gemini visual descriptions concurrently."""
    try:
        image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None, 
            lambda: genai_client.models.generate_content(
                model=CHUNK_MODEL,
                contents=[image_part, "Describe what is happening in this frame concisely. Focus on people, clothing colors, and text layouts."]
            )
        )
        return response.text.strip() if response.text else ""
    except Exception as e:
        log.warning(f"Async frame parsing hitch: {e}")
        return "Visual context unavailable."


def process_video_to_local_faiss(sid: str, video_path: str):
    """
    Asynchronous orchestration block running optimized multi-threaded ingestion pipelines.
    """
    asyncio.run(_async_pipeline_orchestrator(sid, video_path))


async def _async_pipeline_orchestrator(sid: str, video_path: str):
    SESSION_STORE[sid].update({"status": "processing", "progress": 10, "message": "Analyzing media limits..."})
    
    cmd = [
        "ffprobe", "-v", "error", 
        "-show_entries", "format=duration", 
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path
    ]
    try:
        duration = float(subprocess.check_output(cmd).decode().strip().split()[0])
        log.info(f"[{sid}] Probe detected video duration: {duration} seconds.")
    except Exception as e:
        log.warning(f"Probe failed, using dynamic safety fallback: {e}")
        duration = 360.0
        
    chunk_size = 15.0
    chunks = []
    current_time = 0.0
    while current_time < duration:
        end_time = min(current_time + chunk_size, duration)
        chunks.append((current_time, end_time))
        current_time += chunk_size

    total_chunks = len(chunks)
    log.info(f"[{sid}] Segmented media into {total_chunks} blocks of 15s. Running concurrent processing...")

    compiled_scenes = []
    
    SESSION_STORE[sid].update({"progress": 25, "message": "Transcribing audio tracks..."})
    try:
        tmp_audio = f"uploads/{sid}_full.mp3"
        subprocess.run(["ffmpeg", "-y", "-i", video_path, "-q:a", "0", "-map", "a", tmp_audio, "-loglevel", "quiet"], check=True)
        segments, _ = whisper_model.transcribe(tmp_audio, beam_size=1)
        all_segments = list(segments)
        if os.path.exists(tmp_audio): os.unlink(tmp_audio)
    except Exception as e:
        log.warning(f"Audio transcription layer error: {e}")
        all_segments = []

    SESSION_STORE[sid].update({"progress": 45, "message": "Processing visual snapshots concurrently..."})
    
    frame_tasks = []
    frame_metadata_helpers = []

    for idx, (start_sec, end_sec) in enumerate(chunks):
        mid_sec = start_sec + (end_sec - start_sec) / 2
        tmp_frame = f"uploads/{sid}_f_{idx}.jpg"
        
        chunk_transcript = " ".join([
            seg.text for seg in all_segments 
            if start_sec <= seg.start <= end_sec
        ]).strip()

        try:
            subprocess.run([
                "ffmpeg", "-y", "-ss", str(mid_sec), "-i", video_path,
                "-frames:v", "1", "-q:v", "5", "-vf", "scale=320:-2", tmp_frame, "-loglevel", "quiet"
            ], check=True)
            
            if os.path.exists(tmp_frame):
                with open(tmp_frame, "rb") as f:
                    img_bytes = f.read()
                os.unlink(tmp_frame)
                
                frame_tasks.append(describe_frame_async(img_bytes))
                frame_metadata_helpers.append((start_sec, end_sec, chunk_transcript))
        except Exception as e:
            log.warning(f"Frame generation hitch on block {idx}: {e}")

    log.info(f"[{sid}] Launching {len(frame_tasks)} concurrent Gemini vision workers...")
    
    visual_summaries = []
    batch_size = 5
    for i in range(0, len(frame_tasks), batch_size):
        batch = frame_tasks[i:i+batch_size]
        summaries = await asyncio.gather(*batch)
        visual_summaries.extend(summaries)
        await asyncio.sleep(1.0)

    for idx, visual_desc in enumerate(visual_summaries):
        start_sec, end_sec, transcript = frame_metadata_helpers[idx]
        combined_text = f"[Audio Transcript]: {transcript or 'Silence.'} [Visual Frame Analysis]: {visual_desc}"
        
        compiled_scenes.append({
            "start_time": start_sec,
            "end_time": end_sec,
            "combined_metadata": combined_text
        })

    SESSION_STORE[sid].update({"message": "Building local index vectors...", "progress": 85})
    
    loop = asyncio.get_running_loop()
    embeddings_list = []
    for item in compiled_scenes:
        try:
            emb_res = await loop.run_in_executor(
                None, 
                lambda: genai_client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=item["combined_metadata"]
                )
            )
            embeddings_list.append(emb_res.embeddings[0].values)
        except Exception as e:
            log.error(f"Embedding mapping failure: {e}")
            embeddings_list.append([0.0] * 3072)

    vector_dimension = len(embeddings_list[0])
    faiss_index = faiss.IndexFlatL2(vector_dimension)
    faiss_index.add(np.array(embeddings_list, dtype=np.float32))

    SESSION_STORE[sid].update({
        "status": "ready",
        "progress": 100,
        "message": "Ready",
        "type": "hybrid_faiss_videorag",
        "scenes_data": compiled_scenes,
        "faiss_index": faiss_index
    })
    
    try:
        if os.path.exists(video_path): os.unlink(video_path)
    except Exception as e:
         log.warning(f"Cleanup gap: {e}")
         

def query_cloud_session(sid: str, question: str) -> dict:
    """
    Performs similarity search over local FAISS indices and maps Top-K results 
    directly into a text context reasoning loop for Gemini.
    Features defensive fallback models to absorb cloud server 503 exceptions.
    """
    entry = SESSION_STORE.get(sid)
    if not entry or "faiss_index" not in entry:
        return {"answer": "Error: Active local vector tracker lost.", "timestamps": [], "sources": []}

    try:
        emb_res = genai_client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=question
        )
        query_vector = np.array([emb_res.embeddings[0].values], dtype=np.float32)

        faiss_index = entry["faiss_index"]
        distances, indices = faiss_index.search(query_vector, k=min(3, len(entry["scenes_data"])))

        context_blocks = []
        retrieved_timestamps = []
        
        for idx in indices[0]:
            if idx == -1 or idx >= len(entry["scenes_data"]): 
                continue
            matched_scene = entry["scenes_data"][idx]
            
            m_start = matched_scene['start_time']
            m_end = matched_scene['end_time']
            context_blocks.append(
                f"Video Segment Snapshot [{int(m_start//60)}:{int(m_start%60):02d} - {int(m_end//60)}:{int(m_end%60):02d}]:\n"
                f"{matched_scene['combined_metadata']}\n"
            )
            
            retrieved_timestamps.append({
                "time": int(m_start),
                "label": "Relevant segment match"
            })

        unified_context = "\n".join(context_blocks)

        prompt = f"""You are an advanced Hybrid Local-Cloud VideoRAG Reasoning Assistant.
Answer the user's question completely based *only* on the extracted local scene logs provided below.

[RETRIEVED VIDEO CONTEXT LOGS]
{unified_context}
[END OF CONTEXT LOGS]

USER QUESTION: {question}

DETAILED ANCHORED ANSWER (You must cite the exact timecode ranges when providing visual or conversational insights):"""

        # Automated structural failover logic intercepts server constraints transparently
        try:
            log.info(f"Submitting query inference task straight to {GEMINI_MODEL}...")
            response = genai_client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt
            )
        except Exception as server_error:
            # Fall back immediately if the premium flagship engine reports a load bottleneck (503)
            if "503" in str(server_error) or "UNAVAILABLE" in str(server_error).upper():
                log.warning(f"Primary cluster node {GEMINI_MODEL} reporting heavy load (503). Running failover routine...")
                response = genai_client.models.generate_content(
                    model=CHUNK_MODEL,  # Invokes the highly responsive gemini-2.5-flash-lite endpoint
                    contents=prompt
                )
            else:
                raise server_error

        return {
            "answer": response.text.strip(),
            "timestamps": retrieved_timestamps[:5],
            "sources": ["local_faiss_index"]
        }
    except Exception as e:
        log.error(f"[{sid}] Critical vector retrieval query crash: {e}", exc_info=True)
        return {"answer": f"Retrieval Error Context: {str(e)}", "timestamps": [], "sources": ["error_handler"]}
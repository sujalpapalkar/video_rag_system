import logging
import os
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

print("1/2: Checking Text Embedding Model Initialization...")
from sentence_transformers import SentenceTransformer
# This will explicitly show a progress bar if it's downloading files
model = SentenceTransformer("all-MiniLM-L6-v2")
print("-> Text Embedding Model Ready!")

print("\n2/2: Checking Whisper Audio Model Initialization...")
from faster_whisper import WhisperModel
# Forcing download check explicitly on CPU
whisper = WhisperModel("small", device="cpu", compute_type="int8")
print("-> Whisper Audio Model Ready!")

print("\n🎉 ALL LOCAL MODELS INSTANTIATED SUCCESSFULY!")
/**
 * Frontend API Interface Layer for Multimodal Video & Audio System.
 * Safe Network Payload Delivery Contracts.
 */

const API_BASE_URL = 'http://127.0.0.1:8000';

export async function uploadVideo(file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/upload/video`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Video upload failed (${response.status}): ${errText}`);
  }

  return response.json();
}

export async function uploadAudio(file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/upload/audio`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Audio upload failed (${response.status}): ${errText}`);
  }

  return response.json();
}

export async function ingestYoutube(url: string) {
  const response = await fetch(`${API_BASE_URL}/ingest/youtube`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`YouTube ingestion failed (${response.status}): ${errText}`);
  }

  return response.json();
}

export async function getStatus(sessionId: string) {
  const response = await fetch(`${API_BASE_URL}/status/${sessionId}`);
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Status check failed (${response.status}): ${errText}`);
  }

  return response.json();
}

export async function askQuestion(sessionId: string, question: string) {
  try {
    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        question: question,
      }),
    });

    // If the backend returns an error status code, handle it without crashing the app
    if (!response.ok) {
      const errText = await response.text();
      return {
        answer: `Server communication hitch (${response.status}): ${errText || 'Unavailable'}`,
        timestamps: [],
        sources: ['network_guard']
      };
    }

    const data = await response.json();
    
    // Fallback protection: If the backend returned a 200 OK but the internal object contains a backend crash trace
    if (data && data.answer && data.answer.includes("Backend Runtime Exception")) {
      return {
        answer: `Google Cloud Error: The Gemini API is currently overloaded or experiencing high demand. Please wait a moment and try clicking your question again.\n\n[System Details: ${data.answer}]`,
        timestamps: [],
        sources: ['backend_error_forwarder']
      };
    }

    return data;
    
  } catch (error: unknown) {
    console.error("Network interface error caught:", error);
    const msg = error instanceof Error ? error.message : String(error);
    
    // Return a structured object matching the UI state requirements instead of allowing the promise to reject
    return {
      answer: `The local server could not be reached. Ensure your python backend is running via ./backend/run.sh. (Details: ${msg})`,
      timestamps: [],
      sources: ['client_network_catch']
    };
  }
}
'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Upload, Mic, Youtube, Send, Clock, FileVideo,
  FileAudio, Loader2, CheckCircle2, AlertCircle, ChevronDown
} from 'lucide-react'
import { uploadVideo, uploadAudio, ingestYoutube, askQuestion, getStatus } from '../lib/api'

type InputMode = 'video' | 'audio' | 'youtube'

interface Timestamp { time: number; label: string }

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamps?: Timestamp[]
  sources?: string[]
  loading?: boolean
}

interface ProcessingState {
  status: 'idle' | 'uploading' | 'processing' | 'ready' | 'error'
  progress: number
  message: string
}

function fmtTime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function uid() { return Math.random().toString(36).slice(2) }

// Clean backend raw markdown artifacts safely before displaying text in UI bubbles
const cleanBackendResponse = (text: string): string => {
  if (!text) return ""
  return text
    .replace(/\*\*/g, "")    // Strips out raw markdown bold tags completely
    .replace(/###\s+/g, "")  // Cleans out raw heading structures smoothly
    .trim()
}

function StatusBadge({ state, cooldown }: { state: ProcessingState, cooldown: number }) {
  if (state.status === 'idle') return null

  if (cooldown > 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-orange-400">
        <Loader2 size={13} className="animate-spin" />
        <span>Quota Cooldown: {cooldown}s</span>
      </div>
    )
  }

  const cfg = {
    idle: { icon: null, color: 'text-[var(--muted)]', label: '' },
    uploading: { icon: <Loader2 size={13} className="animate-spin" />, color: 'text-yellow-400', label: state.message },
    processing: { icon: <Loader2 size={13} className="animate-spin" />, color: 'text-[var(--accent)]', label: state.message },
    ready: { icon: <CheckCircle2 size={13} />, color: 'text-[var(--accent2)]', label: 'Ready' },
    error: { icon: <AlertCircle size={13} />, color: 'text-red-400', label: state.message },
  }[state.status]

  return (
    <div className={`flex items-center gap-2 text-xs ${cfg.color}`}>
      {cfg.icon}
      <span>{cfg.label}</span>
      {state.status === 'processing' && (
        <div className="w-24 h-1 bg-[var(--border)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-500 rounded-full"
            style={{ width: `${state.progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

function MsgBubble({
  msg,
  onTimestamp,
}: {
  msg: Message
  onTimestamp?: (t: number) => void
}) {
  const isUser = msg.role === 'user'
  return (
    <div className={`msg-appear flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-[var(--accent)] text-white rounded-br-none'
            : 'bg-[var(--surface2)] border border-[var(--border)] text-[var(--text)] rounded-bl-none'
        }`}
      >
        {msg.loading ? (
          <span className="flex items-center gap-2 text-[var(--muted)]">
            <Loader2 size={14} className="animate-spin" /> thinking...
          </span>
        ) : (
          <>
            <p className="whitespace-pre-wrap">{msg.content}</p>
            {msg.timestamps && msg.timestamps.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {msg.timestamps.map((ts, i) => (
                  <button
                    key={i}
                    onClick={() => onTimestamp?.(ts.time)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md
                      bg-[var(--surface)] border border-[var(--accent)]/40
                      text-[var(--accent)] hover:bg-[var(--accent)]/10
                      transition-colors text-xs font-mono"
                  >
                    <Clock size={11} />
                    {fmtTime(ts.time)}
                    {ts.label && <span className="text-[var(--muted)]">· {ts.label}</span>}
                  </button>
                ))}
              </div>
            )}
            {msg.sources && msg.sources.length > 0 && (
              <div className="mt-2 text-[10px] text-[var(--muted)]">
                Sources: {msg.sources.join(', ')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('video')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [processing, setProcessing] = useState<ProcessingState>({
    status: 'idle', progress: 0, message: ''
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [ytUrl, setYtUrl] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(prev => prev - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [cooldown])

  const startPolling = useCallback((sid: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const s = await getStatus(sid)
        setProcessing({ status: s.status as ProcessingState['status'], progress: s.progress, message: s.message })
        if (s.status === 'ready' || s.status === 'error') {
          clearInterval(pollRef.current!)
          pollRef.current = null
        }
      } catch (e) {
        console.error("Polling disconnect caught:", e)
        clearInterval(pollRef.current!)
      }
    }, 1500)
  }, [])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setProcessing({ status: 'uploading', progress: 0, message: 'Uploading...' })
    try {
      const isVideo = mode === 'video'
      const localUrl = URL.createObjectURL(file)
      if (isVideo) setVideoSrc(localUrl)
      const { session_id } = isVideo
        ? await uploadVideo(file)
        : await uploadAudio(file)
      setSessionId(session_id)
      setProcessing({ status: 'processing', progress: 5, message: 'Processing...' })
      startPolling(session_id)
      setMessages([{
        id: uid(), role: 'assistant',
        content: `Loaded "${file.name}". Transcribing audio track layers into context data nodes…`
      }])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setProcessing({ status: 'error', progress: 0, message: msg })
    }
    e.target.value = ''
  }

  async function handleYouTube() {
    if (!ytUrl.trim()) return
    setProcessing({ status: 'uploading', progress: 0, message: 'Fetching YouTube stream track...' })
    try {
      const { session_id } = await ingestYoutube(ytUrl.trim())
      setSessionId(session_id)
      setFileName(ytUrl.trim())
      setProcessing({ status: 'processing', progress: 5, message: 'Extracting audio data maps...' })
      startPolling(session_id)
      setMessages([{
        id: uid(), role: 'assistant',
        content: `YouTube track cached. Building text transcript map context layers…`
      }])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setProcessing({ status: 'error', progress: 0, message: msg })
    }
  }

  async function handleSend() {
    const q = input.trim()
    if (!q || !sessionId || processing.status !== 'ready' || isSubmitting || cooldown > 0) return
    
    setInput('')
    setIsSubmitting(true)
    
    const userMsg: Message = { id: uid(), role: 'user', content: q }
    const loadMsg: Message = { id: uid(), role: 'assistant', content: '', loading: true }
    setMessages(prev => [...prev, userMsg, loadMsg])
    
    try {
      const res = await askQuestion(sessionId, q)
      
      if (!res || typeof res !== 'object') {
        throw new Error("Malformatted server data object layer stream.")
      }
      
      // Pass raw server text response through cleaning utility block before output injection
      const finalCleanContent = cleanBackendResponse(res.answer)

      setMessages(prev => prev.map(m =>
        m.id === loadMsg.id
          ? { 
              ...m, 
              loading: false, 
              content: finalCleanContent || "Processing complete, but no valid description was returned.", 
              timestamps: res.timestamps || [], 
              sources: res.sources || ["video"] 
            }
          : m
      ))
    } catch (err: unknown) {
      console.error("Client side exception caught directly:", err)
      const msg = err instanceof Error ? err.message : String(err)
      setMessages(prev => prev.map(m =>
        m.id === loadMsg.id
          ? { ...m, loading: false, content: `Intermittent Payload Hitch: ${msg}. Try resubmitting.` }
          : m
      ))
    } finally {
      setIsSubmitting(false)
      setCooldown(2)
    }
  }

  function seekVideo(t: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = t
      videoRef.current.play()
    }
  }

  const modeConfig = {
    video: { icon: <FileVideo size={15} />, label: 'Video', accept: 'video/*' },
    audio: { icon: <FileAudio size={15} />, label: 'Audio', accept: 'audio/*' },
    youtube: { icon: <Youtube size={15} />, label: 'YouTube', accept: '' },
  }

  const globalInputDisable = processing.status !== 'ready' || !sessionId || isSubmitting || cooldown > 0

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="border-b border-[var(--border)] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center">
            <Mic size={14} className="text-white" />
          </div>
          <span className="text-[var(--text)] font-semibold tracking-tight">multimodal·ai</span>
          {/* UPDATED BADGE: Reflects the Local FAISS Index + Hybrid Cloud orchestration backend layout safely */}
          <span className="text-[10px] text-[var(--muted)] border border-[var(--border)] px-1.5 py-0.5 rounded font-medium">HYBRID</span>
        </div>
        <StatusBadge state={processing} cooldown={cooldown} />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[340px] flex-shrink-0 border-r border-[var(--border)] flex flex-col p-4 gap-4">
          <div className="flex rounded-lg overflow-hidden border border-[var(--border)] text-xs">
            {(['video', 'audio', 'youtube'] as InputMode[]).map(m => (
              <button
                key={m}
                disabled={processing.status === 'uploading' || processing.status === 'processing'}
                onClick={() => { setMode(m); setFileName(null); setVideoSrc(null); setSessionId(null); setProcessing({ status: 'idle', progress: 0, message: '' }) }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 transition-colors disabled:opacity-40 ${
                  mode === m
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]'
                }`}
              >
                {modeConfig[m].icon}{modeConfig[m].label}
              </button>
            ))}
          </div>

          {mode !== 'youtube' ? (
            <div
              onClick={() => processing.status !== 'uploading' && processing.status !== 'processing' && fileInputRef.current?.click()}
              className="relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--border)]
                hover:border-[var(--accent)] transition-colors cursor-pointer p-6 text-center group"
            >
              <div className="w-10 h-10 rounded-full bg-[var(--surface2)] flex items-center justify-center mb-3
                group-hover:bg-[var(--accent)]/10 transition-colors">
                <Upload size={18} className="text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors" />
              </div>
              {fileName ? (
                <p className="text-xs text-[var(--accent2)] truncate max-w-full px-2">{fileName}</p>
              ) : (
                <>
                  <p className="text-xs text-[var(--text)]">Drop {mode} file here</p>
                  <p className="text-[10px] text-[var(--muted)] mt-1">or click to browse</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={modeConfig[mode].accept}
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={ytUrl}
                disabled={processing.status === 'uploading' || processing.status === 'processing'}
                onChange={e => setYtUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className="w-full bg-[var(--surface2)] border border-[var(--border)] rounded-lg px-3 py-2.5
                  text-xs text-[var(--text)] placeholder:text-[var(--muted)] outline-none
                  focus:border-[var(--accent)] transition-colors disabled:opacity-40"
                onKeyDown={e => e.key === 'Enter' && handleYouTube()}
              />
              <button
                onClick={handleYouTube}
                disabled={processing.status === 'uploading' || processing.status === 'processing'}
                className="flex items-center justify-center gap-2 py-2 rounded-lg
                  bg-red-600 hover:bg-red-500 text-white text-xs transition-colors disabled:opacity-40"
              >
                <Youtube size={14} /> Load YouTube
              </button>
            </div>
          )}

          {videoSrc && (
            <div className="rounded-xl overflow-hidden border border-[var(--border)] bg-black">
              <video
                ref={videoRef}
                src={videoSrc}
                controls
                className="w-full"
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
              />
              <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] font-mono">
                {fmtTime(currentTime)}
              </div>
            </div>
          )}

          {processing.status === 'ready' && sessionId && (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Quick Questions</p>
              {[
                'Summarize this content',
                'What topics were discussed?',
                'What occurred at the beginning?',
              ].map(q => (
                <button
                  key={q}
                  disabled={globalInputDisable}
                  onClick={() => { setInput(q) }}
                  className="text-left text-xs px-3 py-2 rounded-lg bg-[var(--surface2)]
                    border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]
                    hover:border-[var(--accent)]/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronDown size={10} className="inline mr-1.5 rotate-[-90deg]" />
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="w-14 h-14 rounded-2xl bg-[var(--surface2)] border border-[var(--border)]
                  flex items-center justify-center mb-4 glow-accent">
                  <Mic size={22} className="text-[var(--accent)]" />
                </div>
                <h2 className="text-[var(--text)] font-semibold text-lg mb-2">Video & Audio Intelligence</h2>
                <p className="text-[var(--muted)] text-sm max-w-sm">
                  Upload a video, audio file, or paste a YouTube URL.<br />
                  Then ask anything — powered by VideoRAG Cloud Stream.
                </p>
              </div>
            ) : (
              messages.map(msg => (
                <MsgBubble key={msg.id} msg={msg} onTimestamp={seekVideo} />
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-[var(--border)] px-4 py-3">
            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                disabled={globalInputDisable}
                placeholder={processing.status === 'ready' && sessionId ? 'Ask anything about this content...' : 'Upload content to begin'}
                rows={1}
                className="flex-1 bg-[var(--surface2)] border border-[var(--border)] rounded-xl
                  px-4 py-3 text-sm text-[var(--text)] placeholder:text-[var(--muted)]
                  outline-none focus:border-[var(--accent)] transition-colors resize-none
                  disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ minHeight: 44, maxHeight: 120 }}
              />
              <button
                onClick={handleSend}
                disabled={globalInputDisable || !input.trim()}
                className="w-11 h-11 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent)]/80
                  flex items-center justify-center text-white transition-colors
                  disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
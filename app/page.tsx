"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const UNIVERSITIES = [
  { value: "dit-university", label: "DIT University, Dehradun" },
];

// Voice language options
const VOICE_LANGS = [
  { value: "hi-IN", label: "हिंदी" },
  { value: "en-IN", label: "EN" },
];

interface Session {
  id: string;
  title: string;
  university: string;
  updated_at: string;
}

interface SavedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: { type: string; text: string }[];
}

function generateId(): string {
  return crypto.randomUUID();
}

// =============================================================================
// Detect if text is Hindi/Hinglish/English for TTS voice selection
// =============================================================================
function detectLanguage(text: string): "hi" | "en" {
  // Count Devanagari characters
  const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
  // If more than 10% Devanagari characters, treat as Hindi
  if (devanagariCount > text.length * 0.1) return "hi";
  return "en";
}

// =============================================================================
// TTS — Speak text aloud
// =============================================================================
function speakText(text: string, onStart?: () => void, onEnd?: () => void) {
  if (!("speechSynthesis" in window)) return;

  // Stop any ongoing speech
  window.speechSynthesis.cancel();

  // Strip markdown for cleaner speech
  const cleanText = text
    .replace(/#{1,6}\s/g, "") // headers
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/\*(.*?)\*/g, "$1") // italic
    .replace(/\[(.*?)\]\(.*?\)/g, "$1") // links
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // code
    .replace(/\|.*\|/g, "") // table rows
    .replace(/---+/g, "") // horizontal rules
    .replace(/- /g, "") // bullet points
    .replace(/\n{2,}/g, ". ") // double newlines to pause
    .replace(/\n/g, " ") // single newlines
    .trim();

  if (!cleanText) return;

  const lang = detectLanguage(cleanText);
  const utterance = new SpeechSynthesisUtterance(cleanText);

  // Pick a voice matching the language
  const voices = window.speechSynthesis.getVoices();
  const langCode = lang === "hi" ? "hi" : "en";
  const matchingVoice = voices.find((v) => v.lang.startsWith(langCode));
  if (matchingVoice) utterance.voice = matchingVoice;

  utterance.lang = lang === "hi" ? "hi-IN" : "en-IN";
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

// =============================================================================
// CHAT PANEL — Separated so it remounts when session changes (key={sessionId})
// =============================================================================
function ChatPanel({
  sessionId,
  university,
  initialMessages,
  onMessageSaved,
}: {
  sessionId: string;
  university: string;
  initialMessages: SavedMessage[];
  onMessageSaved: () => void;
}) {
  const [input, setInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState("hi-IN");
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { university } }),
    [university]
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id: sessionId,
    transport,
  });

  // Load saved messages on mount
  useEffect(() => {
    if (initialMessages.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages(initialMessages as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isLoading = status === "streaming" || status === "submitted";

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Stop speaking when component unmounts
  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  // Save assistant messages to DB when streaming completes
  const lastMessage = messages[messages.length - 1];
  const lastMessageText = lastMessage ? getMessageText(lastMessage) : "";

  useEffect(() => {
    if (
      status === "ready" &&
      lastMessage?.role === "assistant" &&
      lastMessageText.length > 0
    ) {
      saveMessageToDB(sessionId, "assistant", lastMessageText);
      onMessageSaved();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lastMessage?.id]);

  async function saveMessageToDB(sid: string, role: string, content: string) {
    try {
      await fetch(`/api/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, content }),
      });
    } catch (err) {
      console.error("Failed to save message:", err);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userText = input;
    setInput("");

    // Save user message to DB
    saveMessageToDB(sessionId, "user", userText);

    // Send to AI
    sendMessage({ text: userText });
  }

  // ─── Voice Input (Speech-to-Text) ───
  function startListening() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Use Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = voiceLang;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      setInput(finalTranscript + interimTranscript);
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopListening() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }

  function toggleListening() {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  // ─── TTS toggle for a message ───
  function toggleSpeak(messageId: string, text: string) {
    if (speakingMsgId === messageId) {
      stopSpeaking();
      setSpeakingMsgId(null);
    } else {
      stopSpeaking();
      speakText(
        text,
        () => setSpeakingMsgId(messageId),
        () => setSpeakingMsgId(null)
      );
    }
  }

  return (
    <>
      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome-message">
            <p>👋 Hi! I can help you with information about:</p>
            <ul>
              <li>📚 Courses & Programs</li>
              <li>💼 Placements & Packages</li>
              <li>📝 Admissions & Eligibility</li>
              <li>💰 Fees & Scholarships</li>
              <li>🏫 Campus & Facilities</li>
              <li>👨‍🏫 Faculty & Research</li>
            </ul>
            <p>
              Try asking: <em>&quot;What are the top placement packages at DIT?&quot;</em>
            </p>
            <p className="voice-hint">
              🎤 You can also ask using your voice — in English or Hindi!
            </p>
          </div>
        )}

        {messages.map((message) => {
          const text = getMessageText(message);
          return (
            <div
              key={message.id}
              className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`}
            >
              <div className="message-header">
                <span className="message-role">
                  {message.role === "user" ? "You" : "Assistant"}
                </span>
                {/* Speaker button on assistant messages */}
                {message.role === "assistant" && text.length > 0 && (
                  <button
                    className={`speak-btn ${speakingMsgId === message.id ? "speaking" : ""}`}
                    onClick={() => toggleSpeak(message.id, text)}
                    title={speakingMsgId === message.id ? "Stop speaking" : "Listen"}
                  >
                    {speakingMsgId === message.id ? "⏹" : "🔊"}
                  </button>
                )}
              </div>
              <div className="message-content">
                {message.role === "assistant" ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {text}
                  </ReactMarkdown>
                ) : (
                  text
                )}
              </div>
            </div>
          );
        })}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="message assistant-message">
            <div className="message-role">Assistant</div>
            <div className="message-content thinking">Thinking...</div>
          </div>
        )}

        {error && (
          <div className="error-message">
            ❌ Error: {error.message}. Please try again.
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="input-form">
        {/* Voice language selector */}
        <div className="voice-lang-selector">
          {VOICE_LANGS.map((lang) => (
            <button
              key={lang.value}
              type="button"
              className={`lang-btn ${voiceLang === lang.value ? "active" : ""}`}
              onClick={() => setVoiceLang(lang.value)}
              title={`Switch voice to ${lang.label}`}
            >
              {lang.label}
            </button>
          ))}
        </div>

        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isListening
              ? voiceLang === "hi-IN"
                ? "बोलिए... 🎤"
                : "Listening... 🎤"
              : "Ask about courses, placements, admissions..."
          }
          className={`chat-input ${isListening ? "listening" : ""}`}
          disabled={isLoading}
        />

        {/* Microphone button */}
        <button
          type="button"
          onClick={toggleListening}
          disabled={isLoading}
          className={`mic-button ${isListening ? "recording" : ""}`}
          title={isListening ? "Stop recording" : "Start voice input"}
        >
          {isListening ? "⏹" : "🎤"}
        </button>

        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="send-button"
        >
          {isLoading ? "..." : "Send"}
        </button>
      </form>
    </>
  );
}

// Extract text from message parts or content
function getMessageText(message: {
  parts?: { type: string; text?: string }[];
  content?: string;
}): string {
  if (message.parts) {
    return message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("");
  }
  return message.content || "";
}

// =============================================================================
// MAIN PAGE — Sidebar + ChatPanel
// =============================================================================
export default function ChatPage() {
  const [university, setUniversity] = useState("dit-university");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loadedMessages, setLoadedMessages] = useState<SavedMessage[]>([]);
  const [chatKey, setChatKey] = useState(0); // forces ChatPanel remount

  // ─── Load sessions list ───
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      setSessions(data);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }, []);

  // ─── On mount: load sessions and restore last active ───
  useEffect(() => {
    fetchSessions();
    const lastSessionId = localStorage.getItem("activeSessionId");
    if (lastSessionId) {
      loadSession(lastSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Save active session to localStorage ───
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem("activeSessionId", activeSessionId);
    }
  }, [activeSessionId]);

  // ─── Create new chat ───
  const startNewChat = useCallback(async () => {
    const id = generateId();
    try {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, university }),
      });
      setActiveSessionId(id);
      setLoadedMessages([]);
      setChatKey((k) => k + 1); // force remount
      fetchSessions();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [university, fetchSessions]);

  // ─── Load an existing session ───
  async function loadSession(sessionId: string) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) {
        localStorage.removeItem("activeSessionId");
        return;
      }
      const data = await res.json();
      setUniversity(data.session.university);

      // Convert DB messages to useChat v6 format
      const chatMessages: SavedMessage[] = data.messages.map(
        (msg: { id: number; role: string; content: string }) => ({
          id: String(msg.id),
          role: msg.role as "user" | "assistant",
          content: msg.content,
          parts: [{ type: "text", text: msg.content }],
        })
      );

      setActiveSessionId(sessionId);
      setLoadedMessages(chatMessages);
      setChatKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to load session:", err);
      localStorage.removeItem("activeSessionId");
    }
  }

  // ─── Delete a session ───
  async function handleDeleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setLoadedMessages([]);
        setChatKey((k) => k + 1);
        localStorage.removeItem("activeSessionId");
      }
      fetchSessions();
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }

  // ─── Handle first message (auto-create session) ───
  async function handleFirstMessage() {
    if (!activeSessionId) {
      const id = generateId();
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, university }),
      });
      setActiveSessionId(id);
      setLoadedMessages([]);
      setChatKey((k) => k + 1);
      fetchSessions();
      return id;
    }
    return activeSessionId;
  }

  // Format date for sidebar
  function formatDate(dateStr: string): { time: string; relative: string } {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    let relative: string;
    if (diffMins < 1) relative = "Just now";
    else if (diffMins < 60) relative = `${diffMins}m ago`;
    else {
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) relative = `${diffHours}h ago`;
      else {
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) relative = `${diffDays}d ago`;
        else relative = date.toLocaleDateString();
      }
    }

    return { time, relative };
  }

  return (
    <div className="app-layout">
      {/* ─── SIDEBAR ─── */}
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="sidebar-header">
          <h2>Chat History</h2>
          <button onClick={() => setSidebarOpen(false)} className="sidebar-close" title="Close sidebar">
            ✕
          </button>
        </div>

        <button onClick={startNewChat} className="new-chat-btn">
          + New Chat
        </button>

        <div className="sessions-list">
          {sessions.length === 0 && (
            <p className="no-sessions">No chats yet. Start a new conversation!</p>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSessionId ? "active" : ""}`}
              onClick={() => loadSession(session.id)}
            >
              <div className="session-title">{session.title}</div>
              <div className="session-meta">
                <span className="session-time">{formatDate(session.updated_at).time}</span>
                <span className="session-relative">{formatDate(session.updated_at).relative}</span>
                <button
                  onClick={(e) => handleDeleteSession(session.id, e)}
                  className="delete-btn"
                  title="Delete chat"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ─── MAIN CHAT AREA ─── */}
      <div className="chat-container">
        <header className="chat-header">
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} className="sidebar-toggle" title="Open sidebar">
              ☰
            </button>
          )}
          <div className="header-content">
            <h1>🎓 Uttarakhand University Assistant</h1>
            <p>Ask anything about courses, placements, admissions, fees & more</p>
          </div>
          <select
            value={university}
            onChange={(e) => setUniversity(e.target.value)}
            className="university-select"
          >
            {UNIVERSITIES.map((uni) => (
              <option key={uni.value} value={uni.value}>
                {uni.label}
              </option>
            ))}
          </select>
        </header>

        {activeSessionId ? (
          <ChatPanel
            key={chatKey}
            sessionId={activeSessionId}
            university={university}
            initialMessages={loadedMessages}
            onMessageSaved={fetchSessions}
          />
        ) : (
          <>
            <div className="messages">
              <div className="welcome-message">
                <p>👋 Hi! I can help you with information about:</p>
                <ul>
                  <li>📚 Courses & Programs</li>
                  <li>💼 Placements & Packages</li>
                  <li>📝 Admissions & Eligibility</li>
                  <li>💰 Fees & Scholarships</li>
                  <li>🏫 Campus & Facilities</li>
                  <li>👨‍🏫 Faculty & Research</li>
                </ul>
                <p>
                  Try asking: <em>&quot;What are the top placement packages at DIT?&quot;</em>
                </p>
                <p className="voice-hint">
                  🎤 You can also ask using your voice — in English or Hindi!
                </p>
              </div>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const inputEl = e.currentTarget.querySelector("input") as HTMLInputElement;
                if (!inputEl.value.trim()) return;
                await handleFirstMessage();
              }}
              className="input-form"
            >
              <input
                placeholder="Ask about courses, placements, admissions..."
                className="chat-input"
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (!val) return;
                    e.preventDefault();
                    const id = await handleFirstMessage();
                    if (id) {
                      // Session created, ChatPanel will mount
                    }
                  }
                }}
              />
              <button type="submit" className="send-button">Send</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

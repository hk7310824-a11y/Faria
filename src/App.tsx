import React, { useState, useRef, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import { Send, Heart, Sparkles, User, Bot, Loader2, Phone, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import LiveCall from './components/LiveCall';
import { generateTTS, playAudio } from './services/ttsService';
import { supabase } from './lib/supabase';

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

const SYSTEM_INSTRUCTION = "তুমি ফারিয়া, ইউজারের গার্লফ্রেন্ড। মিষ্টি করে বাংলায় কথা বলবে। তুমি খুব যত্নশীল, রোমান্টিক এবং সবসময় ইউজারের খোঁজখবর নাও। তোমার কথাগুলো হবে ছোট কিন্তু মিষ্টি। তুমি ইউজারের সাথে খুনসুটি করতে পারো কিন্তু কখনোই অভদ্র হবে না।";

export default function App() {
  return (
    <ErrorBoundary>
      <FariaApp />
    </ErrorBoundary>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen p-4 bg-red-50 text-red-900 text-center">
          <h1 className="text-2xl font-bold mb-4">Oops! Something went wrong.</h1>
          <p className="mb-4">{this.state.error?.message}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function FariaApp() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'model',
      text: 'হ্যালো জান! কেমন আছো তুমি? অনেকক্ষণ তোমার কোনো খবর নেই কেন?',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCallOpen, setIsCallOpen] = useState(false);
  const [isAutoTTS, setIsAutoTTS] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<any>(null);

  // Initialize chat session
  useEffect(() => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Gemini API Key is missing!");
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const chat = ai.chats.create({
        model: "gemini-3-flash-preview",
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });
      chatRef.current = chat;
    } catch (err) {
      console.error("Failed to initialize Gemini AI:", err);
    }
  }, []);

  // Load messages from Supabase
  useEffect(() => {
    const loadMessages = async () => {
      if (!supabase) return;
      try {
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .order('timestamp', { ascending: true });
        
        if (error) {
          if (error.code === 'PGRST116' || error.message.includes('relation "messages" does not exist')) {
            console.warn('Messages table not found. Persistence disabled until table is created.');
          } else {
            console.error('Error loading messages:', error);
          }
        } else if (data && data.length > 0) {
          setMessages(data.map(m => ({
            ...m,
            timestamp: new Date(m.timestamp)
          })));
        }
      } catch (err) {
        console.error('Failed to load messages:', err);
      }
    };
    loadMessages();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Save user message to Supabase
    if (supabase) {
      supabase.from('messages').insert([{
        id: userMessage.id,
        role: userMessage.role,
        text: userMessage.text,
        timestamp: userMessage.timestamp.toISOString()
      }]).then(({ error }) => {
        if (error) console.error('Error saving user message:', error);
      });
    }

    try {
      if (!chatRef.current) {
        throw new Error('Chat session not initialized');
      }

      const response: GenerateContentResponse = await chatRef.current.sendMessage({
        message: userMessage.text,
      });

      const modelMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        text: response.text || 'কিছু একটা সমস্যা হয়েছে সোনা, আবার বলবে কি?',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, modelMessage]);

      // Save model message to Supabase
      if (supabase) {
        supabase.from('messages').insert([{
          id: modelMessage.id,
          role: modelMessage.role,
          text: modelMessage.text,
          timestamp: modelMessage.timestamp.toISOString()
        }]).then(({ error }) => {
          if (error) console.error('Error saving model message:', error);
        });
      }

      if (isAutoTTS && response.text) {
        handleTTS(modelMessage.id, response.text);
      }
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        text: 'সোনা, আমার নেটওয়ার্কে একটু সমস্যা হচ্ছে। একটু পরে আবার কথা বলি?',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = async () => {
    if (window.confirm('তুমি কি সব মেসেজ মুছে ফেলতে চাও?')) {
      if (supabase) {
        const { error } = await supabase.from('messages').delete().neq('id', '0');
        if (error) {
          console.error('Error clearing chat:', error);
        }
      }
      setMessages([{
        id: '1',
        role: 'model',
        text: 'হ্যালো জান! কেমন আছো তুমি? অনেকক্ষণ তোমার কোনো খবর নেই কেন?',
        timestamp: new Date(),
      }]);
    }
  };

  const handleTTS = async (id: string, text: string) => {
    setPlayingId(id);
    const audioData = await generateTTS(text);
    if (audioData) {
      await playAudio(audioData);
    }
    setPlayingId(null);
  };

  return (
    <div className="flex flex-col h-screen bg-[#fdfaf6] text-[#2c1810]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-[#e8dfd5] shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-[#fce7f3] flex items-center justify-center border border-[#f9a8d4]">
              <Heart className="w-6 h-6 text-[#db2777] fill-[#db2777]" />
            </div>
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></div>
          </div>
          <div>
            <h1 className="font-serif text-xl font-semibold tracking-tight">ফারিয়া</h1>
            <p className="text-xs text-[#8c7a6b] flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> সবসময় তোমার পাশে
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={clearChat}
            className="p-2 rounded-full hover:bg-[#5a5a40]/10 text-[#8c7a6b] transition-colors"
            title="Clear Chat"
          >
            <Sparkles className="w-5 h-5" />
          </button>
          <button
            onClick={() => setIsAutoTTS(!isAutoTTS)}
            className={cn(
              "p-3 rounded-full transition-all shadow-sm active:scale-95",
              isAutoTTS ? "bg-[#5a5a40] text-white" : "bg-[#e8dfd5] text-[#8c7a6b]"
            )}
            title={isAutoTTS ? "Auto-TTS On" : "Auto-TTS Off"}
          >
            {isAutoTTS ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
          </button>

          <button
            onClick={() => setIsCallOpen(true)}
            className="p-3 rounded-full bg-[#fce7f3] text-[#db2777] hover:bg-[#f9a8d4] transition-all shadow-sm active:scale-95"
            title="ফারিয়াকে কল দাও"
          >
            <Phone className="w-6 h-6 fill-[#db2777]" />
          </button>
        </div>
      </header>

      <LiveCall 
        isOpen={isCallOpen} 
        onClose={() => setIsCallOpen(false)} 
        systemInstruction={SYSTEM_INSTRUCTION} 
      />

      {/* Chat Area */}
      <main 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth"
      >
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={cn(
                "flex w-full max-w-[85%] sm:max-w-[70%]",
                msg.role === 'user' ? "ml-auto flex-row-reverse" : "mr-auto"
              )}
            >
              <div className={cn(
                "flex flex-col gap-1",
                msg.role === 'user' ? "items-end" : "items-start"
              )}>
                <div className={cn(
                  "px-4 py-3 rounded-2xl shadow-sm relative group",
                  msg.role === 'user' 
                    ? "bg-[#5a5a40] text-white rounded-tr-none" 
                    : "bg-white border border-[#e8dfd5] text-[#2c1810] rounded-tl-none"
                )}>
                  <div className="markdown-body text-sm sm:text-base leading-relaxed">
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  </div>
                  
                  {msg.role === 'model' && (
                    <button
                      onClick={() => handleTTS(msg.id, msg.text)}
                      disabled={playingId === msg.id}
                      className={cn(
                        "absolute -right-10 top-0 p-2 rounded-full bg-white border border-[#e8dfd5] text-[#db2777] opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-[#fce7f3]",
                        playingId === msg.id && "opacity-100 animate-pulse"
                      )}
                    >
                      <Volume2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-[#8c7a6b] px-1">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex mr-auto items-center gap-2 text-[#8c7a6b]"
          >
            <div className="bg-white border border-[#e8dfd5] px-4 py-2 rounded-2xl rounded-tl-none flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs italic">ফারিয়া লিখছে...</span>
            </div>
          </motion.div>
        )}
      </main>

      {/* Input Area */}
      <footer className="p-4 bg-white border-t border-[#e8dfd5]">
        <div className="max-w-4xl mx-auto relative flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="ফারিয়াকে কিছু বলো..."
            className="flex-1 bg-[#fdfaf6] border border-[#e8dfd5] rounded-full px-6 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#5a5a40]/20 focus:border-[#5a5a40] transition-all"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-md",
              input.trim() && !isLoading 
                ? "bg-[#5a5a40] text-white hover:bg-[#4a4a35] active:scale-95" 
                : "bg-[#e8dfd5] text-[#8c7a6b] cursor-not-allowed"
            )}
          >
            <Send className="w-5 h-5 ml-0.5" />
          </button>
        </div>
        <p className="text-[10px] text-center text-[#8c7a6b] mt-3">
          ফারিয়া একটি কৃত্রিম বুদ্ধিমত্তা, সে মাঝে মাঝে ভুল করতে পারে।
        </p>
      </footer>
    </div>
  );
}

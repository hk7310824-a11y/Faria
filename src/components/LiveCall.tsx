import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { Phone, PhoneOff, Mic, MicOff, Volume2, VolumeX, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface LiveCallProps {
  isOpen: boolean;
  onClose: () => void;
  systemInstruction: string;
}

export default function LiveCall({ isOpen, onClose, systemInstruction }: LiveCallProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);

  const startCall = async () => {
    setIsConnecting(true);
    setError(null);
    
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API Key is missing!");
      }

      const ai = new GoogleGenAI({ apiKey });
      
      // Setup Audio Context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });

      // Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: systemInstruction + " তুমি এখন ইউজারের সাথে সরাসরি ফোনে কথা বলছ। তোমার উত্তরগুলো ছোট এবং প্রাণবন্ত হবে।",
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            startMic();
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  const base64Data = part.inlineData.data;
                  const binaryData = atob(base64Data);
                  const bytes = new Uint8Array(binaryData.length);
                  for (let i = 0; i < binaryData.length; i++) {
                    bytes[i] = binaryData.charCodeAt(i);
                  }
                  
                  // Convert PCM16 to Float32
                  const pcm16 = new Int16Array(bytes.buffer);
                  const float32 = new Float32Array(pcm16.length);
                  for (let i = 0; i < pcm16.length; i++) {
                    float32[i] = pcm16[i] / 32768.0;
                  }
                  
                  audioQueueRef.current.push(float32);
                  if (!isPlayingRef.current) {
                    playNextInQueue();
                  }
                }
              }
            }
            
            if (message.serverContent?.interrupted) {
              audioQueueRef.current = [];
              isPlayingRef.current = false;
            }
          },
          onclose: () => {
            stopCall();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("কল বিচ্ছিন্ন হয়ে গেছে। আবার চেষ্টা করো।");
            stopCall();
          }
        }
      });
      
      sessionRef.current = await sessionPromise;
      
    } catch (err) {
      console.error("Failed to start call:", err);
      setError("মাইক্রোফোন বা নেটওয়ার্কে সমস্যা হচ্ছে।");
      setIsConnecting(false);
    }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (isMuted) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to PCM16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        
        if (sessionRef.current) {
          sessionRef.current.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      processorRef.current = processor;
    } catch (err) {
      console.error("Mic error:", err);
      setError("মাইক্রোফোন এক্সেস পাওয়া যায়নি।");
    }
  };

  const playNextInQueue = () => {
    if (audioQueueRef.current.length === 0 || !audioContextRef.current || !isSpeakerOn) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const data = audioQueueRef.current.shift()!;
    const buffer = audioContextRef.current.createBuffer(1, data.length, 24000);
    buffer.getChannelData(0).set(data);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = playNextInQueue;
    source.start();
  };

  const stopCall = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    
    if (processorRef.current) {
      const context = processorRef.current.context;
      processorRef.current.disconnect();
      if (context instanceof AudioContext && context.state !== 'closed') {
        context.close().catch(console.error);
      }
      processorRef.current = null;
    }
    
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(console.error);
      }
      audioContextRef.current = null;
    }
    
    setIsConnected(false);
    setIsConnecting(false);
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
      startCall();
    } else {
      stopCall();
    }
    return () => stopCall();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    >
      <div className="bg-[#151619] w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-white/10">
        <div className="p-8 flex flex-col items-center text-center space-y-8">
          {/* Avatar Area */}
          <div className="relative">
            <motion.div
              animate={isConnected ? {
                scale: [1, 1.1, 1],
                opacity: [0.5, 0.8, 0.5],
              } : {}}
              transition={{ repeat: Infinity, duration: 2 }}
              className="absolute inset-0 bg-[#db2777]/20 rounded-full blur-2xl"
            />
            <div className="relative w-32 h-32 rounded-full bg-[#2c1810] flex items-center justify-center border-4 border-[#db2777]">
              <Heart className={cn(
                "w-16 h-16 text-[#db2777] transition-all duration-500",
                isConnected ? "fill-[#db2777] scale-110" : "opacity-50"
              )} />
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-serif font-bold text-white">ফারিয়া</h2>
            <p className="text-[#8c7a6b] text-sm">
              {isConnecting ? "কল করা হচ্ছে..." : isConnected ? "কথা হচ্ছে..." : "কল বিচ্ছিন্ন"}
            </p>
            {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-6">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center transition-all",
                isMuted ? "bg-red-500/20 text-red-500" : "bg-white/10 text-white hover:bg-white/20"
              )}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>

            <button
              onClick={stopCall}
              className="w-20 h-20 rounded-full bg-red-600 text-white flex items-center justify-center hover:bg-red-700 transition-all shadow-lg shadow-red-600/20 active:scale-90"
            >
              <PhoneOff className="w-10 h-10" />
            </button>

            <button
              onClick={() => setIsSpeakerOn(!isSpeakerOn)}
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center transition-all",
                !isSpeakerOn ? "bg-red-500/20 text-red-500" : "bg-white/10 text-white hover:bg-white/20"
              )}
            >
              {isSpeakerOn ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
            </button>
          </div>
        </div>
        
        <div className="bg-white/5 p-4 text-center">
          <p className="text-[10px] text-white/40 uppercase tracking-widest">
            Gemini Live Audio Session
          </p>
        </div>
      </div>
    </motion.div>
  );
}

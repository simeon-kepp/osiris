'use client';

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Crosshair, MapPin, Loader2, Image as ImageIcon, UploadCloud, X, Navigation } from 'lucide-react';

interface AstraPanelProps {
  onGeolocate?: (data: { lat: number; lng: number; details: any }) => void;
  isOpen?: boolean;
  onClose?: () => void;
  isMobile?: boolean;
}

export default function AstraPanel({ onGeolocate, isOpen = true, onClose, isMobile }: AstraPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      setFile(f);
      setPreview(URL.createObjectURL(f));
      setError('');
      setResult(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const f = e.dataTransfer.files[0];
      if (f.type.startsWith('image/')) {
        setFile(f);
        setPreview(URL.createObjectURL(f));
        setError('');
        setResult(null);
      } else {
        setError('Please drop a valid image file.');
      }
    }
  };

  const handleSubmit = async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    setResult(null);

    const formData = new FormData();
    formData.append('image', file);

    try {
      const res = await fetch('/api/astra', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to geolocate image');

      setResult(data);
      if (data.status === 'success' && data.result_lat && data.result_lon && onGeolocate) {
        onGeolocate({ lat: data.result_lat, lng: data.result_lon, details: data });
      } else if (data.status === 'failed') {
        setError(data.error_message || 'Image processing failed to find a match.');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during geolocation.');
    } finally {
      setLoading(false);
    }
  };

  const panelContent = (
    <div className={`flex flex-col bg-[#0b0f19]/95 backdrop-blur-md border border-[var(--cyan-primary)]/20 shadow-[0_0_15px_rgba(0,229,255,0.1)] rounded-lg overflow-hidden ${isMobile ? 'h-full' : 'w-80 max-h-[85vh]'}`}>
      
      {/* HEADER */}
      <div className="flex justify-between items-center p-3 border-b border-[var(--cyan-primary)]/20 bg-[#151b2b]">
        <div className="flex items-center gap-2">
          <Crosshair className="w-5 h-5 text-[var(--cyan-primary)]" />
          <h2 className="font-mono text-sm text-[var(--cyan-primary)] tracking-wider uppercase font-bold">Astra Geolocation</h2>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <p className="text-xs text-slate-400 mb-4 leading-relaxed font-mono">
          Upload a street-view image. The Netryx Astra GPU cluster will extract DINOv2 descriptors and perform 3D dense matching to geolocate the image globally.
        </p>

        {/* UPLOAD ZONE */}
        <div 
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="border-2 border-dashed border-slate-700 hover:border-[var(--cyan-primary)]/50 rounded-lg p-6 text-center transition-all bg-black/20 group relative cursor-pointer"
        >
          <input 
            type="file" 
            accept="image/*" 
            onChange={handleFileChange} 
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
          />
          
          {preview ? (
            <div className="relative w-full aspect-video rounded-md overflow-hidden bg-black/50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Preview" className="w-full h-full object-contain" />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-[var(--cyan-primary)]/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                <UploadCloud className="w-6 h-6 text-[var(--cyan-primary)]" />
              </div>
              <div className="font-mono text-xs text-slate-300">
                Drag & Drop or <span className="text-[var(--cyan-primary)]">Browse</span>
              </div>
            </div>
          )}
        </div>

        {/* CONTROLS */}
        <button
          onClick={handleSubmit}
          disabled={!file || loading}
          className="mt-4 w-full flex items-center justify-center gap-2 py-3 px-4 bg-[var(--cyan-primary)]/10 hover:bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)] border border-[var(--cyan-primary)]/30 rounded-md font-mono text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              ANALYZING ON GPU...
            </>
          ) : (
            <>
              <Crosshair className="w-4 h-4" />
              INITIATE TRACE
            </>
          )}
        </button>

        {/* ERROR / SUCCESS STATES */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-md">
              <p className="text-red-400 text-xs font-mono">{error}</p>
            </motion.div>
          )}

          {result && result.status === 'success' && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 p-4 bg-[#151b2b] border border-[var(--gold-primary)]/30 rounded-md">
              <div className="flex items-center gap-2 mb-3">
                <MapPin className="w-4 h-4 text-[var(--gold-primary)]" />
                <span className="font-mono text-xs font-bold text-[var(--gold-primary)]">LOCATION IDENTIFIED</span>
              </div>
              
              <div className="space-y-2 font-mono text-[11px] text-slate-300">
                <div className="flex justify-between border-b border-white/5 pb-1">
                  <span>LATITUDE</span>
                  <span className="text-[var(--cyan-primary)]">{result.result_lat.toFixed(6)}</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-1">
                  <span>LONGITUDE</span>
                  <span className="text-[var(--cyan-primary)]">{result.result_lon.toFixed(6)}</span>
                </div>
                {result.inliers && (
                  <div className="flex justify-between border-b border-white/5 pb-1">
                    <span>CONFIDENCE (INLIERS)</span>
                    <span className="text-[var(--alert-green)]">{result.inliers}</span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );

  if (!isOpen) return null;

  if (isMobile) {
    return createPortal(
      <div className="fixed inset-0 z-50 p-4 bg-black/60 backdrop-blur-sm">
        {panelContent}
      </div>,
      document.body
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="pointer-events-auto"
    >
      {panelContent}
    </motion.div>
  );
}

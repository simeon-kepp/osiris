'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Truck, TrendingUp, ShieldAlert, FlaskConical, Building2, X, Database,
} from 'lucide-react';

/**
 * Verbatim from the pitch deck's "What the model can be used for" slide
 * (screenshot-transcribed 2026-09-27 — no backing source file exists for this
 * slide in build_pitch_deck.py or any rendered deck; the screenshot Simeon
 * sent IS the source of record). Do not paraphrase these strings.
 */
const CAPABILITIES = [
  {
    icon: AlertTriangle,
    title: 'Early warning & risk',
    body: 'Early detection of natural events, crises, and cascading failures. Bring together weather, seismic, satellite, infrastructure, and operational signals to spot changing conditions before they become critical.',
  },
  {
    icon: Truck,
    title: 'Infrastructure & logistics',
    body: 'Visibility across supply chains, transport, shipping, and critical infrastructure. Work across ERP, fleet management, AIS, GIS, warehouse systems, and infrastructure feeds to trace dependencies from supplier to physical asset.',
  },
  {
    icon: TrendingUp,
    title: 'Markets & economy',
    body: 'Understanding market moves, macro signals, and sector-level connections. Combine market feeds, economic indicators, company data, forecasts, and internal planning systems to understand what is moving the numbers and why.',
  },
  {
    icon: ShieldAlert,
    title: 'Security & geopolitics',
    body: 'Tracking geopolitical developments, conflict dynamics, and systemic risk. Link threat intelligence, SIEM data, geopolitical events, infrastructure records, and internal risk systems to see how external developments reach your organisation.',
  },
  {
    icon: FlaskConical,
    title: 'Research & science',
    body: 'An open interface for research, hypothesis testing, and discovery. Use scientific datasets, laboratory results, public APIs, simulations, sensor networks, and institutional research as part of the same evolving evidence base.',
  },
  {
    icon: Building2,
    title: 'Enterprise & systems',
    body: 'Data-driven decisions with context across time, geography, and systems. Put SAP, ERP, CRM, data warehouses, Kafka streams, internal APIs, and operational data into the wider context of the real world.',
  },
];

interface CapabilitiesPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CapabilitiesPanel({ isOpen, onClose }: CapabilitiesPanelProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[500] flex items-center justify-center p-4 pointer-events-auto"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-[var(--bg-void)]/80 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            onClick={(e) => e.stopPropagation()}
            className="relative glass-panel osiris-glow w-full max-w-4xl max-h-[85vh] overflow-y-auto styled-scrollbar p-6"
          >
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-[var(--gold-primary)]" />
                <span className="text-sm font-mono font-bold text-[var(--text-heading)] tracking-wider">
                  WHAT THE MODEL CAN BE USED FOR
                </span>
              </div>
              <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] font-mono text-[var(--text-secondary)] tracking-wide mb-5">
              A queryable data warehouse of world knowledge.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="glass-panel-sm p-4 flex flex-col gap-2 border border-[var(--border-primary)]"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-[var(--cyan-primary)] shrink-0" />
                    <span className="text-[11px] font-mono font-bold text-[var(--text-heading)] tracking-wide">
                      {title}
                    </span>
                  </div>
                  <p className="text-[9.5px] leading-relaxed font-mono text-[var(--text-secondary)]">
                    {body}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-5 text-center text-[7px] font-mono text-[var(--text-muted)] tracking-widest">
              PRESS [ESC] OR CLICK OUTSIDE TO CLOSE
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

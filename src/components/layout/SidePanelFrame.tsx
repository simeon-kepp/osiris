'use client';

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface SidePanelFrameProps {
  children: ReactNode;
  className?: string;
  width?: 'narrow' | 'wide';
}

/** One geometry contract for right-side tools.
 *
 * The frame deliberately owns viewport height and overflow. Individual tools
 * own only their content. This prevents a transformed icon rail or a local
 * max-height from turning a full-height tool into a floating half-panel.
 */
export default function SidePanelFrame({ children, className = '', width = 'narrow' }: SidePanelFrameProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className={`fixed right-14 top-[72px] bottom-[64px] z-[220] flex min-h-0 flex-col pointer-events-none ${
        width === 'wide' ? 'w-[min(860px,68vw)]' : 'w-[min(460px,calc(100vw-4rem))]'
      } ${className}`}
    >
      <div className="h-full min-h-0 w-full overflow-y-auto styled-scrollbar pointer-events-auto">
        {children}
      </div>
    </motion.div>
  );
}

import type { IRDoc } from '../ir/types';

/** Shown in Remotion Studio (`npm run studio`) and used as the bundle's default props. */
export const SAMPLE_IR: IRDoc = {
  v: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 90,
  bg: '#0b0d12',
  fonts: [],
  scenes: [{ index: 0, id: 's0', start: 0, end: 90 }],
  layers: [
    {
      id: 's0',
      type: 'group',
      from: 0,
      to: 90,
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
      anchor: [0, 0],
      style: {},
      anims: [],
      children: [
        {
          id: 's0.t',
          type: 'text',
          from: 0,
          to: 90,
          x: 960,
          y: 540,
          anchor: [0.5, 0.5],
          style: { size: 140, weight: 800, color: '#f4f4f5' },
          text: 'MotionForge',
          split: 'chars',
          stagger: 2,
          anims: [{ s: 0, e: 18, unit: true, tracks: { opacity: [[0, 0], [1, 1, 'out']], dy: [[0, 60], [1, 0, 'snap']] } }],
        },
      ],
    },
  ],
};

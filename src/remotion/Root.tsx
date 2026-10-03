import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { IRPlayer, type IRPlayerProps } from './IRPlayer';
import { SAMPLE_IR } from './sample';

const calculateMetadata: CalculateMetadataFunction<IRPlayerProps> = ({ props }) => ({
  width: props.ir.width,
  height: props.ir.height,
  fps: props.ir.fps,
  durationInFrames: Math.max(1, props.ir.duration),
});

/** One generic composition: the video is entirely described by the `ir` input prop. */
export const Root: React.FC = () => (
  <Composition
    id="MotionForge"
    component={IRPlayer}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={90}
    defaultProps={{ ir: SAMPLE_IR, transparent: false }}
    calculateMetadata={calculateMetadata}
  />
);

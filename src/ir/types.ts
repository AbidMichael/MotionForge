/**
 * Render IR — the flat, renderer-agnostic description of a video.
 * Produced by the DSL compiler (Node) and consumed by the IRPlayer (browser bundle).
 * Every time value is in frames. Layer `from`/`to` are relative to the parent's start;
 * anim `s`/`e` are relative to the layer's start.
 */

export type Easing = string; // "linear" | "out" | "inOut" | "cubic(a,b,c,d)" | "spring(12)" | "steps(4)" ...

/** [t (0..1), value, easing into this keyframe] */
export type Keyframe = [number, number | string, Easing?];

export type ClipDir = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'circle';

export interface IRAnim {
  s: number;
  e: number;
  loop?: boolean;
  /** For split text: apply per unit with the layer's stagger. */
  unit?: boolean;
  clipDir?: ClipDir;
  tracks: Record<string, Keyframe[]>;
  /** Source preset (for motion summaries; ignored by the player). */
  n?: string;
}

export interface IRCounter {
  from: number;
  to: number;
  s: number;
  e: number;
  ease?: Easing;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  sep?: string;
}

export type IRLayerType =
  | 'text' | 'rect' | 'ellipse' | 'line' | 'path' | 'image' | 'video' | 'svg' | 'group'
  | 'connector' | 'chart' | 'map' | 'graph' | 'sim' | 'three';

/**
 * Piecewise-linear time map for groups (sub-compositions): layer-local frame → child frame.
 * Each segment is [lf0, lf1, cf0, cf1]; a pause is a segment with cf0 = cf1. Outside the
 * segments the child holds its last (or first) frame.
 */
export interface IRTime {
  segs: [number, number, number, number][];
}

export interface IRMarker {
  /** Absolute frame. */
  t: number;
  kind: 'scene' | 'transition' | 'click' | 'type' | 'drag' | 'cue' | 'sfx' | 'beat' | 'state';
  name?: string;
  /** Duration in frames (typing, drags). */
  d?: number;
  /** Sound attached directly (layer "sfx" field). */
  sfx?: string;
  gain?: number;
}

export interface IRFollow {
  id: string;
  /** Start frame of that layer relative to the connector's parent. */
  at: number;
}

export interface IREnd {
  rect: { x: number; y: number; w: number; h: number };
  follow?: IRFollow[];
}

export interface IRConnector {
  a: IREnd;
  b: IREnd;
  route: 'straight' | 'curve' | 'elbow' | 'auto';
  fromSide: 'top' | 'right' | 'bottom' | 'left' | 'auto';
  toSide: 'top' | 'right' | 'bottom' | 'left' | 'auto';
  gap: number;
  radius: number;
  curvature: number;
  obstacles: { x: number; y: number; w: number; h: number }[];
  stroke: string;
  width: number;
  dash?: string;
  arrow: 'end' | 'start' | 'both' | 'none';
  arrowSize: number;
  signal?: { color: string; size: number; every: number; travel: number; count: number; s: number; e: number; trail: number; glow?: string; dir: 1 | -1 };
  label?: { text: string; color: string; size: number; font: string; bg?: string };
}

export interface IRLayout {
  dir: 'row' | 'column';
  gap?: number;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  wrap?: boolean;
}

export interface IRLayer {
  id: string;
  type: IRLayerType;
  from: number;
  to: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Anchor in the layer box, 0..1. [0.5,0.5] = centre. */
  anchor: [number, number];
  rot?: number;
  scale?: number;
  opacity?: number;
  blend?: string;
  z?: number;
  clipDir?: ClipDir;
  /** Visual style (font, size, color, fill, stroke, radius, shadow…). */
  style: Record<string, string | number>;
  text?: string;
  split?: 'chars' | 'words' | 'lines';
  stagger?: number;
  counter?: IRCounter;
  src?: string;
  svg?: string;
  d?: string;
  viewBox?: string;
  points?: [number, number, number, number];
  layout?: IRLayout;
  overflow?: 'visible' | 'hidden';
  anims: IRAnim[];
  children?: IRLayer[];
  /** Debug/summary info: preset that produced this layer. */
  src_preset?: string;
  /** Group time remapping (sub-compositions). */
  time?: IRTime;
  /** Static CSS clip-path (masks: circle, ellipse, rounded rect, path). */
  mask?: string;
  /** User-facing name (from "id"), dotted inside named elements: "form.email". */
  name?: string;
  /** JSON pointer of the composition node this layer came from (visual editor). */
  ptr?: string;
  /** JSON pointer of the value this text came from (visual editor text edits). */
  textPtr?: string;
  /** Connector geometry (type connector). */
  conn?: IRConnector;
  /** Payload for chart / map / graph / sim / three layers (shape owned by each renderer). */
  data?: any;
  /** Compile-time effects resolved by scene/doc passes (sound on entry, beat sync). */
  fx?: { sfx?: { name: string; at: number; gain: number }; beat?: { kind: string; every: number; amount: number; on?: string } };
}

export interface IRFont {
  family: string;
  source: 'google' | 'url' | 'system';
  url?: string;
  weights?: number[];
}

export interface IRSceneInfo {
  index: number;
  id: string;
  preset?: string;
  start: number;
  end: number;
}

/** An audio track, mixed by the render job after the video is stitched. Times in frames. */
export interface IRAudio {
  kind: 'music' | 'sfx' | 'voice';
  src: string;
  /** Local file for the mixer (assets and built-in SFX). */
  file?: string;
  from: number;
  to?: number;
  /** Linear gain (1 = unchanged). */
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Seconds skipped at the start of the source. */
  trim?: number;
  loop?: boolean;
  /** Music only: lower it under voice tracks (dB of reduction). */
  duck?: number;
  /** Playback rate (pitch follows). */
  rate?: number;
}

export interface IRDoc {
  v: 1;
  width: number;
  height: number;
  fps: number;
  duration: number;
  bg: string;
  fonts: IRFont[];
  layers: IRLayer[];
  scenes: IRSceneInfo[];
  audio?: IRAudio[];
  markers?: IRMarker[];
}

export const IR_PLAYER_VERSION = '2.0.0';

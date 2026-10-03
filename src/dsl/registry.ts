/**
 * Extension points of the compiler. Feature modules (sub-compositions, states, gestures,
 * connectors, charts, 3D…) register themselves here; compile.ts calls them.
 * Only types are imported from compile.ts, so there is no runtime import cycle.
 */
import type { IRDoc, IRLayer } from '../ir/types';
import type { Scope } from './expr';
import type { AliasCtx, DirectionSpec, Session, SlotMap, TransitionRun } from './compile';
import type { LayoutMap } from './layoutmap';

export interface NodeCtx {
  /** The node with params/tokens/expressions bound (children/layer/slots left raw). */
  node: Record<string, any>;
  raw: Record<string, any>;
  /** Placement and timing already resolved: id, from, to, x, y, w, h, anchor, rot, scale, opacity, z… */
  base: Partial<IRLayer>;
  scope: Scope;
  actx: AliasCtx;
  lenFrames: number;
  lenSec: number;
  path: string;
  slots: SlotMap;
  id: string;
  stagger: { frames: number };
}

export interface LayerHandler {
  /** Keys this type reads (they are not copied into style). */
  keys: string[];
  compile: (S: Session, c: NodeCtx) => IRLayer[];
}

export const layerHandlers = new Map<string, LayerHandler>();

export function registerLayer(type: string, h: LayerHandler) {
  layerHandlers.set(type, h);
}

export interface SceneCtx {
  index: number;
  entry: Record<string, any>;
  path: string;
  group: IRLayer;
  frames: number;
  scope: Scope;
  actx: AliasCtx;
  /** Lazily built static layout of the scene (call S.sceneLayout(sc)). */
  layout?: LayoutMap;
}

export interface ScenePass {
  name: string;
  /** Lower runs first. pre-passes run before the scene's layers are compiled. */
  order: number;
  pre?: (S: Session, sc: { entry: Record<string, any>; path: string; frames: number; index: number; actx: AliasCtx }) => void;
  post?: (S: Session, sc: SceneCtx) => void;
}

export const scenePasses: ScenePass[] = [];

export function registerScenePass(p: ScenePass) {
  scenePasses.push(p);
  scenePasses.sort((a, b) => a.order - b.order);
}

/** Runs after the timeline is built (transitions with continuity, audio, beats). */
export interface DocPass {
  name: string;
  order: number;
  run: (S: Session, doc: { ir: IRDoc; comp: Record<string, any>; scenes: SceneCtx[]; starts: number[] }) => void;
}

export const docPasses: DocPass[] = [];

export function registerDocPass(p: DocPass) {
  docPasses.push(p);
  docPasses.sort((a, b) => a.order - b.order);
}

/** Hooks filled by feature modules (continuity transitions, music snapping, art direction). */
export const hooks: {
  continuity?: (S: Session, t: TransitionRun) => void;
  snap?: (S: Session, comp: Record<string, any>, plan: { frames: number[]; overlaps: number[]; mins: number[] }) => number[] | null;
  direction?: (S: Session, ref: unknown, actx: AliasCtx) => DirectionSpec | null;
} = {};

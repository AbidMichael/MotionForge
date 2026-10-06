import { createContext } from 'react';
import type { IRLayer } from '../ir/types';

/** Every layer of the document by id (connectors follow moving boxes). */
export const LayerIndex = createContext<Map<string, IRLayer>>(new Map());

/** Render-wide hints: draft renders and previews skip the expensive 3D effects. */
export const RenderHints = createContext<{ draft: boolean }>({ draft: false });

import { createContext } from 'react';
import type { IRLayer } from '../ir/types';

/** Every layer of the document by id (connectors follow moving boxes). */
export const LayerIndex = createContext<Map<string, IRLayer>>(new Map());

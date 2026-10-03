import React from 'react';
import type { ChannelState } from '../ir/evaluate';
import type { IRLayer } from '../ir/types';
import { ConnectorView } from './connector';
import { ChartView } from './charts';
import { SimView } from './sim';
import { ThreeView } from './three';

/** Layer types beyond the basic primitives. */
export const ExtraLayer: React.FC<{ layer: IRLayer; lf: number; st: ChannelState; wrapper: React.CSSProperties }> = ({ layer, lf, st, wrapper }) => {
  switch (layer.type) {
    case 'connector':
      return (
        <div style={{ ...wrapper, left: 0, top: 0, transform: undefined }}>
          <ConnectorView layer={layer} lf={lf} st={st} />
        </div>
      );
    case 'chart':
    case 'map':
    case 'graph':
      return (
        <div style={{ ...wrapper, width: layer.w, height: layer.h }}>
          <ChartView layer={layer} lf={lf} st={st} />
        </div>
      );
    case 'sim':
      return (
        <div style={{ ...wrapper, width: layer.w, height: layer.h }}>
          <SimView layer={layer} lf={lf} st={st} />
        </div>
      );
    case 'three':
      return (
        <div style={{ ...wrapper, width: layer.w, height: layer.h }}>
          <ThreeView layer={layer} lf={lf} />
        </div>
      );
    default:
      return null;
  }
};

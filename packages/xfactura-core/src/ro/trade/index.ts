import { euAcquisitionRecognition } from './acquisition';
import { exportRecognition } from './export';
import { importRecognition } from './import';
import { euSupplyRecognition } from './supply';

export * from './codes';
export * from './documents';
export * from './parameters';
export * from './proof';
export * from './supply';
export * from './export';
export * from './acquisition';
export * from './import';
export * from './intrastat';
export * from './etransport';
export * from './questions';
export * from './closure';
export * as agent from './agent';

/** The treatments of goods across the border (G3). */
export const tradeTreatments = [
  euSupplyRecognition,
  euAcquisitionRecognition,
  importRecognition,
  exportRecognition,
] as const;

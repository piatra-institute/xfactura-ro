import { receiptInvoiceRecognition } from './invoiced';
import { retailMethodTreatments } from './retail';
import { zReportRecognition } from './zreport';

export * from './accounts';
export * from './b2c';
export * from './documents';
export * from './invoiced';
export * from './parameters';
export * from './questions';
export * from './retail';
export * from './zreport';

/** Every treatment of retail and B2C (G2), as the engine adds them. */
export const retailTreatments = [
  zReportRecognition,
  receiptInvoiceRecognition,
  ...retailMethodTreatments,
] as const;

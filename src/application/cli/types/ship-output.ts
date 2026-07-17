import type { Receipt } from "../../../core/types/receipt.js";

export interface ShipOutputs {
  readonly receipt: Receipt;
  readonly prUrl: string;
  readonly prNumber: number;
  readonly branch: string;
}

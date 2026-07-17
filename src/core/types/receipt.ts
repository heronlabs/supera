export type VerificationValue = "pass" | "fail" | "skipped";

export interface Receipt {
  readonly summary: string;
  readonly filesChanged: string[];
  readonly verification: Record<string, VerificationValue>;
  readonly notes?: string;
}

export function receiptAllPass(receipt: Receipt): boolean {
  return Object.values(receipt.verification).every(
    (v) => v === "pass" || v === "skipped",
  );
}

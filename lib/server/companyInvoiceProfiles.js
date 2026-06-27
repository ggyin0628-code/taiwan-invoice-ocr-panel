const configuredSellerTaxIds = String(process.env.EXCLUDED_SELLER_TAX_IDS || "")
  .split(/[\s,;]+/)
  .map((value) => value.replace(/\D/g, ""))
  .filter((value) => /^\d{8}$/.test(value));

export const DEFAULT_BUYER_TAX_ID = String(process.env.DEFAULT_BUYER_TAX_ID || "").replace(/\D/g, "").slice(0, 8);
export const EXCLUDED_SELLER_TAX_IDS = new Set(configuredSellerTaxIds);

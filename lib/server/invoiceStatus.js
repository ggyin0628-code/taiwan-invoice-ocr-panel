export const REVIEW_STATUS = Object.freeze({
  AUTO_OK: "AUTO_OK",
  REVIEW_RECOMMENDED: "REVIEW_RECOMMENDED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  INVALID: "INVALID",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  FAILED: "FAILED"
});

const INFORMATIONAL_WARNINGS = new Set([
  "PaddleOCR 僅供初步填入，仍需人工確認",
  "ollama_disabled"
]);

const REVIEW_RECOMMENDED_WARNINGS = new Set([
  "buyer_tax_id_needs_review",
  "ocr_amount_mismatch",
  "quantity_inferred_from_amount_reference",
  "quantity_corrected_from_amount_reference"
]);

export function isInformationalWarning(value) {
  const warning = String(value || "").trim();
  return INFORMATIONAL_WARNINGS.has(warning);
}

export function isReviewRecommendedWarning(value) {
  const warning = String(value || "").trim();
  return REVIEW_RECOMMENDED_WARNINGS.has(warning)
    || warning.startsWith("金額參考欄與公式不一致");
}

export function meaningfulWarnings(warnings = []) {
  return [...new Set((Array.isArray(warnings) ? warnings : [])
    .map((warning) => String(warning || "").trim())
    .filter(Boolean)
    .filter((warning) => !isInformationalWarning(warning)))];
}

export function deriveReviewStatus({
  validationErrors = [],
  fieldStatuses = {},
  warnings = [],
  providerUnavailable = false,
  failed = false
} = {}) {
  if (failed) return REVIEW_STATUS.FAILED;
  if (providerUnavailable) return REVIEW_STATUS.PROVIDER_UNAVAILABLE;

  const errors = Array.isArray(validationErrors) ? validationErrors : [];
  if (errors.some((error) => error?.severity === "invalid" || error?.status === "invalid")) {
    return REVIEW_STATUS.INVALID;
  }
  if (errors.length || Object.values(fieldStatuses).some((status) => status === "manual_required")) {
    return REVIEW_STATUS.REVIEW_REQUIRED;
  }

  const hasLowConfidence = Object.values(fieldStatuses).some((status) => status === "low_confidence");
  const hasReviewWarning = meaningfulWarnings(warnings).some(isReviewRecommendedWarning);
  if (hasLowConfidence || hasReviewWarning) return REVIEW_STATUS.REVIEW_RECOMMENDED;
  return REVIEW_STATUS.AUTO_OK;
}

export function legacyProcessingStatus(reviewStatus) {
  switch (reviewStatus) {
    case REVIEW_STATUS.AUTO_OK:
      return "done";
    case REVIEW_STATUS.PROVIDER_UNAVAILABLE:
      return "provider_unavailable";
    case REVIEW_STATUS.FAILED:
      return "failed";
    case REVIEW_STATUS.REVIEW_RECOMMENDED:
    case REVIEW_STATUS.REVIEW_REQUIRED:
    case REVIEW_STATUS.INVALID:
    default:
      return "need_review";
  }
}

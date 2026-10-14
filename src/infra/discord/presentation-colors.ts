/** Semantic accents for bot-authored embeds and cards. */
export const EMBED_COLORS = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  neutral: 0x99aab5,
  error: 0xed4245,
  celebration: 0x9b59b6,
} as const;

/** Source identity accents for social previews, independent of operation status. */
export const SOCIAL_COLORS = {
  facebook: 0x1877f2,
  x: 0x1d9bf0,
} as const;

/**
 * CWA earthquake report severity, mirroring the agency's own report
 * colours so a reader who knows the CWA scale recognises the level.
 */
export const EARTHQUAKE_REPORT_COLORS = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
} as const;

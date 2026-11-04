export type UsageLocale = "en" | "ru";

export type UsageResetInput = {
  resetsAt?: number | null;
  periodLabel?: string | null;
};

export type ExtraTokensInput = {
  extraTokensBalance?: number | null;
  extraTokensTotal?: number | null;
  extraTokensLeftLabel?: string | null;
};

function toMs(resetsAt: number): number {
  return resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
}

export function formatUsageReset(usage: UsageResetInput | null | undefined, locale: UsageLocale): string {
  if (!usage) return "";
  if (typeof usage.resetsAt === "number" && Number.isFinite(usage.resetsAt)) {
    return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
      day: "numeric",
      month: "short",
    }).format(new Date(toMs(usage.resetsAt)));
  }
  if (locale === "en" && usage.periodLabel) return usage.periodLabel;
  return "";
}

export function formatExtraTokens(usage: ExtraTokensInput | null | undefined, locale: UsageLocale): string {
  if (!usage) return "";
  const total = usage.extraTokensTotal;
  const balance = usage.extraTokensBalance;
  if (typeof total === "number" && total > 0 && typeof balance === "number") {
    const used = Math.round(((total - balance) / total) * 100);
    return locale === "ru" ? `${used}% использовано` : `${used}% used`;
  }
  if (locale === "en" && usage.extraTokensLeftLabel) return usage.extraTokensLeftLabel;
  return "";
}

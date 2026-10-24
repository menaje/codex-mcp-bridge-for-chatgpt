/** Settings choices describe speeds; legacy scope remains in the saved data. */
export function settingsSpeedChoices(available?: string[]): string[] {
  return ["standard", "fast", "ultrafast"].filter(speed => available?.includes(speed));
}

/** A display projection must never rewrite the saved speed or infer inheritance. */
export function settingsSpeedSelection(mode: string | undefined, legacyFast: boolean, available?: string[]): string {
  const speed = !mode || mode === "legacy" ? legacyFast ? "fast" : "standard" : mode;
  return ["standard", "fast", "ultrafast"].includes(speed) && available?.includes(speed) ? speed : "";
}

export type IndependentProfileStorage = { storageId: string; root: string; sqliteHome: string };
export function executionStorageRoot(runtimeHome: string): string;
export function createIndependentProfileStorage(runtimeHome: string, profileHome: string): Promise<IndependentProfileStorage>;
export function independentProfileStorage(runtimeHome: string, profileHome: string, storageId: string): IndependentProfileStorage;

export interface NativeInputEntry { id: string; kind: string; session: string; field: string; }
export function inspectInputs(source: string, file?: string): NativeInputEntry[];
export function checkInventory(actual: NativeInputEntry[], expected: NativeInputEntry[]): void;

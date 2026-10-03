export type AuthConnection = { kind: "shared" | "disconnected" } |
  { kind: "external"; homeId: string } |
  { kind: "bridge-chatgpt" | "bridge-api"; profileId: string };
export function authSelectionRoot(environment?: NodeJS.ProcessEnv): string;
export function authProfileHome(root: string, profileId: string): string;
export function authProfileEnvironment(root: string, profileId: string, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function assertAuthProfileStorageEnvironment(environment: NodeJS.ProcessEnv): void;
export function knownExternalHome(state: { knownHomes?: Array<{ id: string; home: string; canonicalHome: string }> } | null,
  homeId: string): string;
export function readAuthSelection(environment?: NodeJS.ProcessEnv): {
  schemaVersion: number;
  revision: number;
  generation?: number;
  knownHomes?: Array<{ id: string; home: string; canonicalHome: string }>;
  profiles?: Array<{ id: string; storageId?: string }>;
  applied: AuthConnection;
  pending: AuthConnection | null;
  activation?: {
    id: string;
    from: AuthConnection;
    to: AuthConnection;
    generation: number;
    status: "starting" | "uncertain";
    startedAt?: string;
  } | null;
} | null;
export function desiredAuthConnection(environment?: NodeJS.ProcessEnv): AuthConnection;
export function desiredAuthSelection(environment?: NodeJS.ProcessEnv): {
  connection: AuthConnection;
  generation: number;
};

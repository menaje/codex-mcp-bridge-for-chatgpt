export type AuthConnection = { kind: "shared" | "disconnected" } |
  { kind: "bridge-chatgpt" | "bridge-api"; profileId: string };
export function authSelectionRoot(environment?: NodeJS.ProcessEnv): string;
export function authProfileHome(root: string, profileId: string): string;
export function readAuthSelection(environment?: NodeJS.ProcessEnv): {
  schemaVersion: number;
  revision: number;
  generation?: number;
  applied: AuthConnection;
  pending: AuthConnection | null;
  activation?: {
    id: string;
    from: AuthConnection;
    to: AuthConnection;
    generation: number;
    status: "starting" | "uncertain";
  } | null;
} | null;
export function desiredAuthConnection(environment?: NodeJS.ProcessEnv): AuthConnection;
export function desiredAuthSelection(environment?: NodeJS.ProcessEnv): {
  connection: AuthConnection;
  generation: number;
};

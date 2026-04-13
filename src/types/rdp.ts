export type RdpSessionId = string;

export type RdpConnectionStatus =
  | "Connecting"
  | "Connected"
  | "Disconnecting"
  | "Disconnected"
  | "Error";

export interface RdpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  width: number;
  height: number;
}

export interface RdpConnectResult {
  session_id: string;
  ws_port: number;
}

export interface RdpStatusPayload {
  session_id: string;
  status: RdpConnectionStatus;
  message?: string;
}

export interface RdpMouseInput {
  x: number;
  y: number;
  button?: string;
  pressed: boolean;
  wheel_delta?: number;
}

export interface RdpKeyInput {
  scancode: number;
  extended: boolean;
  pressed: boolean;
}

export interface RdpSession {
  id: RdpSessionId;
  config: RdpConfig;
  status: RdpConnectionStatus;
  statusMessage?: string;
  label: string;
  wsPort: number;
}

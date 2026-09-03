export type ProxyProtocol = "http" | "https" | "socks5";

export interface AresProxy {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxySelection {
  mode: "profile-default" | "direct" | "proxy";
  proxyId?: string;
}

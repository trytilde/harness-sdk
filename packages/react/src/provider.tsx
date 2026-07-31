import { type Client, type Config, createClient } from "@trytilde/harness-sdk";
import { createContext, type ReactNode, useContext, useMemo } from "react";

const TildeContext = createContext<Client | null>(null);

export type TildeProviderProps = {
  children: ReactNode;
  client?: Client;
  config?: Config;
};

export function TildeProvider({
  children,
  client,
  config,
}: TildeProviderProps) {
  const value = useMemo(() => {
    if (client) {
      return client;
    }
    if (!config) {
      throw new TypeError("TildeProvider requires client or config");
    }
    return createClient(config);
  }, [client, config]);

  return (
    <TildeContext.Provider value={value}>{children}</TildeContext.Provider>
  );
}

export function useTildeClient(): Client {
  const client = useContext(TildeContext);
  if (!client) {
    throw new TypeError("useTildeClient must be used within TildeProvider");
  }
  return client;
}

import type { ConsoleConfig } from '@/api/types';

/** The MCP endpoint shown to users: the configured address, or this console's own origin. */
export function mcpEndpoint(config: ConsoleConfig | undefined, origin: string): string {
  return config?.mcp_url ?? `${origin}/mcp`;
}

/**
 * True when the platform does not serve MCP itself and the configured address is not
 * on this console's origin, so reaching the console says nothing about reaching MCP.
 */
export function mcpOnSeparateAddress(config: ConsoleConfig | undefined, origin: string): boolean {
  if (!config?.public_mcp_disabled) return false;
  if (!config.mcp_url) return true;
  try {
    return new URL(config.mcp_url).origin !== origin;
  } catch {
    return true;
  }
}

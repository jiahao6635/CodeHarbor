import { describe, expect, it } from 'vitest';
import { mcpEndpoint, mcpOnSeparateAddress } from './mcp';

const origin = 'https://codegraph.sigmob.com';

describe('MCP address hints', () => {
  it('uses the configured address, falling back to this origin', () => {
    expect(mcpEndpoint({ mcp_url: 'http://10.0.0.2:18080/mcp', public_mcp_disabled: true }, origin)).toBe(
      'http://10.0.0.2:18080/mcp',
    );
    expect(mcpEndpoint({ mcp_url: null, public_mcp_disabled: false }, origin)).toBe(`${origin}/mcp`);
    expect(mcpEndpoint(undefined, origin)).toBe(`${origin}/mcp`);
  });

  it('warns only when MCP is not served on the console origin', () => {
    expect(mcpOnSeparateAddress(undefined, origin)).toBe(false);
    expect(mcpOnSeparateAddress({ mcp_url: null, public_mcp_disabled: false }, origin)).toBe(false);
    expect(mcpOnSeparateAddress({ mcp_url: `${origin}/mcp`, public_mcp_disabled: true }, origin)).toBe(false);
    expect(mcpOnSeparateAddress({ mcp_url: 'http://10.0.0.2:18080/mcp', public_mcp_disabled: true }, origin)).toBe(
      true,
    );
    expect(
      mcpOnSeparateAddress({ mcp_url: 'http://codegraph.sigmob.com/mcp', public_mcp_disabled: true }, origin),
    ).toBe(true);
    expect(mcpOnSeparateAddress({ mcp_url: null, public_mcp_disabled: true }, origin)).toBe(true);
    expect(mcpOnSeparateAddress({ mcp_url: 'not a url', public_mcp_disabled: true }, origin)).toBe(true);
  });
});

/** Limit the number of query containers for both the gateway and controller. */
export function queryConcurrency(value?: string): number {
  if (value === undefined) return 10;
  if (!/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(value)) throw new Error('Invalid MCP query concurrency');
  return Number(value);
}

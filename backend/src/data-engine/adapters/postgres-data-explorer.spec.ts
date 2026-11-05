import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresDataExplorer } from './postgres-data-explorer.js';

const mocks = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Client: vi.fn(function (config: Record<string, unknown>) {
    mocks.clients.push(config);
    return { connect: mocks.connect, query: mocks.query, end: mocks.end };
  }),
}));

describe('PostgresDataExplorer', () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.query.mockReset().mockResolvedValue({
      rows: [{ schema: 'public', name: 'customers', type: 'BASE TABLE' }],
    });
    mocks.end.mockReset().mockResolvedValue(undefined);
  });

  it('uses the connection record dbName even when the URL contains another database', async () => {
    const explorer = new PostgresDataExplorer();

    const objects = await explorer.listObjects(
      'postgres://user:secret@db.internal/db_from_url?sslmode=disable',
      'db_from_record',
    );

    const clientConfig = mocks.clients[0];
    expect(clientConfig.connectionString).toBe(
      'postgres://user:secret@db.internal/db_from_record?sslmode=disable',
    );
    expect(objects).toEqual([{ schema: 'public', name: 'customers', type: 'TABLE' }]);
    await explorer.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});

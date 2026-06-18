import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {describe, expect, it} from 'vitest';

const repoRoot = join(__dirname, '..');

const compileSuperaSchema = () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, 'schema', 'supera.schema.json'), 'utf8'),
  );
  const ajv = new Ajv2020({strict: false});
  addFormats(ajv);
  return ajv.compile(schema);
};

const ticketlessConfig = {
  stack: 'pnpm',
  verify: {test: 'pnpm test:unit'},
  tracker: null,
};

const fullTrackerConfig = {
  stack: 'pnpm',
  verify: {
    install: 'pnpm install --frozen-lockfile',
    test: 'pnpm test:unit',
    lint: 'pnpm lint:check',
  },
  tracker: {
    provider: 'clickup',
    board: '901415284967',
    statuses: {
      ready: 'pending',
      building: 'in progress',
      review: 'in review',
      blocked: 'blocked',
      rejected: 'rejected',
      closed: 'Closed',
    },
    tools: {
      getTicket: 'clickup_get_task',
      createTicket: 'clickup_create_task',
      setStatus: 'clickup_update_task',
      updateFields: 'clickup_update_task',
      comment: 'clickup_create_comment',
      deleteTicket: 'clickup_delete_task',
    },
  },
};

describe('supera config validation', () => {
  it('accepts the repo own .claude/supera.json', () => {
    const validate = compileSuperaSchema();
    const config = JSON.parse(
      readFileSync(join(repoRoot, '.claude', 'supera.json'), 'utf8'),
    );
    expect(validate(config)).toBe(true);
  });

  it('accepts a ticket-less config with tracker null', () => {
    const validate = compileSuperaSchema();
    expect(validate(ticketlessConfig)).toBe(true);
  });

  it('accepts a full tracker config with statuses and tools', () => {
    const validate = compileSuperaSchema();
    expect(validate(fullTrackerConfig)).toBe(true);
  });

  it('rejects a config with an unknown top-level key', () => {
    const validate = compileSuperaSchema();
    const config = {...ticketlessConfig, unknownKey: true};
    expect(validate(config)).toBe(false);
  });

  it('rejects a tracker.tools map with an unknown op', () => {
    const validate = compileSuperaSchema();
    const config = {
      ...fullTrackerConfig,
      tracker: {
        ...fullTrackerConfig.tracker,
        tools: {
          ...fullTrackerConfig.tracker.tools,
          archiveTicket: 'clickup_archive_task',
        },
      },
    };
    expect(validate(config)).toBe(false);
  });
});

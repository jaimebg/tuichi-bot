import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { log, setLogLevel, getLogLevel, isDebugEnabled } from '../../src/logger.js';

describe('logger', () => {
  beforeEach(() => { setLogLevel('info'); });

  it('defaults to info level', () => {
    assert.equal(getLogLevel(), 'info');
  });

  it('sets valid log levels', () => {
    setLogLevel('debug');
    assert.equal(getLogLevel(), 'debug');
    assert.equal(isDebugEnabled(), true);
  });

  it('falls back to info for invalid levels', () => {
    setLogLevel('bogus');
    assert.equal(getLogLevel(), 'info');
  });

  it('isDebugEnabled returns false when not debug', () => {
    setLogLevel('warn');
    assert.equal(isDebugEnabled(), false);
  });
});

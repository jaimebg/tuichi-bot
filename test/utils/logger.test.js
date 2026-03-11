import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log, setLogLevel, getLogLevel, isDebugEnabled, setErrorObserver } from '../../src/logger.js';

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

describe('Logger error observer', () => {
  afterEach(() => { setErrorObserver(null); });

  it('calls observer on log error', () => {
    const errors = [];
    setErrorObserver((msg) => errors.push(msg));
    setLogLevel('error');
    log('error', 'test failure');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('test failure'));
    setLogLevel('info');
  });

  it('does not call observer on non-error levels', () => {
    const errors = [];
    setErrorObserver((msg) => errors.push(msg));
    log('info', 'just info');
    log('warn', 'just warn');
    assert.equal(errors.length, 0);
  });

  it('handles null observer gracefully', () => {
    setErrorObserver(null);
    log('error', 'no crash');
  });
});

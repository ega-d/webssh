const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../../static/js/ssh-session-recovery.js');

function setup(session) {
    const notices = [], cleaned = [], cancelled = [];
    const recovery = create({
        sessions: {
            getSession: () => session,
            updateSessionStatus(_id, status) { if (session) session.connected = status !== 'disconnected'; },
        },
        cancelInput: id => cancelled.push(id),
        disconnectFiles: id => cleaned.push(id),
        notify: message => notices.push(message),
        disconnectedMessage: reason => reason,
        unavailableMessage: () => 'Reconnect',
    });
    return {handler: recovery.handleDisconnected, handleUnavailable: recovery.handleUnavailable, notices, cleaned, cancelled};
}

test('disconnect acknowledgements do not warn after the user has closed a session', () => {
    const {handler, notices, cleaned} = setup(null);
    handler({session_id: 'closed', reason: 'Connection closed'});
    handler({session_id: 'closed', reason: 'User requested disconnect'});
    assert.equal(notices.length, 0);
    assert.equal(cleaned.length, 2);
});

test('unexpected disconnect warns once while still updating session and file state', () => {
    const session = {connected: true};
    const {handler, notices, cleaned} = setup(session);
    handler({session_id: 'live', reason: 'Connection closed'});
    handler({session_id: 'live', reason: 'Connection closed'});
    assert.equal(notices.length, 1);
    assert.equal(session.connected, false);
    assert.equal(cleaned.length, 2);
});

test('a typed stale SSH error cancels the input and files exactly once', () => {
    const session = {connected: true};
    const {handleUnavailable, notices, cleaned, cancelled} = setup(session);
    assert.equal(handleUnavailable({session_id: 'live', code: 'ssh_input_backpressure'}), false);
    assert.equal(session.connected, true);
    const stale = {session_id: 'live', code: 'ssh_session_unavailable'};
    assert.equal(handleUnavailable(stale), true);
    assert.equal(handleUnavailable(stale), true);
    assert.equal(session.connected, false);
    assert.deepEqual(notices, ['Reconnect']);
    assert.deepEqual(cleaned, ['live']);
    assert.deepEqual(cancelled, ['live']);
    console.info('Stale session cancelled queued input and cleaned file state once.');
});

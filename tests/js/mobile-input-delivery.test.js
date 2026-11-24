const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createSubmit} = require('../../static/js/terminal-composer.js');

function setup(send, connected = true) {
    const session = {id: 's', host: 'alpha.example', username: 'ops', connected};
    const elements = new Map();
    const context = {mobileInput: {value: 'original'}, SessionManager: {
        getActiveSession: () => 's', getSession: () => session, getActiveTerminal: () => null,
    }, window: {socket: {connected}, SSHInput: {sendPrompt: send}},
        document: {
            addEventListener(event, callback) { if (event === 'DOMContentLoaded') callback(); },
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {dataset: {}, listeners: {}, checked: false, focus() {},
                    addEventListener(event, callback) {this.listeners[event] = callback;},
                    showModal() {this.open = true;}, close() {this.open = false;}});
                return elements.get(id);
            }
        }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../static/js/terminal-paste-guard.js'), 'utf8'), context);
    context.send = createSubmit({
        input: context.mobileInput,
        sessions: context.SessionManager,
        connected: () => context.window.socket.connected,
        sendAttachment: (...args) => context.window.TerminalComposerAttachment?.send(...args),
        pasteGuard: context.window.TerminalPasteGuard,
        transport: context.window.SSHInput,
    });
    return context;
}

test('mobile input remains editable after offline or rejected delivery', async () => {
    for (const connected of [false, true]) {
        const context = setup(async () => false, connected);
        await context.send();
        assert.equal(context.mobileInput.value, 'original');
    }
});

test('repeated mobile submit cannot duplicate an in-flight command and failures can retry', async () => {
    let finish;
    let calls = 0;
    const context = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const pending = context.send();
    const repeated = context.send();
    assert.equal(calls, 1);
    finish(false);
    await Promise.all([pending, repeated]);
    context.window.SSHInput.sendPrompt = async () => { calls++; return true; };
    await context.send();
    assert.equal(calls, 2);
    assert.equal(context.mobileInput.value, '');
});

test('successful mobile delivery clears only the submitted text', async () => {
    let acknowledge;
    const context = setup(() => new Promise(resolve => { acknowledge = resolve; }));
    const pending = context.send();
    context.mobileInput.value = 'new text';
    acknowledge(true);
    await pending;
    assert.equal(context.mobileInput.value, 'new text');
    context.window.SSHInput.sendPrompt = async () => true;
    await context.send();
    assert.equal(context.mobileInput.value, '');
});

test('mobile multiline submit sends through text transport only after review', async () => {
    const delivered = [];
    const context = setup(async (id, value) => { delivered.push([id, value]); return true; });
    context.mobileInput.value = 'first\nsecond';
    const pending = context.send();
    assert.deepEqual(delivered, []);
    assert.equal(context.document.getElementById('terminalPasteDialog').open, true);
    await context.document.getElementById('terminalPasteConfirm').listeners.click();
    await pending;
    assert.deepEqual(delivered, [['s', 'first\nsecond']]);
});

test('cancelled mobile review preserves the draft and sends nothing', async () => {
    const delivered = [];
    const context = setup(async (id, value) => {delivered.push([id, value]); return true;});
    context.mobileInput.value = 'first\nsecond';
    const pending = context.send();
    context.document.getElementById('terminalPasteCancel').listeners.click();
    await pending;
    assert.deepEqual(delivered, []);
    assert.equal(context.mobileInput.value, 'first\nsecond');
});

test('the send button sends Enter on an empty prompt only to a connected terminal', async () => {
    const context = setup(() => assert.fail('The text-only transport was called'));
    const delivered = [];
    context.mobileInput.value = '';
    context.window.SSHInput.send = (id, value) => delivered.push([id, value]);

    await context.send();
    assert.deepEqual(delivered, [['s', '\r']]);

    context.SessionManager.getSession('s').connected = false;
    await context.send();
    context.SessionManager.getSession('s').connected = true;
    context.window.socket.connected = false;
    await context.send();
    assert.deepEqual(delivered, [['s', '\r']]);
});

test('attachment delivery accepts an empty prompt without sending a terminal command', async () => {
    const context = setup(() => assert.fail('The text-only transport was called'));
    context.window.SSHInput.send = () => assert.fail('Enter was sent with the attachment');
    context.mobileInput.value = '';
    const delivered = [];
    context.window.TerminalComposerAttachment = {
        send(sessionId, prompt) {
            delivered.push([sessionId, prompt]);
            return Promise.resolve(true);
        },
    };
    await context.send();
    assert.deepEqual(delivered, [['s', '']]);
});

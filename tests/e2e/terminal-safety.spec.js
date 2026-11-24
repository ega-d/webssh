const {test, expect} = require('playwright/test');
const {login, openWorkspace} = require('./helpers');

async function setup(page) {
    await login(page);
    await page.evaluate(() => {
        const emit = window.socket.emit.bind(window.socket);
        window.__terminalInputs = [];
        window.socket.emit = (event, payload, ...rest) => {
            if (payload?.session_id?.startsWith('safe-')) {
                if (event === 'ssh_input') window.__terminalInputs.push(payload);
                rest.find(value => typeof value === 'function')?.({success: true});
                return window.socket;
            }
            return emit(event, payload, ...rest);
        };
    });
    await connect(page, 'safe-one', 'alpha.example');
}
async function connect(page, id, host) {
    await page.evaluate(({id, host}) => {
        window.socket.listeners('ssh_connected').forEach(listener => listener({session_id: id, host,
            port: 22, username: 'ops', client_request_id: `reconnect_${id}`}));
    }, {id, host});
    await expect(page.locator(`#tab-${id}`)).toBeVisible();
}
async function nativePaste(page, text, selector = '#terminal-safe-one .xterm-helper-textarea') {
    await page.locator(selector).evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        element.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData}));
    }, text);
}
async function inputs(page) { return page.evaluate(() => window.__terminalInputs); }

async function restoredComposer(page, {interruptInput = false} = {}) {
    await page.setViewportSize({width: 393, height: 820});
    await login(page);
    const seeded = await page.evaluate(interruptInput => new Promise(resolve => {
        window.socket.emit('e2e_workspace_restore', {count: 1, interrupt_input: interruptInput}, resolve);
    }), interruptInput);
    expect(seeded.ok).toBe(true);
    const [id] = seeded.session_ids;
    await page.reload();
    await openWorkspace(page);
    await expect(page.locator(`#terminal-${id}`)).toBeVisible();
    await page.locator('#mobileCommandToggle').click();
    await page.evaluate(id => {
        window.__terminalInputs = [];
        window.socket.onAnyOutgoing((event, payload) => {
            if (event === 'ssh_input' && payload.session_id === id) window.__terminalInputs.push(payload);
        });
    }, id);
    return id;
}

async function clearRestoredComposer(page) {
    await page.evaluate(() => new Promise(resolve => {
        window.socket.emit('e2e_workspace_restore', {count: 0}, resolve);
    }));
}

test('native terminal paste previews unsafe text and cancellation sends nothing', async ({page}) => {
    await setup(page);
    await nativePaste(page, 'echo safe\necho <img src=x>\u001b[31m\n');
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await expect(page.locator('#terminalPastePreview')).toContainText('[ESC]');
    await expect(page.locator('#terminalPastePreview img')).toHaveCount(0);
    expect(await inputs(page)).toEqual([]);
    await page.locator('#terminalPasteCancel').click();
    expect(await inputs(page)).toEqual([]);
});

test('safe single-line paste stays fast and confirmed paste preserves bracketed mode', async ({page}) => {
    await setup(page);
    await nativePaste(page, 'pwd');
    expect((await inputs(page)).map(item => item.data)).toEqual(['pwd']);
    await page.evaluate(() => new Promise(resolve => TerminalManager.terminals['safe-one'].write('\u001b[?2004h', resolve)));
    await nativePaste(page, 'one\r\ntwo\n');
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await page.locator('#terminalPasteTrim').check();
    await page.locator('#terminalPasteConfirm').click();
    expect((await inputs(page)).map(item => item.data)).toEqual(['pwd', '\u001b[200~one\rtwo\u001b[201~']);
});

test('composer Ctrl+Enter edits the draft and Enter submits after the paste', async ({page}) => {
    await page.setViewportSize({width: 393, height: 820});
    await setup(page);
    await page.locator('#mobileCommandToggle').click();
    await page.evaluate(() => new Promise(resolve => {
        SessionManager.getActiveTerminal().write('\u001b[?2004h', resolve);
    }));
    const input = page.locator('#mobileInput');
    await input.fill('first');
    await input.press('End');
    await input.press('Control+Enter');
    await expect(input).toHaveValue('first\n');
    expect(await inputs(page)).toEqual([]);
    console.info('Ctrl+Enter inserted LF without sending SSH input');
    await input.pressSequentially('second');
    await input.press('Enter');
    await page.locator('#terminalPasteConfirm').click();
    await expect(input).toHaveValue('');
    const delivered = (await inputs(page)).map(item => item.data);
    console.info('Enter submitted one bracketed prompt:', JSON.stringify(delivered));
    expect(delivered).toEqual(['\u001b[200~first\rsecond\u001b[201~\r']);
});

test('a stale terminal stops sending and shows one reconnect notice without losing the draft', async ({page}) => {
    const id = await restoredComposer(page);
    try {
        const dropped = await page.evaluate(id => new Promise(resolve => {
            window.socket.emit('e2e_workspace_drop', {session_id: id}, resolve);
        }), id);
        expect(dropped.ok).toBe(true);
        const input = page.locator('#mobileInput');
        await input.fill('keep this prompt');
        await input.press('Enter');
        await expect(page.locator(`#terminal-${id} .session-overlay`)).toBeVisible();
        await expect(input).toHaveValue('keep this prompt');
        await page.evaluate(id => TerminalManager.terminals[id].input('extra input', true), id);
        expect((await inputs(page)).map(item => item.data)).toEqual(['keep this prompt\r']);
        const repeated = await page.evaluate(id => new Promise(resolve => {
            window.socket.emit('ssh_input', {session_id: id, data: 'duplicate event'}, resolve);
        }), id);
        expect(repeated).toMatchObject({success: false, code: 'ssh_session_unavailable'});
        await expect(page.locator('#notificationContainer .notification-warning')
            .filter({hasText: 'Reconnect to resume your work.'})).toHaveCount(1);
        console.info('Authenticated socket rejected stale input twice. One notice displayed and the draft remained.');
    } finally {
        await clearRestoredComposer(page);
    }
});

test('an interrupted SSH paste frame closes the terminal and keeps the draft', async ({page}) => {
    const id = await restoredComposer(page, {interruptInput: true});
    try {
        await page.evaluate(id => new Promise(resolve => {
            TerminalManager.terminals[id].write('\u001b[?2004h', resolve);
        }), id);
        const input = page.locator('#mobileInput');
        await input.fill('fixture prompt');
        await input.press('Enter');
        await expect(page.locator(`#terminal-${id} .session-overlay`)).toBeVisible();
        await expect(input).toHaveValue('fixture prompt');
        await page.evaluate(id => TerminalManager.terminals[id].input('extra input', true), id);
        expect((await inputs(page)).map(item => item.data)).toEqual(['\u001b[200~fixture prompt\u001b[201~\r']);
        console.info('One framed prompt saw a partial SSH write. The terminal retired with its draft intact.');
    } finally {
        await clearRestoredComposer(page);
    }
});

test('switching away and back cancels pending paste instead of retargeting', async ({page}) => {
    await setup(page);
    await connect(page, 'safe-two', 'beta.example');
    await page.evaluate(() => SessionManager.switchSession('safe-one'));
    await nativePaste(page, 'first\nsecond');
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await page.evaluate(() => {SessionManager.switchSession('safe-two'); SessionManager.switchSession('safe-one');});
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    expect(await inputs(page)).toEqual([]);
});

test('broadcast selects concrete recipients and never includes a newly opened session', async ({page}) => {
    await setup(page);
    await page.locator('#broadcastToggleBtn').click();
    await expect(page.locator('#broadcastRecipientDialog')).toBeVisible();
    await expect(page.locator('#broadcastRecipientList')).toContainText('ops@alpha.example:22');
    await page.locator('#broadcastRecipientList input').first().check();
    await page.locator('#broadcastRecipientApply').click();
    await connect(page, 'safe-two', 'beta.example');
    await page.locator('#broadcastInput').fill('whoami');
    await page.locator('#broadcastSendBtn').click();
    await expect.poll(async () => (await inputs(page)).length).toBe(1);
    expect(await inputs(page)).toEqual([expect.objectContaining({session_id: 'safe-one', data: 'whoami\r'})]);
    await page.evaluate(() => SessionManager.updateSessionStatus('safe-one', 'disconnected'));
    await expect(page.locator('#broadcastSendBtn')).toBeDisabled();
    await expect(page.locator('#broadcastSelectionStatus')).toContainText('changed');
});

test('palette clipboard paste is guarded and an outstanding read cannot follow a session switch', async ({page}) => {
    await setup(page);
    await connect(page, 'safe-two', 'beta.example');
    await page.evaluate(() => {
        SessionManager.switchSession('safe-one');
        Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
            readText: () => new Promise(resolve => {window.__resolveClipboard = resolve;})
        }});
    });
    await page.locator('#shellSearchBtn').click();
    await page.locator('#commandPaletteInput').fill('Paste Clipboard');
    await page.locator('[data-palette-id="paste-clipboard"]').click();
    await expect.poll(() => page.evaluate(() => typeof window.__resolveClipboard)).toBe('function');
    await page.evaluate(() => {
        SessionManager.switchSession('safe-two');
        SessionManager.switchSession('safe-one');
        window.__resolveClipboard('one\ntwo');
    });
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    expect(await inputs(page)).toEqual([]);
    await page.locator('#shellSearchBtn').click();
    await page.locator('#commandPaletteInput').fill('Paste Clipboard');
    await page.locator('[data-palette-id="paste-clipboard"]').click();
    await page.evaluate(() => window.__resolveClipboard('one\ntwo'));
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await page.locator('#terminalPasteConfirm').click();
    expect((await inputs(page)).map(item => item.data)).toEqual(['one\rtwo']);
});

test('disconnect cancels paste and cannot revive it after reconnect', async ({page}) => {
    await setup(page);
    await nativePaste(page, 'one\ntwo');
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await page.evaluate(() => SessionManager.updateSessionStatus('safe-one', 'disconnected'));
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    await page.evaluate(() => SessionManager.updateSessionStatus('safe-one', 'connected'));
    expect(await inputs(page)).toEqual([]);
});

test('mobile command-field paste previews original line breaks before browser sanitization', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await setup(page);
    await page.locator('#mobileCommandToggle').click();
    await nativePaste(page, 'one\ntwo\n', '#mobileInput');
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    expect(await inputs(page)).toEqual([]);
    await page.locator('#terminalPasteCancel').click();
    await nativePaste(page, 'one\ntwo\n', '#mobileInput');
    await page.locator('#terminalPasteTrim').check();
    await page.locator('#terminalPasteConfirm').click();
    expect((await inputs(page)).map(item => item.data)).toEqual(['one\rtwo']);
});

test('mobile paste can join a URL split by an embedded line break', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await setup(page);
    await page.locator('#mobileCommandToggle').click();
    const url = 'https://gitlab.com/group/project/-/pipelines/123';
    await nativePaste(page, url.replace('/123', '\n/123'), '#mobileInput');

    const dialog = page.locator('#terminalPasteDialog');
    const preview = dialog.locator('#terminalPastePreview');
    const removeLineBreaks = dialog.getByRole('checkbox', {name: 'Remove line breaks', exact: true});
    await expect(preview).toContainText('[LF]');
    await removeLineBreaks.check();
    await expect(preview).toHaveText(url);
    expect(await inputs(page)).toEqual([]);

    await dialog.getByRole('button', {name: 'Paste to this terminal'}).click();
    expect((await inputs(page)).map(item => item.data)).toEqual([url]);
});

for (const viewport of [{width:1440, height:960}, {width:390, height:844}]) {
    test(`terminal safety fits ${viewport.width}px with identical recipient endpoints`, async ({page}) => {
        await page.setViewportSize(viewport);
        await setup(page);
        await connect(page, 'safe-two', 'alpha.example');
        await page.evaluate(() => {SessionManager.switchSession('safe-one'); window.i18n.setLanguage('de');});
        await page.evaluate(() => BroadcastInput.show());
        const dialog = page.locator('#broadcastRecipientDialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('input[type=checkbox]')).toHaveCount(2);
        const labels = await dialog.locator('.terminal-recipient').allTextContents();
        expect(labels[0]).toContain('safe-one');
        expect(labels[1]).toContain('safe-two');
        const fs = require('node:fs');
        fs.mkdirSync('plans/terminal-controls', {recursive:true});
        await page.screenshot({path:`plans/terminal-controls/broadcast-${viewport.width}.png`, animations:'disabled'});
        let rect = await dialog.boundingBox();
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
        await page.locator('#broadcastRecipientCancel').click();
        await nativePaste(page, 'printf "Example output"\nwhoami\u001b[31m\n');
        await expect(page.locator('#terminalPasteDialog')).toBeVisible();
        await page.screenshot({path:`plans/terminal-controls/paste-${viewport.width}.png`, animations:'disabled'});
        rect = await page.locator('#terminalPasteDialog').boundingBox();
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press('Escape');
        await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
        expect(await inputs(page)).toEqual([]);
    });
}

async function selectBroadcastRecipients(page) {
    await page.locator('#broadcastToggleBtn').click();
    for (const checkbox of await page.locator('#broadcastRecipientList input').all()) await checkbox.check();
    await page.locator('#broadcastRecipientApply').click();
}

test('native multiline broadcast paste preserves its draft and reviews all recipients before send', async ({page}) => {
    await setup(page);
    await connect(page, 'safe-two', 'beta.example');
    await selectBroadcastRecipients(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('printf first\nprintf second\n'));
    await page.locator('#broadcastInput').focus();
    await page.keyboard.press('Control+v');
    await expect(page.locator('#broadcastInput')).toHaveValue('printf first\nprintf second\n');
    expect(await inputs(page)).toEqual([]);
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    await page.locator('#broadcastSendBtn').click();
    await expect(page.locator('#terminalPasteTitle')).toHaveText('Review broadcast input');
    await expect(page.locator('#terminalPasteTarget')).toContainText('ops@alpha.example:22');
    await expect(page.locator('#terminalPasteTarget')).toContainText('ops@beta.example:22');
    await expect(page.locator('#terminalPasteConfirm')).toHaveText('Send to selected');
    await page.locator('#terminalPasteCancel').click();
    await expect(page.locator('#broadcastInput')).toHaveValue('printf first\nprintf second\n');
    expect(await inputs(page)).toEqual([]);
    await page.locator('#broadcastSendBtn').click();
    await page.locator('#terminalPasteTrim').check();
    await page.locator('#terminalPasteConfirm').click();
    await expect.poll(async () => (await inputs(page)).length).toBe(2);
    expect(await inputs(page)).toEqual([
        expect.objectContaining({session_id:'safe-one', data:'printf first\rprintf second\r'}),
        expect.objectContaining({session_id:'safe-two', data:'printf first\rprintf second\r'}),
    ]);
    await expect(page.locator('#broadcastInput')).toHaveValue('');
});

test('broadcast control paste and recipient changes cancel without sending or clearing the draft', async ({page}) => {
    await setup(page);
    await connect(page, 'safe-two', 'beta.example');
    await selectBroadcastRecipients(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('printf test\u001b[31m'));
    await page.locator('#broadcastInput').focus();
    await page.keyboard.press('Control+v');
    await expect(page.locator('#broadcastInput')).toHaveValue('printf test\u001b[31m');
    await page.locator('#broadcastSendBtn').click();
    await expect(page.locator('#terminalPastePreview')).toContainText('[ESC]');
    await page.evaluate(() => BroadcastInput.selectRecipients(['safe-one']));
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    expect(await inputs(page)).toEqual([]);
    await expect(page.locator('#broadcastInput')).toHaveValue('printf test\u001b[31m');
    await page.locator('#broadcastSendBtn').click();
    await expect(page.locator('#terminalPasteDialog')).toBeVisible();
    await page.evaluate(() => {
        SessionManager.updateSessionStatus('safe-one', 'disconnected');
        SessionManager.updateSessionStatus('safe-one', 'connected');
    });
    await expect(page.locator('#terminalPasteDialog')).not.toBeVisible();
    expect(await inputs(page)).toEqual([]);
    await expect(page.locator('#broadcastInput')).toHaveValue('printf test\u001b[31m');
});

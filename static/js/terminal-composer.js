(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TerminalComposer = api;
}(typeof window === 'undefined' ? null : window, function () {
    'use strict';

    function createSubmit({input, sessions, connected, sendAttachment, pasteGuard, transport}) {
        let pending = false;

        return async function submit() {
            const sessionId = sessions.getActiveSession();
            if (pending || !sessionId || !connected() || !sessions.getSession(sessionId)?.connected) return;
            const submitted = input.value;
            pending = true;
            try {
                const attachment = sendAttachment(sessionId, submitted);
                if (!attachment && !submitted) {
                    await transport.send(sessionId, '\r');
                    return;
                }
                const terminal = sessions.getActiveTerminal();
                const sent = attachment ? await attachment : await pasteGuard.review(
                    pasteGuard.capture(sessionId, terminal), submitted,
                    value => transport.sendPrompt(sessionId, value, terminal)
                );
                if (sent && input.value === submitted && sessions.getActiveSession() === sessionId) {
                    input.value = '';
                }
            } finally {
                pending = false;
            }
        };
    }

    return {createSubmit};
}));

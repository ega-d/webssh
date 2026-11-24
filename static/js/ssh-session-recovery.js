(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SSHSessionRecovery = api;
}(typeof window === 'undefined' ? null : window, function () {
    'use strict';

    function create({sessions, cancelInput, disconnectFiles, notify, disconnectedMessage, unavailableMessage}) {
        function markDisconnected(sessionId) {
            cancelInput(sessionId);
            sessions.updateSessionStatus(sessionId, 'disconnected');
            disconnectFiles(sessionId);
        }

        function handleUnavailable(data) {
            const sessionId = data?.session_id;
            if (typeof sessionId !== 'string' || !sessionId) return false;
            if (data.code !== 'ssh_session_unavailable' &&
                data.error !== 'Session not found' &&
                data.error !== 'Session not connected' &&
                data.error !== 'Unauthorized access to session') return false;
            if (sessions.getSession(sessionId)?.connected) {
                markDisconnected(sessionId);
                notify(unavailableMessage());
            }
            return true;
        }

        function handleDisconnected(data) {
            if (sessions.getSession(data.session_id)?.connected) {
                notify(disconnectedMessage(data.reason));
            }
            markDisconnected(data.session_id);
        }

        return {handleUnavailable, handleDisconnected};
    }

    return {create};
}));

(() => {
  globalThis.Longform ||= {};
  const protocolVersion = 6;
  const runtimeVersion = '2026-10-28-managed-v1';
  if (Longform.protocol?.runtimeVersion === runtimeVersion) return;
  if (Longform.protocol?.runtimeVersion) {
    throw Object.assign(new Error('Reload required'), { code: 'reload-required' });
  }
  const commands = new Set(['START', 'SNAPSHOT', 'CANCEL', 'ARTIFACT_BEGIN',
    'ARTIFACT_CHUNK', 'CHUNK_ACK', 'ARTIFACT_END', 'COMMIT_DELIVERY', 'DELIVERY_RESULT']);
  const artifactCommands = new Set(['ARTIFACT_BEGIN', 'ARTIFACT_CHUNK', 'CHUNK_ACK', 'ARTIFACT_END']);
  const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

  /** Validate a v6 envelope before command handling; browser sender authentication is separate. */
  function validateEnvelope(message, scope = {}) {
    if (!message || typeof message !== 'object' || !commands.has(message.type)
        || message.protocolVersion !== protocolVersion || !token(message.requestId)) return false;
    const handshake = message.type === 'SNAPSHOT' && message.sessionId == null;
    const idleStart = message.type === 'START' && message.sessionId === null
      && scope.sessionId === null && token(scope.documentId);
    if (handshake) {
      if (message.documentId != null && !token(message.documentId)) return false;
    } else if (!token(message.documentId) || (!idleStart && !token(message.sessionId))) return false;
    if (scope.documentId && message.documentId != null && scope.documentId !== message.documentId) return false;
    if (!handshake && !idleStart && Object.hasOwn(scope, 'sessionId') && scope.sessionId !== message.sessionId) return false;
    if (artifactCommands.has(message.type) && (!token(message.transferId)
        || !Number.isSafeInteger(message.chunkIndex) || message.chunkIndex < 0)) return false;
    if (['COMMIT_DELIVERY', 'DELIVERY_RESULT'].includes(message.type) && !token(message.transferId)) return false;
    if (message.type === 'DELIVERY_RESULT' && !['success', 'failed', 'unknown'].includes(message.outcome)) return false;
    if (message.sequence !== undefined && (!Number.isSafeInteger(message.sequence) || message.sequence < 0)) return false;
    return true;
  }

  /** Per-connection replay/sequence fence. Reset only on an authenticated new handshake/session. */
  function createEnvelopeValidator(initialScope = {}) {
    let scope = { ...initialScope };
    let requests = new Set();
    let sequence = -1;
    return Object.freeze({
      accept(message) {
        if (!validateEnvelope(message, scope) || requests.has(message.requestId)
            || (message.sequence !== undefined && message.sequence <= sequence)) return false;
        // Bound the connection's replay ledger; reconnect rather than forget old IDs.
        if (requests.size >= 16384) return false;
        requests.add(message.requestId);
        if (message.sequence !== undefined) sequence = message.sequence;
        return true;
      },
      reset(nextScope = {}) { scope = { ...nextScope }; requests = new Set(); sequence = -1; },
    });
  }

  Longform.protocol = Object.freeze({
    protocolVersion,
    runtimeVersion,
    sessionPort: 'longform-session:v6',
    validateEnvelope,
    createEnvelopeValidator,
    viewportMessage: 'captureViewport',
    fullPageMessage: 'captureFullPage:v5',
    contentVersion: '2026-09-09-modular-v1',
    contentFiles: Object.freeze([
      'protocol.js',
      'capture-geometry.js',
      'capture-page.js',
      'clipboard.js',
      'capture.js',
      'content.js',
    ]),
  });
})();

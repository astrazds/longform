(() => {
  if ((globalThis.Longform && !globalThis.Longform.protocol?.runtimeVersion)
      || globalThis.window?.__longformContentScriptVersion) {
    throw Object.assign(new Error('Reload required'), { code: 'reload-required' });
  }
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
    limits: Object.freeze({
      workingMemoryBytes: 512 * 1024 * 1024,
      artifactBytes: 32 * 1024 * 1024,
      chunkBytes: 256 * 1024,
      externalMs: 10000,
      digestOverheadBytes: 16 * 1024 * 1024,
    }),
    brokerMessages: Object.freeze(['BROKER_HELLO', 'BROKER_RELEASE', 'CAPTURE_TILE', 'DIGEST_BEGIN', 'DIGEST_CHUNK', 'DIGEST_END']),
    validateEnvelope,
    createEnvelopeValidator,
    contentFiles: Object.freeze([
      'protocol.js',
      'capture-geometry.js',
      'capture-page.js',
      'capture-session.js',
      'capture-transfer.js',
      'capture.js',
      'content.js',
    ]),
  });
})();

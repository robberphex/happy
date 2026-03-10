import axios from 'axios';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import nacl from 'tweetnacl';

class HappyClient {
  constructor() {
    this.serverUrl = process.env.HAPPY_SERVER_URL || 'http://127.0.0.1:3005';
    /** @type {Map<string, Uint8Array>} */
    this.machineDataKeys = new Map();
    /** @type {Map<string, Uint8Array>} */
    this.sessionDataKeys = new Map();
  }

  /**
   * @param {Uint8Array} secret
   * @returns {AuthChallengeResult}
   */
  async authChallenge(secret) {
    const keypair = nacl.sign.keyPair.fromSeed(secret.slice(0, 32));
    const challenge = randomBytes(32);
    const signature = nacl.sign.detached(challenge, keypair.secretKey);
    return { challenge, signature, publicKey: keypair.publicKey };
  }

  /**
   * @param {Uint8Array} buffer
   * @param {"base64" | "base64url"} [encoding]
   * @returns {string}
   */
  encodeBase64(buffer, encoding = 'base64') {
    const base64 = Buffer.from(buffer).toString('base64');
    if (encoding === 'base64url') {
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    return base64;
  }

  /**
   * @param {string} value
   * @param {"base64" | "base64url"} [encoding]
   * @returns {Uint8Array}
   */
  decodeBase64(value, encoding = 'base64') {
    let normalized = value;
    if (encoding === 'base64url') {
      normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4;
      if (padding) {
        normalized += '='.repeat(4 - padding);
      }
    }
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }

  /**
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async getRandomBytesAsync(length = 32) {
    return new Promise((resolve, reject) => {
      randomBytes(length, (err, buf) => {
        if (err) reject(err);
        else resolve(new Uint8Array(buf));
      });
    });
  }

  /**
   * @param {Uint8Array} secret
   * @returns {Promise<string>}
   */
  async authGetToken(secret) {
    const { challenge, signature, publicKey } = await this.authChallenge(secret);
    const response = await axios.post(`${this.serverUrl}/v1/auth`, {
      challenge: this.encodeBase64(challenge),
      signature: this.encodeBase64(signature),
      publicKey: this.encodeBase64(publicKey)
    });
    const data = response.data;
    return data.token;
  }

  /**
   * Bundle format: ephemeralPublicKey(32) + nonce(24) + ciphertext
   * @param {Uint8Array} data
   * @param {Uint8Array} recipientPublicKey
   * @returns {Uint8Array}
   */
  encryptBox(data, recipientPublicKey) {
    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    if (!encrypted) {
      throw new Error('Failed to encrypt with nacl.box');
    }

    const result = new Uint8Array(
      ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length
    );
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
  }

  /**
   * App-side terminal auth approval logic:
   * 1. Query request status by terminal public key.
   * 2. If pending, submit encrypted response with Bearer token.
   *
   * @param {string} token
   * @param {Uint8Array} publicKey
   * @param {Uint8Array} answerV1
   * @param {Uint8Array} answerV2
   * @returns {Promise<{"not_found" | "authorized" | "approved"}>}
   */
  async authApprove(token, publicKey, answerV1, answerV2) {
    const publicKeyBase64 = this.encodeBase64(publicKey);
    const statusResponse = await axios.get(`${this.serverUrl}/v1/auth/request/status`, {
      params: { publicKey: publicKeyBase64 }
    });

    const { status, supportsV2 } = statusResponse.data;

    if (status === 'not_found') {
      return 'not_found';
    }

    if (status === 'authorized') {
      return 'authorized';
    }

    if (status === 'pending') {
      await axios.post(`${this.serverUrl}/v1/auth/response`, {
        publicKey: publicKeyBase64,
        response: this.encodeBase64(supportsV2 ? answerV2 : answerV1)
      }, {
        headers: {
          Authorization: `Bearer ${token}`,
        }
      });
      return 'approved';
    }

    throw new Error(`Unexpected auth request status: ${String(status)}`);
  }

  /**
   * Fetch active sessions for the current user.
   * @param {string} token
   * @param {{
   *   decryptEncryptionKey: (encryptedKey: string) => Promise<Uint8Array | null>;
   *   masterSecret: Uint8Array;
   * }} encryption
   * @returns {Promise<Array<any>>}
   */
  async fetchActiveSessions(token, encryption) {
    console.log('📊 HappyClient: Fetching active sessions...');

    try {
      const response = await axios.get(`${this.serverUrl}/v2/sessions/active`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      const sessions = data.sessions ?? (Array.isArray(data) ? data : []);
      console.log(`📊 HappyClient: Fetched ${sessions.length} active sessions from server`);

      return this.decryptSessions(sessions, encryption);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.error(`Failed to fetch active sessions: ${status ?? 'unknown error'}`);
      } else {
        console.error('Failed to fetch active sessions:', error);
      }
      return [];
    }
  }

  /**
   * Fetch sessions for the current user.
   *
   * If `encryption` is provided, this method also decrypts session data:
   * - decrypt session data encryption keys
   * - decrypt metadata/agentState
   *
   * @param {string} token
   * @param {{
   *   decryptEncryptionKey: (encryptedKey: string) => Promise<Uint8Array | null>;
   *   masterSecret: Uint8Array;
   * }} encryption
   * @returns {Promise<Array<any>>}
   */
  async fetchSessions(token, encryption) {
    console.log('📊 HappyClient: Fetching sessions...');

    try {
      const response = await axios.get(`${this.serverUrl}/v2/sessions`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      const sessions = data.sessions ?? (Array.isArray(data) ? data : []);
      console.log(`📊 HappyClient: Fetched ${sessions.length} sessions from server`);

      return this.decryptSessions(sessions, encryption);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.error(`Failed to fetch sessions: ${status ?? 'unknown error'}`);
      } else {
        console.error('Failed to fetch sessions:', error);
      }
      return [];
    }
  }

  /**
   * Fetch machine list for the current user.
   *
   * If `encryption` is provided, this method also mirrors app-side
   * decrypt flow in `sync.ts`:
   * - decrypt machine data keys
   * - initialize machine encryptions
   * - decrypt metadata/daemonState
   *
   * @param {string} token
   * @param {{
   *   decryptEncryptionKey: (encryptedKey: string) => Promise<Uint8Array | null>;
   *   initializeMachines: (keys: Map<string, Uint8Array | null>) => Promise<void>;
   *   getMachineEncryption: (machineId: string) => ({
   *     decryptMetadata: (version: number, encrypted: string) => Promise<any>;
   *     decryptDaemonState: (version: number, encrypted: string) => Promise<any>;
   *   } | null);
   * } | null} encryption
   * @returns {Promise<Array<any>>}
   */
  async fetchMachines(token, encryption) {
    console.log('📊 HappyClient: Fetching machines...');

    try {
      const response = await axios.get(`${this.serverUrl}/v1/machines`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      const machines = Array.isArray(data) ? data : [];
      console.log(`📊 HappyClient: Fetched ${machines.length} machines from server`);

      return this.#decryptMachines(machines, encryption);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.error(`Failed to fetch machines: ${status ?? 'unknown error'}`);
      } else {
        console.error('Failed to fetch machines:', error);
      }
      return [];
    }
  }

  /**
   * @param {Array<{
   *   id: string;
   *   metadata: string;
   *   metadataVersion: number;
   *   daemonState?: string | null;
   *   daemonStateVersion?: number;
   *   dataEncryptionKey?: string | null;
   *   seq: number;
   *   active: boolean;
   *   activeAt: number;
   *   createdAt: number;
   *   updatedAt: number;
   * }>} machines
   * @param {{
   *   decryptEncryptionKey: (encryptedKey: string) => Promise<Uint8Array | null>;
   *   initializeMachines: (keys: Map<string, Uint8Array | null>) => Promise<void>;
   *   getMachineEncryption: (machineId: string) => ({
   *     decryptMetadata: (version: number, encrypted: string) => Promise<any>;
   *     decryptDaemonState: (version: number, encrypted: string) => Promise<any>;
   *   } | null);
   * }} encryption
   * @returns {Promise<Array<{
   *   id: string;
   *   seq: number;
   *   createdAt: number;
   *   updatedAt: number;
   *   active: boolean;
   *   activeAt: number;
   *   metadata: any | null;
   *   metadataVersion: number;
   *   daemonState: any | null;
   *   daemonStateVersion: number;
   * }>>}
   */
  async #decryptMachines(machines, encryption) {
    const machineKeysMap = new Map();
    for (const machine of machines) {
      if (machine.dataEncryptionKey) {
        const decryptedKey = await encryption.decryptEncryptionKey(machine.dataEncryptionKey);
        if (!decryptedKey) {
          console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
          continue;
        }
        machineKeysMap.set(machine.id, decryptedKey);
        this.machineDataKeys.set(machine.id, decryptedKey);
      } else {
        machineKeysMap.set(machine.id, null);
      }
    }

    await encryption.initializeMachines(machineKeysMap);

    const decryptedMachines = [];
    for (const machine of machines) {
      const machineEncryption = encryption.getMachineEncryption(machine.id);
      if (!machineEncryption) {
        console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
        continue;
      }

      try {
        const metadata = machine.metadata
          ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
          : null;

        const daemonState = machine.daemonState
          ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
          : null;

        decryptedMachines.push({
          id: machine.id,
          seq: machine.seq,
          createdAt: machine.createdAt,
          updatedAt: machine.updatedAt,
          active: machine.active,
          activeAt: machine.activeAt,
          metadata,
          metadataVersion: machine.metadataVersion,
          daemonState,
          daemonStateVersion: machine.daemonStateVersion || 0
        });
      } catch (error) {
        console.error(`Failed to decrypt machine ${machine.id}:`, error);
        decryptedMachines.push({
          id: machine.id,
          seq: machine.seq,
          createdAt: machine.createdAt,
          updatedAt: machine.updatedAt,
          active: machine.active,
          activeAt: machine.activeAt,
          metadata: null,
          metadataVersion: machine.metadataVersion,
          daemonState: null,
          daemonStateVersion: 0
        });
      }
    }

    console.log(`🖥️ HappyClient: fetchMachines completed - processed ${decryptedMachines.length} machines`);
    return decryptedMachines;
  }

  /**
   * @param {Array<{
   *   id: string;
   *   metadata: string;
   *   metadataVersion: number;
   *   agentState?: string | null;
   *   agentStateVersion?: number;
   *   dataEncryptionKey?: string | null;
   *   seq: number;
   *   active: boolean;
   *   activeAt: number;
   *   createdAt: number;
   *   updatedAt: number;
   * }>} sessions
   * @param {{
   *   decryptEncryptionKey: (encryptedKey: string) => Promise<Uint8Array | null>;
   *   masterSecret: Uint8Array;
   * }} encryption
   * @returns {Promise<Array<{
   *   id: string;
   *   seq: number;
   *   createdAt: number;
   *   updatedAt: number;
   *   active: boolean;
   *   activeAt: number;
   *   metadata: any | null;
   *   metadataVersion: number;
   *   agentState: any | null;
   *   agentStateVersion: number;
   * }>>}
   */
  async decryptSessions(sessions, encryption) {
    const decryptedSessions = [];
    const masterSecret = encryption.masterSecret;
    for (const session of sessions) {
      try {
        let sessionKey = null;
        if (session.dataEncryptionKey) {
          sessionKey = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
          if (!sessionKey) {
            console.error(`Failed to decrypt session key for session ${session.id}`);
          }
        }
        if (sessionKey) {
          this.sessionDataKeys.set(session.id, sessionKey);
        }

        const metadata = session.metadata
          ? this.#decryptSessionData(session.metadata, sessionKey, masterSecret)
          : null;

        const agentState = session.agentState
          ? this.#decryptSessionData(session.agentState, sessionKey, masterSecret)
          : null;

        decryptedSessions.push({
          id: session.id,
          seq: session.seq,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          active: session.active,
          activeAt: session.activeAt,
          metadata,
          metadataVersion: session.metadataVersion,
          agentState,
          agentStateVersion: session.agentStateVersion || 0
        });
      } catch (error) {
        console.error(`Failed to decrypt session ${session.id}:`, error);
        decryptedSessions.push({
          id: session.id,
          seq: session.seq,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          active: session.active,
          activeAt: session.activeAt,
          metadata: null,
          metadataVersion: session.metadataVersion,
          agentState: null,
          agentStateVersion: 0
        });
      }
    }

    console.log(`🖥️ HappyClient: decryptSessions completed - processed ${decryptedSessions.length} sessions`);
    return decryptedSessions;
  }

  /**
   * @param {string} sessionId
   * @returns {Uint8Array | null}
   */
  getSessionDataKey(sessionId) {
    return this.sessionDataKeys.get(sessionId) || null;
  }

  /**
   * @param {string} sessionId
   * @param {{ masterSecret: Uint8Array }} encryption
   * @param {unknown} payload
   * @returns {string}
   */
  encryptSessionMessage(sessionId, encryption, payload) {
    const sessionDataKey = this.getSessionDataKey(sessionId);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = sessionDataKey
      ? this.#encryptWithDataKey(plaintext, sessionDataKey)
      : this.#encryptLegacy(plaintext, encryption.masterSecret);
    return this.encodeBase64(encrypted);
  }

  /**
   * @param {string} encryptedBase64
   * @param {Uint8Array | null} key
   * @param {Uint8Array} masterSecret
   * @returns {any | null}
   */
  #decryptSessionData(encryptedBase64, key, masterSecret) {
    if (!encryptedBase64) {
      return null;
    }
    try {
      const encrypted = new Uint8Array(Buffer.from(encryptedBase64, 'base64'));
      if (key) {
        return this.#decryptWithDataKey(encrypted, key);
      }
      return this.#decryptLegacy(encrypted, masterSecret);
    } catch (error) {
      console.error('Failed to decrypt session data:', error);
      return null;
    }
  }

  /**
   * AES-256-GCM payload:
   * version(1) + nonce(12) + ciphertext + tag(16)
   * @param {Uint8Array} bundle
   * @param {Uint8Array} dataKey
   * @returns {any | null}
   */
  #decryptWithDataKey(bundle, dataKey) {
    try {
      if (bundle.length < 1 + 12 + 16) {
        return null;
      }
      if (bundle[0] !== 0) {
        return null;
      }

      const nonce = bundle.slice(1, 13);
      const authTag = bundle.slice(bundle.length - 16);
      const ciphertext = bundle.slice(13, bundle.length - 16);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(dataKey),
        Buffer.from(nonce)
      );
      decipher.setAuthTag(Buffer.from(authTag));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext)),
        decipher.final(),
      ]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Legacy secretbox JSON payload:
   * nonce(24) + ciphertext
   * @param {Uint8Array} data
   * @param {Uint8Array} masterSecret
   * @returns {any | null}
   */
  #decryptLegacy(data, masterSecret) {
    try {
      const nacl = require('tweetnacl');
      const nonceLen = nacl.secretbox.nonceLength;
      if (data.length < nonceLen + nacl.secretbox.overheadLength) {
        return null;
      }

      const nonce = data.slice(0, nonceLen);
      const encrypted = data.slice(nonceLen);
      const secret = masterSecret || new Uint8Array(32);
      const decrypted = nacl.secretbox.open(encrypted, nonce, secret);
      if (!decrypted) {
        return null;
      }
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return null;
    }
  }

  /**
   * AES-256-GCM payload:
   * version(1) + nonce(12) + ciphertext + tag(16)
   * @param {Uint8Array} plaintext
   * @param {Uint8Array} dataKey
   * @returns {Uint8Array}
   */
  #encryptWithDataKey(plaintext, dataKey) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(dataKey), nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const bundle = new Uint8Array(1 + 12 + encrypted.length + 16);
    bundle[0] = 0;
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
  }

  /**
   * Legacy secretbox JSON payload:
   * nonce(24) + ciphertext
   * @param {Uint8Array} plaintext
   * @param {Uint8Array} masterSecret
   * @returns {Uint8Array}
   */
  #encryptLegacy(plaintext, masterSecret) {
    const nonce = randomBytes(nacl.secretbox.nonceLength);
    const encrypted = nacl.secretbox(plaintext, nonce, masterSecret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce, 0);
    result.set(encrypted, nonce.length);
    return result;
  }
}

export { HappyClient };

import axios from 'axios';
import { randomBytes } from 'crypto';
import nacl from 'tweetnacl';

class HappyClient {
  constructor() {
    this.serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
    /** @type {Map<string, Uint8Array>} */
    this.machineDataKeys = new Map();
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
   * } | null} [encryption]
   * @returns {Promise<Array<any>>}
   */
  async fetchMachines(token, encryption = null) {
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

      if (!encryption) {
        return machines;
      }

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
}

export { HappyClient };

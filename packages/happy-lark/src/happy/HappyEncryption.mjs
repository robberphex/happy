import { createDecipheriv, createHmac, createHash } from "crypto";
import nacl from "tweetnacl";

class HappyEncryption {
  /**
   * @param {Uint8Array} masterSecret
   * @param {Uint8Array} contentDataKey
   * @param {Uint8Array} contentPrivateKey
   */
  constructor(masterSecret, contentDataKey, contentPrivateKey) {
    this.masterSecret = masterSecret;
    this.contentDataKey = contentDataKey;
    this.contentPrivateKey = contentPrivateKey;
    /** @type {Map<string, { decryptMetadata: (version: number, encrypted: string) => Promise<any | null>; decryptDaemonState: (version: number, encrypted: string) => Promise<any | null>; }>} */
    this.machineEncryptions = new Map();
  }

  /**
   * @param {Uint8Array} masterSecret
   * @returns {Promise<HappyEncryption>}
   */
  static async create(masterSecret) {
    const contentDataKey = await deriveKey(masterSecret, "Happy EnCoder", ["content"]);
    const keypair = libsodiumCompatBoxKeyPairFromSeed(contentDataKey);
    return new HappyEncryption(masterSecret, keypair.publicKey, keypair.privateKey);
  }

  /**
   * @param {string} encryptedKey
   * @returns {Promise<Uint8Array | null>}
   */
  async decryptEncryptionKey(encryptedKey) {
    const raw = decodeBase64(encryptedKey);
    if (raw.length < 1 || raw[0] !== 0) {
      return null;
    }
    const boxed = raw.slice(1);
    const decrypted = decryptBox(boxed, this.contentPrivateKey);
    if (!decrypted) {
      return null;
    }
    return decrypted;
  }

  /**
   * @param {Map<string, Uint8Array | null>} keys
   * @returns {Promise<void>}
   */
  async initializeMachines(keys) {
    for (const [machineId, dataKey] of keys.entries()) {
      if (this.machineEncryptions.has(machineId)) {
        continue;
      }

      const hasDataKey = dataKey instanceof Uint8Array;
      const encryption = hasDataKey
        ? new AES256Encryption(dataKey)
        : new SecretBoxEncryption(this.masterSecret);

      this.machineEncryptions.set(machineId, {
        decryptMetadata: async (_version, encrypted) => {
          if (!encrypted) {
            return null;
          }
          return encryption.decryptMetadata(encrypted);
        },
        decryptDaemonState: async (_version, encrypted) => {
          if (!encrypted) {
            return null;
          }
          return encryption.decryptDaemonState(encrypted);
        }
      });
    }
  }

  /**
   * @param {string} machineId
   * @returns {{ decryptMetadata: (version: number, encrypted: string) => Promise<any | null>; decryptDaemonState: (version: number, encrypted: string) => Promise<any | null>; } | null}
   */
  getMachineEncryption(machineId) {
    return this.machineEncryptions.get(machineId) || null;
  }
}

class SecretBoxEncryption {
  /**
   * @param {Uint8Array} secretKey
   */
  constructor(secretKey) {
    this.secretKey = secretKey;
  }

  /**
   * @param {string} encryptedBase64
   * @returns {any | null}
   */
  decryptMetadata(encryptedBase64) {
    return decryptLegacy(decodeBase64(encryptedBase64), this.secretKey);
  }

  /**
   * @param {string} encryptedBase64
   * @returns {any | null}
   */
  decryptDaemonState(encryptedBase64) {
    if (!encryptedBase64) {
      return null;
    }
    return decryptLegacy(decodeBase64(encryptedBase64), this.secretKey);
  }
}

class AES256Encryption {
  /**
   * @param {Uint8Array} secretKey
   */
  constructor(secretKey) {
    this.secretKey = secretKey;
    this.secretKeyB64 = Buffer.from(secretKey).toString("base64");
  }

  /**
   * @param {string} encryptedBase64
   * @returns {any | null}
   */
  decryptMetadata(encryptedBase64) {
    return decryptWithDataKey(decodeBase64(encryptedBase64), this.secretKey);
  }

  /**
   * @param {string} encryptedBase64
   * @returns {any | null}
   */
  decryptDaemonState(encryptedBase64) {
    if (!encryptedBase64) {
      return null;
    }
    return decryptWithDataKey(decodeBase64(encryptedBase64), this.secretKey);
  }
}

/**
 * @param {Uint8Array} master
 * @param {string} usage
 * @param {string[]} path
 * @returns {Promise<Uint8Array>}
 */
async function deriveKey(master, usage, path) {
  let state = await deriveSecretKeyTreeRoot(master, usage);
  for (const index of path) {
    state = await deriveSecretKeyTreeChild(state.chainCode, index);
  }
  return state.key;
}

/**
 * @param {Uint8Array} seed
 * @param {string} usage
 * @returns {Promise<{ key: Uint8Array; chainCode: Uint8Array }>}
 */
async function deriveSecretKeyTreeRoot(seed, usage) {
  const i = hmacSha512(new TextEncoder().encode(usage + " Master Seed"), seed);
  return {
    key: i.slice(0, 32),
    chainCode: i.slice(32)
  };
}

/**
 * @param {Uint8Array} chainCode
 * @param {string} index
 * @returns {Promise<{ key: Uint8Array; chainCode: Uint8Array }>}
 */
async function deriveSecretKeyTreeChild(chainCode, index) {
  const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
  const i = hmacSha512(chainCode, data);
  return {
    key: i.slice(0, 32),
    chainCode: i.slice(32)
  };
}

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function hmacSha512(key, data) {
  return new Uint8Array(
    createHmac("sha512", Buffer.from(key)).update(Buffer.from(data)).digest()
  );
}

/**
 * Matches libsodium seed-keypair behavior used by happy-app.
 * @param {Uint8Array} seed
 * @returns {{ privateKey: Uint8Array; publicKey: Uint8Array }}
 */
function libsodiumCompatBoxKeyPairFromSeed(seed) {
  const privateKey = new Uint8Array(seed);
  const publicKey = nacl.box.keyPair.fromSecretKey(privateKey).publicKey;
  return { privateKey, publicKey };
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function decodeBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Bundle format: ephemeralPublicKey(32) + nonce(24) + ciphertext
 * @param {Uint8Array} encryptedBundle
 * @param {Uint8Array} recipientSecretKey
 * @returns {Uint8Array | null}
 */
function decryptBox(encryptedBundle, recipientSecretKey) {
  const publicKeyLen = nacl.box.publicKeyLength;
  const nonceLen = nacl.box.nonceLength;
  if (
    encryptedBundle.length <
    publicKeyLen + nonceLen + nacl.box.overheadLength
  ) {
    return null;
  }

  const ephemeralPublicKey = encryptedBundle.slice(0, publicKeyLen);
  const nonce = encryptedBundle.slice(publicKeyLen, publicKeyLen + nonceLen);
  const encrypted = encryptedBundle.slice(publicKeyLen + nonceLen);
  return nacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
}

/**
 * Legacy secretbox JSON payload:
 * nonce(24) + ciphertext
 * @param {Uint8Array} data
 * @param {Uint8Array} secret
 * @returns {any | null}
 */
function decryptLegacy(data, secret) {
  try {
    const nonceLen = nacl.secretbox.nonceLength;
    if (data.length < nonceLen + nacl.secretbox.overheadLength) {
      return null;
    }

    const nonce = data.slice(0, nonceLen);
    const encrypted = data.slice(nonceLen);
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
 * @param {Uint8Array} bundle
 * @param {Uint8Array} dataKey
 * @returns {any | null}
 */
function decryptWithDataKey(bundle, dataKey) {
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
      "aes-256-gcm",
      Buffer.from(dataKey),
      Buffer.from(nonce)
    );
    decipher.setAuthTag(Buffer.from(authTag));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

export { HappyEncryption };

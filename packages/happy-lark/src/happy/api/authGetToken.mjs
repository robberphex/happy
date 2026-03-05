import axios from 'axios';
import { randomBytes } from 'crypto';

/**
 * @typedef {Object} AuthChallengeResult
 * @property {Uint8Array} challenge
 * @property {Uint8Array} signature
 * @property {Uint8Array} publicKey
 */

/**
 * @param {Uint8Array} secret
 * @returns {AuthChallengeResult}
 */
function authChallenge(secret) {
  const keypair = crypto.sign.keypair(secret, { namedCurve: 'ed25519' });
  const challenge = randomBytes(32);
  const signature = crypto.sign.detached(challenge, keypair.privateKey);
  return { challenge, signature, publicKey: keypair.publicKey };
}

/**
 * @param {Uint8Array} buffer
 * @returns {string}
 */
function encodeBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/**
 * @returns {string}
 */
function getServerUrl() {
  return process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
}

/**
 * @param {Uint8Array} secret
 * @returns {Promise<string>}
 */
export async function authGetToken(secret) {
  const API_ENDPOINT = getServerUrl();
  const { challenge, signature, publicKey } = authChallenge(secret);
  const response = await axios.post(`${API_ENDPOINT}/v1/auth`, {
    challenge: encodeBase64(challenge),
    signature: encodeBase64(signature),
    publicKey: encodeBase64(publicKey)
  });
  const data = response.data;
  return data.token;
}

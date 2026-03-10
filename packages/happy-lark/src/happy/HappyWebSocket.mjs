import { createDecipheriv } from 'crypto';
import nacl from 'tweetnacl';
import { io } from 'socket.io-client';

class HappyWebSocket {
    #socket = null;
    #serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
    #token = null;
    #encryption = null;
    #getSessionDataKey = null;
    #onAgentMessage = null;

    connect(token, encryption, options = {}) {
        if (this.#socket) {
            console.log('🔌 HappyWebSocket: Already connected');
            return;
        }

        this.#token = token;
        this.#encryption = encryption;
        this.#getSessionDataKey = options.getSessionDataKey || null;
        this.#onAgentMessage = options.onAgentMessage || null;

        console.log('🔌 HappyWebSocket: Connecting to', this.#serverUrl);

        this.#socket = io(this.#serverUrl, {
            path: '/v1/updates',
            auth: {
                token: this.#token,
                clientType: 'user-scoped'
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.#socket.on('connect', () => {
            console.log('🔌 HappyWebSocket: Connected, socket ID:', this.#socket?.id);
        });

        this.#socket.on('disconnect', (reason) => {
            console.log('🔌 HappyWebSocket: Disconnected:', reason);
        });

        this.#socket.on('connect_error', (error) => {
            console.error('🔌 HappyWebSocket: Connection error:', error.message);
        });

        this.#socket.on('error', (error) => {
            console.error('🔌 HappyWebSocket: Error:', error);
        });

        this.#socket.on('update', async (data) => {
            this.#handleUpdate(data);
        });

        // this.#socket.onAny((event, data) => {
        //     console.log('🔌 HappyWebSocket: Received event:', event, JSON.stringify(data, null, 2));
        // });
    }

    disconnect() {
        if (this.#socket) {
            this.#socket.disconnect();
            this.#socket = null;
            console.log('🔌 HappyWebSocket: Disconnected');
        }
    }

    isConnected() {
        return this.#socket?.connected ?? false;
    }

    /**
     * @param {string} sessionId
     * @param {string} encryptedMessage
     * @param {string | null} [localId]
     * @returns {boolean}
     */
    sendMessage(sessionId, encryptedMessage, localId = null) {
        if (!this.#socket) {
            return false;
        }

        this.#socket.emit('message', {
            sid: sessionId,
            message: encryptedMessage,
            localId: typeof localId === 'string' ? localId : null,
        });
        return true;
    }

    #handleUpdate(data) {
        try {
            const body = data?.body;
            if (!body) {
                console.log('🔌 HappyWebSocket: Received update with no body:', data);
                return;
            }

            if (body.t === 'new-message') {
                this.#logDecryptedMessage(body);
            } else {
                console.log('🔌 HappyWebSocket: ===== Received update =====');
                console.log('🔌 HappyWebSocket: Type:', body.t);
                console.log('🔌 HappyWebSocket: Full payload:', JSON.stringify(body, null, 2));
                console.log('🔌 HappyWebSocket: ============================');
            }
        } catch (error) {
            console.error('🔌 HappyWebSocket: Error handling update:', error);
        }
    }

    #logDecryptedMessage(body) {
        try {
            const sessionId = body?.sid;
            const encrypted = body?.message?.content;
            if (!sessionId || encrypted?.t !== 'encrypted' || !encrypted?.c) {
                return;
            }

            const sessionKey = this.#getSessionDataKey ? this.#getSessionDataKey(sessionId) : null;
            const decrypted = this.#decryptSessionData(encrypted.c, sessionKey, this.#encryption?.masterSecret);
            if (!decrypted) {
                console.warn(`🔓 HappyWebSocket: Failed to decrypt message ${body?.message?.id} in session ${sessionId}`);
                return;
            }

            const messageData = {
                sessionId,
                messageId: body?.message?.id,
                localId: body?.message?.localId,
                createdAt: body?.message?.createdAt,
                content: decrypted
            };

            console.log('🔓 HappyWebSocket: Decrypted new-message:', JSON.stringify(messageData, null, 2));

            if (this.#onAgentMessage && decrypted?.role === 'session' && decrypted?.content?.ev) {
                this.#onAgentMessage({
                    sessionId,
                    messageId: body?.message?.id,
                    localId: body?.message?.localId,
                    createdAt: body?.message?.createdAt,
                    turn: decrypted.content.turn,
                    event: decrypted.content.ev,
                    meta: decrypted.content.meta,
                });
            }
        } catch (error) {
            console.error('🔓 HappyWebSocket: Error decrypting message:', error);
        }
    }

    #decryptSessionData(encryptedBase64, dataKey, masterSecret) {
        if (!encryptedBase64) {
            return null;
        }
        try {
            const encrypted = new Uint8Array(Buffer.from(encryptedBase64, 'base64'));
            if (dataKey) {
                return this.#decryptWithDataKey(encrypted, dataKey);
            }
            return this.#decryptLegacy(encrypted, masterSecret);
        } catch {
            return null;
        }
    }

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
                decipher.final()
            ]);
            return JSON.parse(decrypted.toString('utf8'));
        } catch {
            return null;
        }
    }

    #decryptLegacy(data, masterSecret) {
        try {
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
}

export { HappyWebSocket };

import { AuthCacheModel, ensureDatabaseReady } from "../db/sequelize.mjs";

export class AuthCacheService {
  /**
   * @param {string} senderId
   * @returns {{ secret: Uint8Array; token: string } | null}
   */
  async get(senderId) {
    await ensureDatabaseReady();
    const authCache = await AuthCacheModel.findByPk(senderId);
    if (!authCache) {
      return null;
    }
    return {
      secret: new Uint8Array(Buffer.from(authCache.secret, "base64")),
      token: authCache.token,
    };
  }

  /**
   * @returns {Promise<Array<{ senderId: string; secret: Uint8Array; token: string }>>}
   */
  async getAll() {
    await ensureDatabaseReady();
    const authCaches = await AuthCacheModel.findAll();
    return authCaches.map((authCache) => ({
      senderId: authCache.senderId,
      secret: new Uint8Array(Buffer.from(authCache.secret, "base64")),
      token: authCache.token,
    }));
  }

  /**
   * @param {string} senderId
   * @param {{ secret: Uint8Array; token: string }} authData
   */
  async set(senderId, authData) {
    await ensureDatabaseReady();
    await AuthCacheModel.upsert({
      senderId,
      secret: Buffer.from(authData.secret).toString("base64"),
      token: authData.token,
    });
  }
}
